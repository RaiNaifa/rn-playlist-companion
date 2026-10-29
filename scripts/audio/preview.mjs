import { MODULE_ID, t } from "../core/context.mjs";
import { readBounds } from "./bounds.mjs";

const VOLUME_SETTING = "previewVolume";
const DUCK_SETTING = "duckMusic";
const DUCK_STRENGTH_SETTING = "duckStrength";
const DEFAULT_DUCK_STRENGTH = 75;

let context;
let sound;
let fadingSound;
let previewDocument;
let previewUuid = null;
let fadeDuration = 0;
let generation = 0;
const listeners = new Set();

export function registerPreviewSettings() {
  game.settings.register(MODULE_ID, VOLUME_SETTING, {
    scope: "client",
    config: false,
    type: Number,
    default: 0.5,
    onChange: applyPreviewVolume,
  });
  game.settings.register(MODULE_ID, DUCK_SETTING, {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: applyDucking,
  });
  game.settings.register(MODULE_ID, DUCK_STRENGTH_SETTING, {
    name: "RNPLAYCOMP.Settings.DuckStrength.Name",
    hint: "RNPLAYCOMP.Settings.DuckStrength.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 100, step: 5 },
    default: DEFAULT_DUCK_STRENGTH,
    onChange: applyDucking,
  });
  for (const hook of ["globalPlaylistVolumeChanged", "globalAmbientVolumeChanged", "globalInterfaceVolumeChanged"])
    Hooks.on(hook, () => queueMicrotask(applyDucking));
  Hooks.on("updatePlaylist", (playlist, changes) => stopPreviewForPlayback(playlist.id, changes.sounds));
  Hooks.on("updatePlaylistSound", (playlistSound, changes) => {
    if (changes.playing === true) {
      stopPreviewForPlayback(playlistSound.parent?.id, [{ _id: playlistSound.id, playing: true }]);
    }
  });
  globalThis.addEventListener("beforeunload", stopPreview);
}

export function previewVolume() {
  return game.settings.get(MODULE_ID, VOLUME_SETTING);
}

export function duckMusic() {
  return game.settings.get(MODULE_ID, DUCK_SETTING);
}

export function duckStrength() {
  const setting = Number(game.settings.get(MODULE_ID, DUCK_STRENGTH_SETTING));
  return Number.isFinite(setting) ? Math.max(0, Math.min(100, setting)) : DEFAULT_DUCK_STRENGTH;
}

export function activePreview() {
  return previewUuid;
}

export function stopPreviewForPlayback(playlistId, sounds) {
  if (!previewDocument || previewDocument.parent?.id !== playlistId) return;
  if (sounds?.some((entry) => (entry._id ?? entry.id) === previewDocument.id && entry.playing === true)) stopPreview();
}

export function previewPlaylistSound() {
  return previewDocument;
}

export function previewSound() {
  return sound;
}

export async function togglePreviewPause() {
  if (!sound) return;
  if (sound.playing) {
    sound.pause();
  } else if (sound.pausedTime !== undefined) {
    await sound.play();
    scheduleEndFade(sound);
  }
  applyDucking();
  notify();
}

function scheduleEndFade(currentSound) {
  if (!fadeDuration || !Number.isFinite(currentSound.duration)) return;
  const end = readBounds(previewDocument, currentSound.duration)?.end ?? currentSound.duration;
  const startAfter = Math.max(0, end - currentSound.currentTime - fadeDuration / 1000);
  currentSound.schedule(() => currentSound.fade(0, { duration: fadeDuration }), currentSound.currentTime + startAfter);
}

export function onPreviewChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener(previewUuid);
}

// A separate audio context gives local preview its own volume, apart from Foundry's regular channels.
function previewContext() {
  context ??= new AudioContext();
  if (!context.gainNode) {
    context.gainNode = context.createGain();
    context.gainNode.connect(context.destination);
  }
  applyPreviewVolume();
  return context;
}

export function applyPreviewVolume() {
  if (!context) return;
  const volume = Math.max(0, Math.min(1, previewVolume()));
  context.gainNode.gain.setValueAtTime(volume, context.currentTime);
}

export function applyDucking() {
  const previewAudible = sound?.playing || fadingSound?.playing;
  const factor = previewAudible && duckMusic() ? 1 - duckStrength() / 100 : 1;
  for (const [channel, setting] of [
    [game.audio.music, "globalPlaylistVolume"],
    [game.audio.environment, "globalAmbientVolume"],
    [game.audio.interface, "globalInterfaceVolume"],
  ]) {
    if (!channel?.gainNode) continue;
    const normal = game.audio.globalMute ? 0 : game.settings.get("core", setting);
    channel.gainNode.gain.setValueAtTime(normal * factor, channel.currentTime);
  }
}

export function stopPreview({ fade = false } = {}) {
  generation += 1;
  const previous = sound;
  const oldFade = fadeDuration;
  if (fadingSound) Promise.resolve(fadingSound.stop({ fade: 0 })).catch(console.error);
  fadingSound = null;
  sound = null;
  previewDocument = null;
  previewUuid = null;
  fadeDuration = 0;
  if (previous) {
    const shouldFade = fade && previous.playing && oldFade > 0;
    if (shouldFade) fadingSound = previous;
    const stopping = shouldFade
      ? Promise.resolve(previous.fade(0, { duration: oldFade })).then(() => previous.stop({ fade: 0 }))
      : Promise.resolve(previous.stop({ fade: 0 }));
    stopping.catch(console.error).finally(() => {
      if (fadingSound === previous) {
        fadingSound = null;
        applyDucking();
      }
    });
  }
  applyDucking();
  notify();
}

export async function togglePreview(nextSound) {
  if (previewUuid === nextSound.uuid) {
    stopPreview({ fade: true });
    return;
  }
  stopPreview();
  // Audio unlock and loading can finish after another preview is selected. Only the latest request may play.
  const request = generation;
  previewDocument = nextSound;
  previewUuid = nextSound.uuid;
  notify();
  try {
    if (!nextSound.path) throw new Error(t("Errors.PreviewMissingPath"));
    await game.audio.unlock;
    if (request !== generation) return;
    const audioContext = previewContext();
    await audioContext.resume();
    if (request !== generation) return;
    const next = game.audio.create({ src: nextSound.path, context: audioContext, singleton: false });
    sound = next;
    const conclude = () => {
      if (sound === next) stopPreview();
    };
    next.addEventListener("end", conclude);
    next.addEventListener("stop", conclude);
    await next.load();
    if (request !== generation) return;
    const configuredFade = nextSound.fade ?? nextSound.parent?.fade ?? 0;
    const bounds = readBounds(nextSound, next.duration);
    fadeDuration = Number.isFinite(next.duration)
      ? Math.min(configuredFade, Math.ceil((bounds ? bounds.end - bounds.start : next.duration) / 2) * 1000)
      : configuredFade;
    await next.play({
      loop: false,
      volume: nextSound.volume ?? 1,
      fade: fadeDuration,
      offset: bounds?.start,
      duration: bounds && next.buffer ? bounds.end - bounds.start : undefined,
    });
    if (request !== generation) {
      await next.stop();
      return;
    }
    scheduleEndFade(next);
    if (bounds && next.element) {
      const endPreview = () => {
        if (next.element?.currentTime >= bounds.end && sound === next) stopPreview();
      };
      next.element.addEventListener("timeupdate", endPreview);
      const interval = setInterval(endPreview, 25);
      next.addEventListener("stop", () => clearInterval(interval), { once: true });
    }
    applyDucking();
    notify();
  } catch (error) {
    if (request === generation) {
      stopPreview();
      ui.notifications.error(t("Errors.PreviewFailed", { reason: error.message }));
    }
  }
}
