import { MODULE_ID, reportError } from "../core/context.mjs";
import { isRandomPlayback } from "./random-playback.mjs";
import { drawDuration, pendingSilence, repeatRange, transitionRange } from "./silence-data.mjs";

const timers = new Map();
const ending = new WeakSet();
const operations = new WeakMap();
const continuing = new WeakSet();

function serialize(playlist, action) {
  // A timer and a manual control can finish together. Apply their playlist updates in order.
  const previous = operations.get(playlist) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  operations.set(playlist, current);
  current
    .finally(() => {
      if (operations.get(playlist) === current) operations.delete(playlist);
    })
    .catch(() => {});
  return current;
}

function controller() {
  // Every client renders the countdown, but only one active GM advances playback.
  const gm = [...(game.users ?? [])]
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return gm ? gm.id === game.user?.id : Boolean(game.user?.isGM);
}

function allowedMode(playlist) {
  return (
    isRandomPlayback(playlist) ||
    [CONST.PLAYLIST_MODES.SEQUENTIAL, CONST.PLAYLIST_MODES.SHUFFLE].includes(playlist.mode)
  );
}

function stateFor(playlist) {
  const state = pendingSilence(playlist);
  return { tracks: state?.tracks ?? null, repeats: { ...state?.repeats } };
}

async function saveState(playlist, state, changes = {}) {
  // The pending entry is synchronized with clients and persisted for reconnects.
  if (state && !state.tracks && !Object.values(state.repeats ?? {}).some(Boolean)) state = null;
  return playlist.update(
    {
      ...changes,
      flags: { ...changes.flags, [MODULE_ID]: { ...changes.flags?.[MODULE_ID], silencePending: state } },
    },
    { rnSilenceTransition: true },
  );
}

async function clearState(playlist) {
  if (!pendingSilence(playlist)) return playlist;
  return saveState(playlist, null);
}

function entry(durationMs, soundId) {
  return { id: foundry.utils.randomID(), soundId, startedAt: Date.now(), durationMs };
}

async function startTrackGap(playlist, sound) {
  const range = transitionRange(playlist);
  if (!range || !allowedMode(playlist)) return false;
  if (!isRandomPlayback(playlist) && !playlist._getNextSound?.(sound.id)) return false;
  const durationMs = drawDuration(range);
  if (!durationMs) return false;
  const state = stateFor(playlist);
  state.tracks = entry(durationMs, sound.id);
  await saveState(playlist, state, {
    playing: false,
    sounds: [{ _id: sound.id, playing: false, pausedTime: null }],
  });
  schedule(playlist);
  return true;
}

async function startRepeatGap(playlist, sound) {
  const range = repeatRange(sound);
  if (!range) return false;
  const durationMs = drawDuration(range);
  if (!durationMs) return false;
  const state = stateFor(playlist);
  state.repeats[sound.id] = entry(durationMs, sound.id);
  await saveState(playlist, state, { sounds: [{ _id: sound.id, playing: false, pausedTime: null }] });
  schedule(playlist);
  return true;
}

async function nextSound(playlist, sourceId, direction = 1) {
  if (isRandomPlayback(playlist)) {
    if (playlist.sounds.size === 1) return playlist.playSound(playlist.sounds.get(sourceId));
    return playlist.playNext(sourceId, { direction, rnSilenceAdvance: true });
  }
  const method = direction < 0 ? "_getPreviousSound" : "_getNextSound";
  const sound = playlist[method]?.(sourceId);
  if (sound) return playlist.playSound(sound);
  return playlist.update({ playing: false });
}

async function complete(playlist, kind, soundId, id) {
  if (!controller() || game.playlists.get(playlist.id) !== playlist) return;
  const state = stateFor(playlist);
  const current = kind === "tracks" ? state.tracks : state.repeats[soundId];
  if (current?.id !== id) return;
  if (kind === "tracks") {
    if (!allowedMode(playlist)) return clearState(playlist);
    state.tracks = null;
    await saveState(playlist, state);
    continuing.add(playlist);
    try {
      await nextSound(playlist, soundId);
    } finally {
      continuing.delete(playlist);
    }
  } else {
    const sound = playlist.sounds.get(soundId);
    state.repeats[soundId] = null;
    await saveState(playlist, state);
    if (sound?.repeat) {
      continuing.add(playlist);
      try {
        await playlist.playSound(sound);
      } finally {
        continuing.delete(playlist);
      }
    }
  }
}

export function schedule(playlist) {
  const prefix = `${playlist.id}:`;
  const state = stateFor(playlist);
  const desired = new Map();
  if (state.tracks) desired.set(`${prefix}tracks`, ["tracks", state.tracks]);
  for (const [soundId, value] of Object.entries(state.repeats)) {
    if (value) desired.set(`${prefix}${soundId}`, ["repeat", value]);
  }
  for (const [key, timer] of timers) {
    if (
      !key.startsWith(prefix) ||
      (controller() && timer.playlist === playlist && desired.get(key)?.[1].id === timer.id)
    )
      continue;
    clearTimeout(timer.handle);
    timers.delete(key);
  }
  if (!controller()) return;
  for (const [key, [kind, value]] of desired) {
    if (timers.get(key)?.id === value.id && timers.get(key)?.playlist === playlist) continue;
    // Recreate the timer from its original deadline instead of restarting the interval.
    const deadline = value.startedAt + value.durationMs;
    const delay = Math.min(2_147_000_000, Math.max(0, deadline - Date.now()));
    const handle = setTimeout(() => {
      timers.delete(key);
      if (Date.now() < deadline) {
        schedule(playlist);
        return;
      }
      serialize(playlist, () => complete(playlist, kind, value.soundId, value.id)).catch(reportError);
    }, delay);
    timers.set(key, { id: value.id, handle, playlist });
  }
}

export function installSilencePlayback() {
  const Playlist = foundry.documents.Playlist;
  const PlaylistSound = foundry.documents.PlaylistSound;
  const original = {
    update: Playlist.prototype.update,
    playAll: Playlist.prototype.playAll,
    playNext: Playlist.prototype.playNext,
    playSound: Playlist.prototype.playSound,
    stopAll: Playlist.prototype.stopAll,
    stopSound: Playlist.prototype.stopSound,
    onSoundEnd: Playlist.prototype._onSoundEnd,
    createSound: PlaylistSound.prototype._createSound,
    soundEnd: PlaylistSound.prototype._onEnd,
  };

  Playlist.prototype.update = function (changes = {}, options = {}) {
    const pending = pendingSilence(this);
    if (pending && !options.rnSilenceTransition) {
      const stop = changes.playing === false && !changes.sounds?.some((sound) => sound.pausedTime != null);
      const modeChanged = changes.mode !== undefined && changes.mode !== this.mode;
      const nonSequential =
        modeChanged && ![CONST.PLAYLIST_MODES.SEQUENTIAL, CONST.PLAYLIST_MODES.SHUFFLE].includes(changes.mode);
      if (stop || nonSequential) {
        const next = stop ? null : { ...stateFor(this), tracks: null };
        const normalized = next && Object.values(next.repeats).some(Boolean) ? next : null;
        changes = {
          ...changes,
          flags: { ...changes.flags, [MODULE_ID]: { ...changes.flags?.[MODULE_ID], silencePending: normalized } },
        };
      }
    }
    return original.update.call(this, changes, options);
  };

  Playlist.prototype.playAll = async function (...args) {
    if (!continuing.has(this)) await operations.get(this)?.catch(() => {});
    if (pendingSilence(this)) await clearState(this);
    return original.playAll.apply(this, args);
  };
  Playlist.prototype.playSound = async function (sound, ...args) {
    if (!continuing.has(this)) await operations.get(this)?.catch(() => {});
    const pending = pendingSilence(this);
    if (pending?.tracks || pending?.repeats?.[sound.id]) {
      const state = stateFor(this);
      state.tracks = null;
      state.repeats[sound.id] = null;
      await saveState(this, state);
    }
    return original.playSound.call(this, sound, ...args);
  };
  Playlist.prototype.playNext = async function (soundId, options = {}) {
    if (!continuing.has(this)) await operations.get(this)?.catch(() => {});
    const pending = pendingSilence(this)?.tracks;
    if (!pending) return original.playNext.call(this, soundId, options);
    await clearState(this);
    return nextSound(this, soundId ?? pending.soundId, options.direction ?? 1);
  };
  Playlist.prototype.stopAll = async function (...args) {
    if (!continuing.has(this)) await operations.get(this)?.catch(() => {});
    if (pendingSilence(this)) await clearState(this);
    return original.stopAll.apply(this, args);
  };
  Playlist.prototype.stopSound = async function (sound, ...args) {
    if (!continuing.has(this)) await operations.get(this)?.catch(() => {});
    const state = stateFor(this);
    if (state.tracks?.soundId === sound.id) {
      state.tracks = null;
      await saveState(this, state);
      schedule(this);
      return this;
    }
    if (state.repeats[sound.id]) {
      state.repeats[sound.id] = null;
      await saveState(this, state);
      schedule(this);
      return this;
    }
    return original.stopSound.call(this, sound, ...args);
  };
  Playlist.prototype._onSoundEnd = function (sound) {
    if (!controller()) return;
    if (ending.has(sound)) return this;
    ending.add(sound);
    return serialize(this, async () => {
      try {
        if (sound.repeat && (await startRepeatGap(this, sound))) return this;
        // Zero-length repeat gaps still need Foundry to restart the ended sound once.
        if (sound.repeat && repeatRange(sound)?.max > 0) {
          return this.update(
            { sounds: [{ _id: sound.id, playing: true, pausedTime: null }] },
            { diff: false, forceSync: true },
          );
        }
        if (await startTrackGap(this, sound)) return this;
        continuing.add(this);
        try {
          return await original.onSoundEnd.call(this, sound);
        } finally {
          continuing.delete(this);
        }
      } finally {
        ending.delete(sound);
      }
    });
  };
  PlaylistSound.prototype._createSound = function (...args) {
    const sound = original.createSound.apply(this, args);
    if (!sound) return sound;
    const play = sound.play.bind(sound);
    // Foundry's audio loop would bypass _onEnd, so a delayed repeat must play once per cycle.
    sound.play = (options = {}) => {
      const range = repeatRange(this);
      return play(this.repeat && range?.max > 0 ? { ...options, loop: false } : options);
    };
    return sound;
  };
  PlaylistSound.prototype._onEnd = function (...args) {
    const range = repeatRange(this);
    if (this.playing && this.repeat && range?.max > 0) return this.parent._onSoundEnd(this);
    return original.soundEnd.apply(this, args);
  };

  Hooks.on("updatePlaylist", (playlist) => schedule(playlist));
  Hooks.on("deletePlaylist", (playlist) => {
    for (const [key, timer] of timers)
      if (key.startsWith(`${playlist.id}:`)) {
        clearTimeout(timer.handle);
        timers.delete(key);
      }
  });
  Hooks.on("deletePlaylistSound", (sound) => {
    const timer = timers.get(`${sound.parent?.id}:${sound.id}`);
    if (timer) clearTimeout(timer.handle);
    timers.delete(`${sound.parent?.id}:${sound.id}`);
  });
  Hooks.once("ready", () => {
    for (const playlist of game.playlists) schedule(playlist);
    setInterval(() => {
      for (const playlist of game.playlists) if (pendingSilence(playlist)) schedule(playlist);
    }, 5000);
  });
}
