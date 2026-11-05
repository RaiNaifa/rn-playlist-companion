import { MODULE_ID } from "../core/context.mjs";
import { readBounds } from "./bounds.mjs";
import { configuredFade, crossfadeEnabled } from "./crossfade-settings.mjs";
import { queueState } from "./queue.mjs";
import { isRandomPlayback } from "./random-playback.mjs";
import { repeatCycle } from "./repeat-cycle.mjs";
import { pendingSilence, repeatRange, transitionRange } from "./silence-data.mjs";

const fading = new Map();
const advanced = new WeakSet();
// A preloaded repeat copy belongs to one Sound instance.
const repeatReady = new WeakMap();
const repeatTails = new WeakMap();
const pendingRepeats = new WeakMap();
const activeRepeatDocuments = new Set();
const consumedTransitions = new WeakMap();
const deferredStarts = new WeakMap();
const startingFades = new WeakMap();
const activeStarts = new WeakMap();
const outgoingSounds = new WeakMap();

function audibleOrStopping(audio) {
  if (!audio) return false;
  const stopping = audio.constructor?.STATES?.STOPPING;
  // Foundry marks a Sound as not playing before its fade and stop event finish.
  return Boolean(audio.playing || (stopping !== undefined && audio._state === stopping));
}

function waitForStop(audio, timeoutMs) {
  if (!audibleOrStopping(audio)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      audio.removeEventListener?.("stop", finish);
      audio.removeEventListener?.("end", finish);
      resolve();
    };
    audio.addEventListener?.("stop", finish, { once: true });
    audio.addEventListener?.("end", finish, { once: true });
    timer = setTimeout(
      () => {
        if (!audibleOrStopping(audio)) return finish();
        Promise.resolve(audio.stop({ fade: 0 }))
          .catch(console.error)
          .finally(finish);
      },
      Math.max(0, Number(timeoutMs) || 0) + 1000,
    );
  });
}

function deferUntilStopped(document, originalSync, args) {
  if (crossfadeEnabled() || !document.playing || document.sound?.playing) return false;
  const outgoing = [...document.parent.sounds].filter(
    (other) => other !== document && !other.playing && audibleOrStopping(other.sound),
  );
  if (!outgoing.length) return false;
  if (deferredStarts.has(document)) return true;
  // Keep the pending track visible in Foundry's Currently Playing widget.
  document.sound ||= document._createSound();
  const request = Symbol("deferred start");
  deferredStarts.set(document, request);
  Promise.all(outgoing.map((other) => waitForStop(other.sound, other.fadeDuration))).then(() => {
    if (deferredStarts.get(document) !== request) return;
    deferredStarts.delete(document);
    // Finish the original request even if the setting changed while we waited.
    if (document.playing) originalSync.apply(document, args);
  });
  return true;
}

export function cancelActiveCrossfades() {
  for (const [id, active] of fading) {
    clearTimeout(active.timer);
    fading.delete(id);
    active.audio.stop({ fade: 0 }).catch(console.error);
  }
  for (const document of activeRepeatDocuments) {
    const pending = pendingRepeats.get(document);
    const tail = repeatTails.get(document);
    if (pending) pending.stop({ fade: 0 }).catch(console.error);
    if (tail) {
      clearTimeout(tail.timer);
      tail.audio.stop({ fade: 0 }).catch(console.error);
    }
    pendingRepeats.delete(document);
    repeatTails.delete(document);
    activeRepeatDocuments.delete(document);
  }
}

function cancelOlder(playlistId, except = null) {
  for (const [id, active] of fading) {
    if (!id.startsWith(`${playlistId}:`) || id === except) continue;
    clearTimeout(active.timer);
    fading.delete(id);
    active.audio.stop({ fade: 0 }).catch(console.error);
  }
}

function prepareRepeat(document, audio) {
  if (!crossfadeEnabled() || !document.repeat || !configuredFade(document) || repeatRange(document)?.max > 0) return;
  if (repeatReady.has(audio)) return;
  const cycle = repeatCycle(audio);
  // A failed preload skips only this pass through the track.
  if (cycle.failed === cycle.number) return;
  const cycleNumber = cycle.number;
  const next = document._createSound();
  if (!next) return;
  const ready = next
    .load()
    .then(() => next)
    .catch((cause) => {
      console.error(cause);
      cycle.failed = cycleNumber;
      repeatReady.delete(audio);
      return null;
    });
  repeatReady.set(audio, { next, ready, loaded: false });
  ready.then((loaded) => {
    const state = repeatReady.get(audio);
    if (state) state.loaded = Boolean(loaded);
  });
}

function crossfadeRepeat(document, audio, fade, bounds) {
  const state = repeatReady.get(audio);
  if (!state?.loaded || document.sound !== audio) return;
  const cycle = repeatCycle(audio);
  const cycleNumber = cycle.number;
  advanced.add(audio);
  const next = state.next;
  // Replace the document's Sound before starting the next copy so sync follows it.
  pendingRepeats.set(document, audio);
  activeRepeatDocuments.add(document);
  document.sound = next;
  startingFades.set(document, fade);
  next
    .play({ volume: document.volume, fade, offset: bounds?.start })
    .then(() => {
      pendingRepeats.delete(document);
      if (document.sound !== next || !document.playing) {
        activeRepeatDocuments.delete(document);
        next.stop({ fade: 0 }).catch(console.error);
        audio.stop({ fade: 0 }).catch(console.error);
        return;
      }
      audio.loop = false;
      audio.fade(0, { duration: fade }).catch(console.error);
      const timer = setTimeout(() => {
        audio
          .stop({ fade: 0 })
          .catch(console.error)
          .finally(() => {
            if (repeatTails.get(document)?.audio === audio) {
              repeatTails.delete(document);
              activeRepeatDocuments.delete(document);
            }
          });
      }, fade);
      repeatTails.set(document, { audio, timer });
    })
    .catch((cause) => {
      // Restore the original copy and let Foundry handle this repeat normally.
      pendingRepeats.delete(document);
      activeRepeatDocuments.delete(document);
      advanced.delete(audio);
      if (document.sound === next) document.sound = audio;
      startingFades.delete(document);
      activeStarts.delete(document);
      repeatReady.delete(audio);
      cycle.failed = cycleNumber;
      next.stop({ fade: 0 }).catch(console.error);
      console.error(cause);
    });
}

function advanceRepeat() {
  if (!crossfadeEnabled()) return;
  for (const playlist of game.playlists) {
    for (const document of playlist.sounds) {
      const audio = document.sound;
      if (!document.playing || !document.repeat || !audio?.playing || repeatRange(document)?.max > 0) continue;
      const bounds = readBounds(document, audio.duration);
      const end = bounds?.end ?? audio.duration;
      const position = audio.currentTime;
      const fade = Math.min(configuredFade(document), (end - (bounds?.start ?? 0)) * 500);
      if (!Number.isFinite(end) || !Number.isFinite(position) || fade <= 0) continue;
      const cycle = repeatCycle(audio);
      // A backward jump from a natural loop starts a new retry opportunity.
      if (cycle.position !== null && position < cycle.position) cycle.number++;
      cycle.position = position;
      if (advanced.has(audio)) continue;
      prepareRepeat(document, audio);
      const remaining = end - position;
      if (remaining > 0 && remaining <= fade / 1000) crossfadeRepeat(document, audio, fade, bounds);
    }
  }
}

function controller() {
  const gm = [...(game.users ?? [])]
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return gm?.id === game.user?.id;
}

function nextTrack(playlist, current) {
  if (isRandomPlayback(playlist)) {
    const candidates = [...playlist.sounds].filter((sound) => sound.id !== current.id);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (![CONST.PLAYLIST_MODES.SEQUENTIAL, CONST.PLAYLIST_MODES.SHUFFLE].includes(playlist.mode)) return null;
  if (
    playlist.mode === CONST.PLAYLIST_MODES.SEQUENTIAL &&
    playlist.flags?.[MODULE_ID]?.loopPlaylist === false &&
    playlist.playbackOrder?.at(-1) === current.id
  )
    return null;
  return playlist._getNextSound?.(current.id);
}

function advanceApproachingEnd() {
  if (!controller() || !crossfadeEnabled()) return;
  for (const playlist of game.playlists) {
    if (pendingSilence(playlist)?.tracks) continue;
    for (const current of playlist.sounds) {
      const audio = current.sound;
      if (!current.playing || current.repeat || !audio?.playing || advanced.has(audio)) continue;
      const linked = queueState().linked;
      if (linked?.playlistId === playlist.id && linked.soundId === current.id) continue;
      const target = nextTrack(playlist, current);
      if (!target || transitionRange(playlist, target)?.max > 0) continue;
      const bounds = readBounds(current, audio.duration);
      const end = bounds?.end ?? audio.duration;
      const position = audio.currentTime;
      const fade = Math.min(configuredFade(current), (end - (bounds?.start ?? 0)) * 500);
      if (!Number.isFinite(end) || !Number.isFinite(position) || fade <= 0) continue;
      const remaining = end - position;
      if (remaining <= 0 || remaining > fade / 1000) continue;
      advanced.add(audio);
      const options = isRandomPlayback(playlist) ? { rnSilenceTarget: target.id } : {};
      playlist.playNext(current.id, options).catch(console.error);
    }
  }
}

function key(sound) {
  return `${sound.parent.id}:${sound.id}`;
}

function cancel(sound, stop = false) {
  const active = fading.get(key(sound));
  if (!active) return;
  fading.delete(key(sound));
  clearTimeout(active.timer);
  if (stop) active.audio.stop({ fade: 0 }).catch(console.error);
  else if (active.audio.playing) active.audio.fade(sound.volume, { duration: 100 }).catch(console.error);
}

function transitionFor(sound) {
  const transition = sound.parent.flags?.[MODULE_ID]?.crossfadeTransition;
  if (!transition || transition.from !== sound.id || !sound.parent.sounds.get(transition.to)?.playing) return null;
  // The flag persists after the transition, but must not fade the same track twice.
  if (consumedTransitions.get(sound) === transition.id && fading.get(key(sound))?.id !== transition.id) return null;
  return transition;
}

function holdOutgoing(sound, transition) {
  const audio = sound.sound;
  if (!audio?.playing) return false;
  if (fading.get(key(sound))?.id === transition.id) return true;
  cancelOlder(sound.parent.id, key(sound));
  cancel(sound);
  const remaining = sound.sound?.duration - sound.sound?.currentTime;
  const duration = Math.max(0, Math.min(transition.duration, Number.isFinite(remaining) ? remaining * 1000 : Infinity));
  if (!duration) return false;
  const id = transition.id;
  const timer = setTimeout(() => {
    if (fading.get(key(sound))?.id !== id) return;
    fading.delete(key(sound));
    audio.stop({ fade: 0 }).catch(console.error);
  }, duration);
  fading.set(key(sound), { id, audio, timer, to: transition.to });
  // Remember this exact copy if the same playlist track starts again before it stops.
  outgoingSounds.set(sound, audio);
  const clearOutgoing = () => {
    if (outgoingSounds.get(sound) === audio && sound.sound !== audio) outgoingSounds.delete(sound);
  };
  audio.addEventListener?.("end", clearOutgoing, { once: true });
  audio.addEventListener?.("stop", clearOutgoing, { once: true });
  consumedTransitions.set(sound, id);
  audio.fade(0, { duration }).catch(console.error);
  return true;
}

function transitionUpdate(playlist, data, options) {
  if (!crossfadeEnabled() || options.rnSilenceTransition || pendingSilence(playlist)?.tracks) return data;
  if (!Array.isArray(data.sounds)) return data;
  const incoming = data.sounds.find((entry) => entry.playing === true && !playlist.sounds.get(entry._id)?.playing);
  if (!incoming) return data;
  const outgoing = [...playlist.sounds].find(
    (sound) =>
      sound.playing &&
      sound.id !== incoming._id &&
      data.sounds.some((entry) => entry._id === sound.id && entry.playing === false),
  );
  if (!outgoing) return data;
  const target = playlist.sounds.get(incoming._id);
  if (!target) return data;
  const duration = configuredFade(outgoing);
  if (!duration) return data;
  // Store the chosen durations with the update so later setting changes cannot alter it.
  return {
    ...data,
    flags: {
      ...data.flags,
      [MODULE_ID]: {
        ...data.flags?.[MODULE_ID],
        crossfadeTransition: {
          id: foundry.utils.randomID(),
          from: outgoing.id,
          to: target.id,
          duration,
          fadeIn: target.fadeDuration,
        },
      },
    },
  };
}

export function installCrossfadePlayback() {
  const Playlist = foundry.documents.Playlist;
  const PlaylistSound = foundry.documents.PlaylistSound;
  let sceneGeneration = 0;
  let pendingScene = null;
  const originalUpdate = Playlist.prototype.update;
  const originalStopAll = Playlist.prototype.stopAll;
  const originalSync = PlaylistSound.prototype.sync;
  const originalEnd = PlaylistSound.prototype._onEnd;
  const originalStop = PlaylistSound.prototype._onStop;
  const originalCreate = PlaylistSound.prototype._createSound;
  const originalFade = Object.getOwnPropertyDescriptor(PlaylistSound.prototype, "fadeDuration");

  if (originalFade?.get) {
    Object.defineProperty(PlaylistSound.prototype, "fadeDuration", {
      configurable: true,
      get() {
        const starting = startingFades.get(this);
        if (starting !== undefined) return starting;
        // Explicit track and playlist values retain Foundry's original precedence.
        if (!crossfadeEnabled() || this.fade != null || this.parent?.fade != null) return originalFade.get.call(this);
        const duration = this.sound?.duration;
        return Math.min(configuredFade(this), Number.isFinite(duration) ? duration * 500 : Infinity);
      },
    });
  }

  Playlist.prototype.update = function (data = {}, options = {}) {
    return originalUpdate.call(this, transitionUpdate(this, data, options), options);
  };
  if (originalStopAll)
    Playlist.prototype.stopAll = function (...args) {
      if (
        pendingScene &&
        !pendingScene.stopping &&
        (pendingScene.playlist === this || pendingScene.incoming === this)
      ) {
        sceneGeneration++;
        for (const sound of pendingScene.incomingSounds) startingFades.delete(sound);
        pendingScene = null;
      }
      return originalStopAll.apply(this, args);
    };
  PlaylistSound.prototype.sync = function (...args) {
    if (this.playing) {
      const outgoing = outgoingSounds.get(this);
      if (outgoing && outgoing === this.sound) {
        // Restart on a fresh Sound while the previous copy still fades out.
        const fresh = this._createSound();
        if (fresh) {
          this.sound = fresh;
          if (!outgoing.playing) outgoingSounds.delete(this);
        }
      }
      if (fading.get(key(this))?.audio === this.sound) cancel(this);
      if (!this.sound?.playing && !startingFades.has(this)) {
        const transition = this.parent.flags?.[MODULE_ID]?.crossfadeTransition;
        const outgoing = transition?.to === this.id ? this.parent.sounds.get(transition.from) : null;
        const fade =
          audibleOrStopping(outgoing?.sound) && Number.isFinite(transition.fadeIn)
            ? transition.fadeIn
            : this.fadeDuration;
        startingFades.set(this, fade);
      }
      if (deferUntilStopped(this, originalSync, args)) return;
      const active = activeStarts.get(this);
      if (active && active.audio === this.sound && performance.now() < active.until) {
        // Foundry may sync again during fade-in, which would restart the fade.
        if (this.volume === active.volume && this.repeat === active.repeat) return;
        activeStarts.delete(this);
      }
    } else {
      deferredStarts.delete(this);
      startingFades.delete(this);
      activeStarts.delete(this);
      const pending = pendingRepeats.get(this);
      if (pending) {
        pendingRepeats.delete(this);
        activeRepeatDocuments.delete(this);
        pending.stop({ fade: 0 }).catch(console.error);
      }
      for (const [id, active] of fading) {
        if (!id.startsWith(`${this.parent.id}:`) || active.to !== this.id) continue;
        clearTimeout(active.timer);
        fading.delete(id);
        active.audio.stop({ fade: 0 }).catch(console.error);
      }
      const tail = repeatTails.get(this);
      if (tail) {
        clearTimeout(tail.timer);
        repeatTails.delete(this);
        activeRepeatDocuments.delete(this);
        tail.audio.stop({ fade: 0 }).catch(console.error);
      }
      const transition = transitionFor(this);
      if (transition && holdOutgoing(this, transition)) return;
      cancel(this, true);
    }
    return originalSync.apply(this, args);
  };
  PlaylistSound.prototype._createSound = function (...args) {
    const audio = originalCreate.apply(this, args);
    if (audio)
      audio.addEventListener("play", () => {
        const fade = startingFades.get(this) ?? 0;
        startingFades.delete(this);
        if (fade > 0)
          activeStarts.set(this, {
            audio,
            volume: this.volume,
            repeat: this.repeat,
            until: performance.now() + fade,
          });
        prepareRepeat(this, audio);
      });
    return audio;
  };
  PlaylistSound.prototype._onEnd = function (...args) {
    const outgoing = outgoingSounds.get(this);
    // An old copy ending must not advance the playlist after its track restarts.
    if (outgoing && !outgoing.playing && (this.sound !== outgoing || !this.playing)) return;
    if (pendingRepeats.has(this) || (repeatTails.has(this) && this.sound?.playing)) return;
    return originalEnd.apply(this, args);
  };
  PlaylistSound.prototype._onStop = function (...args) {
    if (pendingRepeats.has(this) || (repeatTails.has(this) && this.sound?.playing)) return;
    return originalStop.apply(this, args);
  };
  Hooks.once("ready", () =>
    setInterval(() => {
      advanceApproachingEnd();
      advanceRepeat();
    }, 100),
  );

  const Collection = foundry.documents.collections?.Playlists;
  if (Collection?.prototype?._onChangeScene) {
    const originalSceneChange = Collection.prototype._onChangeScene;
    let previousScenePlaylist = null;
    let previousSceneSound = null;
    Hooks.once("ready", () => {
      previousScenePlaylist = game.scenes.active?._source?.playlist ?? null;
      previousSceneSound = game.scenes.active?._source?.playlistSound ?? null;
    });
    Collection.prototype._onChangeScene = function (scene) {
      const nextId = scene?._source?.playlist ?? null;
      const nextSoundId = scene?._source?.playlistSound ?? null;
      const oldId = previousScenePlaylist;
      const oldSoundId = previousSceneSound;
      previousScenePlaylist = nextId;
      previousSceneSound = nextSoundId;
      const generation = ++sceneGeneration;
      const interrupted = pendingScene;
      pendingScene = null;
      if (interrupted && nextId === interrupted.fromId && nextSoundId === interrupted.fromSoundId) {
        // Returning to the prior scene waits for its interrupted stop to finish.
        for (const sound of interrupted.incomingSounds) startingFades.delete(sound);
        return Promise.all(interrupted.ending.map((sound) => waitForStop(sound.sound, sound.fadeDuration))).then(
          async () => {
            await originalSceneChange.call(this, scene);
            return interrupted.priorSound?.update({ playing: true }) ?? interrupted.playlist.playAll();
          },
        );
      }
      if (interrupted) for (const sound of interrupted.incomingSounds) startingFades.delete(sound);
      if (!oldId || !nextId || (oldId === nextId && (!oldSoundId || !nextSoundId || oldSoundId === nextSoundId))) {
        return originalSceneChange.call(this, scene);
      }
      const outgoing = this.get(oldId);
      const incoming = this.get(nextId);
      const selected = incoming?.sounds.get(scene._source.playlistSound);
      if (!outgoing || !incoming || !outgoing.playing) return originalSceneChange.call(this, scene);
      if (scene._source.playlistSound && !selected) return originalSceneChange.call(this, scene);
      const incomingSounds = (selected ? [selected] : [...incoming.sounds]).filter((sound) => !sound.sound?.playing);
      for (const sound of incomingSounds) {
        if (!startingFades.has(sound)) startingFades.set(sound, sound.fadeDuration);
      }
      if (!crossfadeEnabled()) {
        const priorSound = outgoing.sounds.get(oldSoundId);
        const ending = priorSound ? [priorSound] : [...outgoing.sounds].filter((sound) => sound.playing);
        const stopped = ending.map((sound) => waitForStop(sound.sound, sound.fadeDuration));
        const sceneTransition = {
          fromId: oldId,
          fromSoundId: oldSoundId,
          playlist: outgoing,
          incoming,
          priorSound,
          ending,
          incomingSounds,
          stopping: true,
        };
        pendingScene = sceneTransition;
        const stop = priorSound ? priorSound.update({ playing: false }) : outgoing.stopAll();
        sceneTransition.stopping = false;
        return Promise.resolve(stop)
          .then(() => Promise.all(stopped))
          .then(() => {
            // A newer scene change owns playback if this wait finishes late.
            if (generation === sceneGeneration) {
              pendingScene = null;
              return originalSceneChange.call(this, scene);
            }
            for (const sound of incomingSounds) startingFades.delete(sound);
          })
          .finally(() => {
            if (pendingScene === sceneTransition) pendingScene = null;
          });
      }
      // Start the incoming sound before Foundry awaits the old playlist's stop.
      // Still run the original handler so its private scene state stays current.
      const start = selected ? selected.update({ playing: true }) : incoming.playAll();
      return Promise.all([start, originalSceneChange.call(this, scene)]).then(() => {});
    };
  }
}
