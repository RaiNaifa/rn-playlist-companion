import { publish } from "../core/context.mjs";
import { resetBoundedSeek } from "./bounded-playback.mjs";
import { readBounds } from "./bounds.mjs";

const queuedSeeks = new WeakMap();

export function seekRange(document, audio) {
  const duration = audio?.buffer?.duration ?? audio?.element?.duration ?? audio?.duration;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const bounds = readBounds(document, duration);
  const start = bounds?.start ?? 0;
  const end = bounds?.end ?? duration;
  // Leave up to 100 ms before the end so seeking to the right edge does not finish the sound immediately.
  return { start, end, maximum: Math.max(start, end - Math.min(0.1, (end - start) / 2)) };
}

export function clampSeek(document, audio, seconds) {
  const range = seekRange(document, audio);
  return range && Number.isFinite(seconds) ? Math.max(range.start, Math.min(range.maximum, seconds)) : null;
}

export async function applySeek(document, seconds) {
  if (!document || (!document.playing && document.pausedTime == null)) return false;
  const audio = document.sound;
  const target = clampSeek(document, audio, seconds);
  if (target == null) return false;
  if (!document.playing) {
    // Keep the document paused. Foundry uses pausedTime as the next play offset.
    await document.update({ pausedTime: target });
    globalThis.Hooks?.callAll("rnPlaylistCompanionSeek", document);
    return true;
  }
  if (!audio?.playing) return false;
  if (audio.element) {
    audio.element.currentTime = target;
    // Foundry derives currentTime from startTime, so keep its clock aligned with the media element.
    audio.startTime = audio.context.currentTime - target;
    audio.volume = document.volume;
    resetBoundedSeek(audio);
  } else if (audio.buffer) {
    // Pause retains the loaded buffer. Play starts from pausedTime without creating another Sound.
    audio.pause();
    audio.pausedTime = target;
    if (!document.playing || document.sound !== audio) return false;
    await audio.play({ offset: 0, volume: document.volume, loop: audio.loop });
  } else return false;
  document._scheduleFadeOut?.();
  globalThis.Hooks?.callAll("rnPlaylistCompanionSeek", document);
  return true;
}

function enqueueSeek(document, seconds, broadcast) {
  const target = clampSeek(document, document.sound, seconds);
  if (target == null) return Promise.resolve(false);
  let queue = queuedSeeks.get(document);
  if (!queue) {
    queue = { latest: null, version: 0, running: null };
    queuedSeeks.set(document, queue);
  }
  queue.latest = { target, broadcast };
  queue.version += 1;
  if (queue.running) return queue.running;
  queue.running = (async () => {
    let success = false;
    try {
      while (queue.latest) {
        const request = queue.latest;
        const version = queue.version;
        queue.latest = null;
        success = await applySeek(document, request.target);
        // An older in-flight seek must not broadcast after a newer target has replaced it.
        if (version === queue.version && success && request.broadcast && document.playing) {
          publish("seek", { playlistId: document.parent.id, soundId: document.id, seconds: request.target });
        }
      }
      return success;
    } finally {
      queue.running = null;
    }
  })();
  return queue.running;
}

export function requestSeek(document, seconds) {
  if (!document?.parent?.isOwner) return Promise.resolve(false);
  return enqueueSeek(document, seconds, true);
}

export async function receiveSeek(message) {
  if (message?.type !== "seek" || !Number.isFinite(message.payload?.seconds)) return;
  const document = game.playlists.get(message.payload.playlistId)?.sounds.get(message.payload.soundId);
  if (!document?.playing) return;
  await enqueueSeek(document, message.payload.seconds, false);
}
