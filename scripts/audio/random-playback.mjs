import { isGlobal, MODULE_ID, state, t } from "../core/context.mjs";
import { RANDOM_HISTORY_LIMIT } from "./playback-state.mjs";

// Virtual mode for the playlist UI.
// Playback is stored in the module flag because Foundry only accepts modes 0–2.
const RANDOM_MODE = 3;

export function isRandomPlayback(playlist) {
  return playlist?.flags?.[MODULE_ID]?.randomPlayback === true;
}

function historyFor(playlist) {
  const saved = isGlobal(playlist)
    ? state.playbackByWorld[game.world.id]?.[playlist.id]?.randomHistory
    : playlist.flags?.[MODULE_ID]?.randomHistory;
  return Array.isArray(saved) ? saved.filter((id) => playlist.sounds.has(id)).slice(-RANDOM_HISTORY_LIMIT) : [];
}

function updateWithHistory(playlist, changes, history) {
  if (isGlobal(playlist)) return playlist.update(changes, { rnRandomHistory: history });
  return playlist.update({
    ...changes,
    flags: {
      ...changes.flags,
      [MODULE_ID]: { ...changes.flags?.[MODULE_ID], randomHistory: history },
    },
  });
}

function soundChanges(playlist, selectedId, { preservePause = true } = {}) {
  return playlist.sounds.map((sound) => ({
    _id: sound.id,
    playing: sound.id === selectedId,
    pausedTime: preservePause && sound.id === selectedId ? (sound.pausedTime ?? null) : null,
  }));
}

export function installRandomPlayback() {
  const Playlist = foundry.documents.Playlist;
  const PlaylistSound = foundry.documents.PlaylistSound;
  const original = {
    update: Playlist.prototype.update,
    playAll: Playlist.prototype.playAll,
    playNext: Playlist.prototype.playNext,
    playSound: Playlist.prototype.playSound,
    stopAll: Playlist.prototype.stopAll,
    stopSound: Playlist.prototype.stopSound,
    cycleMode: Playlist.prototype.cycleMode,
    onSoundEnd: Playlist.prototype._onSoundEnd,
    onSoundStart: Playlist.prototype._onSoundStart,
    soundUpdate: PlaylistSound.prototype.update,
  };

  // A full stop can arrive through a direct update, so clear history here as well as in stopAll.
  Playlist.prototype.update = function (changes = {}, options = {}) {
    if (
      isRandomPlayback(this) &&
      changes.playing === false &&
      !changes.sounds?.some((sound) => sound.pausedTime != null) &&
      options.rnRandomHistory === undefined &&
      !options.rnSilenceTransition &&
      changes.flags?.[MODULE_ID]?.randomHistory === undefined
    ) {
      return updateWithHistory(this, changes, []);
    }
    return original.update.call(this, changes, options);
  };

  PlaylistSound.prototype.update = function (changes = {}, options = {}) {
    if (isRandomPlayback(this.parent) && Object.keys(changes).length === 1) {
      if (changes.playing === true) return this.parent.playSound(this).then((playlist) => playlist.sounds.get(this.id));
      if (changes.playing === false)
        return this.parent.stopSound(this).then((playlist) => playlist.sounds.get(this.id));
    }
    return original.soundUpdate.call(this, changes, options);
  };

  Playlist.prototype.playAll = function () {
    if (!isRandomPlayback(this)) return original.playAll.call(this);
    if (!this.sounds.size) return Promise.resolve(this);
    const paused = this.sounds.find((sound) => sound.pausedTime);
    const sounds = [...this.sounds];
    const selected = paused ?? sounds[Math.floor(Math.random() * sounds.length)];
    return updateWithHistory(
      this,
      { playing: true, sounds: soundChanges(this, selected.id) },
      paused ? historyFor(this) : [],
    );
  };

  Playlist.prototype.playNext = function (soundId, options = {}) {
    if (!isRandomPlayback(this)) return original.playNext.call(this, soundId, options);
    if ((!this.playing && !options.rnSilenceAdvance) || this.sounds.size < 2) return Promise.resolve(this);
    const current = soundId ? this.sounds.get(soundId) : this.sounds.find((sound) => sound.playing);
    if (!current) return Promise.resolve(this);
    const history = historyFor(this);
    let selected;
    if (options.direction === -1) {
      while (history.length && !selected) selected = this.sounds.get(history.pop());
      if (!selected) return Promise.resolve(this);
    } else {
      const candidates = [...this.sounds].filter((sound) => sound.id !== current.id);
      selected = candidates[Math.floor(Math.random() * candidates.length)];
      history.push(current.id);
      if (history.length > RANDOM_HISTORY_LIMIT) history.shift();
    }
    return updateWithHistory(this, { sounds: soundChanges(this, selected.id, { preservePause: false }) }, history);
  };

  Playlist.prototype.playSound = function (sound) {
    if (!isRandomPlayback(this)) return original.playSound.call(this, sound);
    const current = this.sounds.find((entry) => entry.playing) ?? this.sounds.find((entry) => entry.pausedTime);
    const history = historyFor(this);
    if (current && current.id !== sound.id) {
      history.push(current.id);
      if (history.length > RANDOM_HISTORY_LIMIT) history.shift();
    }
    return updateWithHistory(this, { playing: true, sounds: soundChanges(this, sound.id) }, history);
  };

  Playlist.prototype.stopAll = function () {
    if (!isRandomPlayback(this)) return original.stopAll.call(this);
    return updateWithHistory(
      this,
      { playing: false, sounds: this.sounds.map((sound) => ({ _id: sound.id, playing: false, pausedTime: null })) },
      [],
    );
  };

  Playlist.prototype.stopSound = function (sound) {
    if (!isRandomPlayback(this)) return original.stopSound.call(this, sound);
    const remaining = this.sounds.some((entry) => entry.id !== sound.id && entry.playing);
    return updateWithHistory(
      this,
      { playing: remaining, sounds: [{ _id: sound.id, playing: false, pausedTime: null }] },
      remaining ? historyFor(this) : [],
    );
  };

  Playlist.prototype.cycleMode = function () {
    if (isRandomPlayback(this)) {
      return updateWithHistory(
        this,
        { mode: CONST.PLAYLIST_MODES.SEQUENTIAL, flags: { [MODULE_ID]: { randomPlayback: false } } },
        [],
      );
    }
    if (this.mode === CONST.PLAYLIST_MODES.DISABLED) {
      return updateWithHistory(
        this,
        { mode: CONST.PLAYLIST_MODES.SEQUENTIAL, flags: { [MODULE_ID]: { randomPlayback: true } } },
        [],
      );
    }
    return original.cycleMode.call(this);
  };

  Playlist.prototype._onSoundEnd = function (sound) {
    if (!isRandomPlayback(this)) return original.onSoundEnd.call(this, sound);
    if (this.sounds.size !== 1) return this.playNext(sound.id);
    return this.update(
      { sounds: [{ _id: sound.id, playing: true, pausedTime: null }] },
      { diff: false, forceSync: true },
    );
  };

  // Foundry's handler advances sounds in playlist order. Random mode selects the next sound itself.
  Playlist.prototype._onSoundStart = function (sound) {
    if (isRandomPlayback(this)) return;
    return original.onSoundStart.call(this, sound);
  };

  const Config = foundry.applications.sheets.PlaylistConfig;
  const prepareContext = Config.prototype._prepareContext;
  Config.prototype._prepareContext = async function (options) {
    const context = await prepareContext.call(this, options);
    context.modes[RANDOM_MODE] = t("UI.RandomMode");
    if (isRandomPlayback(this.document)) context.source = { ...context.source, mode: RANDOM_MODE };
    return context;
  };
  const processFormData = Config.prototype._processFormData;
  Config.prototype._processFormData = function (event, form, formData) {
    const data = processFormData.call(this, event, form, formData);
    const random = Number(data.mode) === RANDOM_MODE;
    if (random) data.mode = CONST.PLAYLIST_MODES.SEQUENTIAL;
    if (random || isRandomPlayback(this.document)) {
      data.flags ??= {};
      data.flags[MODULE_ID] = {
        ...data.flags[MODULE_ID],
        randomPlayback: random,
        ...(random !== isRandomPlayback(this.document) && !isGlobal(this.document) ? { randomHistory: [] } : {}),
      };
    }
    return data;
  };

  const Directory = foundry.applications.sidebar.tabs.PlaylistDirectory;
  Directory.PLAYLIST_MODES[RANDOM_MODE] = { icon: "fa-solid fa-dice", label: "RNPLAYCOMP.UI.RandomMode" };
  const preparePlaylist = Directory.prototype._preparePlaylistContext;
  Directory.prototype._preparePlaylistContext = function (...args) {
    const context = preparePlaylist.call(this, ...args);
    if (isRandomPlayback(args[1])) context.mode = this.constructor.PLAYLIST_MODES[RANDOM_MODE];
    return context;
  };
  Hooks.on("updatePlaylist", (_playlist, changes) => {
    if (changes.flags?.[MODULE_ID]?.randomPlayback !== undefined) ui.playlists?.render();
  });
}
