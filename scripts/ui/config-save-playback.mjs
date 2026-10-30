import { isGlobal, MODULE_ID } from "../core/context.mjs";

const SETTING = "keepPlayingOnConfigSave";
const PLAYLIST_FIELDS = new Set(["name", "description", "mode", "sorting", "fade"]);
const SOUND_FIELDS = new Set(["name", "description", "volume", "repeat", "fade"]);

function removeUnchangedChannel(document, data) {
  if (!Object.hasOwn(data, "channel")) return;
  const diff = document.updateSource({ channel: data.channel }, { dryRun: true, clean: true, fallback: false });
  if (!Object.hasOwn(diff, "channel")) delete data.channel;
}

function stopPlaylist(playlist, data) {
  data.playing = false;
  const submitted = new Map((data.sounds ?? []).map((sound) => [sound._id, sound]));
  const existing = Array.from(playlist.sounds, (sound) => ({
    ...submitted.get(sound.id),
    _id: sound.id,
    playing: false,
    pausedTime: null,
  }));
  const existingIds = new Set(existing.map((sound) => sound._id));
  data.sounds = [
    ...existing,
    ...(data.sounds ?? [])
      .filter((sound) => !existingIds.has(sound._id))
      .map((sound) => ({ ...sound, playing: false, pausedTime: null })),
  ];
}

function changedFields(document, data) {
  const diff = document.updateSource(data, { dryRun: true, clean: true, fallback: false });
  return diff;
}

export function safeConfigChanges(diff, sound = false) {
  const allowed = sound ? SOUND_FIELDS : PLAYLIST_FIELDS;
  for (const [key, value] of Object.entries(diff)) {
    if (key === "_id" || allowed.has(key)) continue;
    if (
      !sound &&
      key === "flags" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 1 &&
      value[MODULE_ID] &&
      typeof value[MODULE_ID] === "object" &&
      Object.keys(value[MODULE_ID]).every((field) => ["randomPlayback", "randomHistory"].includes(field))
    )
      continue;
    if (
      sound &&
      key === "flags" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 1 &&
      value[MODULE_ID] &&
      typeof value[MODULE_ID] === "object" &&
      Object.keys(value[MODULE_ID] ?? {}).length === 1 &&
      Object.hasOwn(value[MODULE_ID], "threshold")
    )
      continue;
    return false;
  }
  return true;
}

export function registerConfigSavePlayback() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.KeepPlayingOnConfigSave.Name",
    hint: "RNPLAYCOMP.Settings.KeepPlayingOnConfigSave.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  Hooks.on("updatePlaylistSound", (sound, changed) => {
    if ("fade" in changed && sound.playing && !sound.repeat) sound._scheduleFadeOut();
  });
  Hooks.on("updatePlaylist", (playlist, changed) => {
    if (!("fade" in changed)) return;
    for (const sound of playlist.sounds) {
      if (sound.playing && !sound.repeat && sound.fade == null) sound._scheduleFadeOut();
    }
  });

  const { PlaylistConfig, PlaylistSoundConfig } = foundry.applications.sheets;
  const originalPlaylist = PlaylistConfig.prototype._processSubmitData;
  PlaylistConfig.prototype._processSubmitData = function (event, form, data, options) {
    if (!this.document.collection?.has(this.document.id))
      return originalPlaylist.call(this, event, form, data, options);
    const keepPlaying = game.settings.get(MODULE_ID, SETTING);
    if (!keepPlaying) {
      if (isGlobal(this.document)) stopPlaylist(this.document, data);
      return originalPlaylist.call(this, event, form, data, options);
    }
    removeUnchangedChannel(this.document, data);
    const safe = safeConfigChanges(changedFields(this.document, data));
    if (!safe) stopPlaylist(this.document, data);
    return originalPlaylist.call(this, event, form, data, options);
  };

  const originalSound = PlaylistSoundConfig.prototype._processSubmitData;
  PlaylistSoundConfig.prototype._processSubmitData = function (event, form, data, options) {
    if (!this.document.collection?.has(this.document.id)) return originalSound.call(this, event, form, data, options);
    const keepPlaying = game.settings.get(MODULE_ID, SETTING);
    if (!keepPlaying) {
      if (isGlobal(this.document)) {
        data.playing = false;
        data.pausedTime = null;
      }
      return originalSound.call(this, event, form, data, options);
    }
    removeUnchangedChannel(this.document, data);
    const normalized = {
      ...data,
      volume: foundry.audio.AudioHelper.inputToVolume(data.volume),
    };
    const safe = safeConfigChanges(changedFields(this.document, normalized), true);
    if (!safe) {
      data.playing = false;
      data.pausedTime = null;
    }
    return originalSound.call(this, event, form, data, options);
  };
}
