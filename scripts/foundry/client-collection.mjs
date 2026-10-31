import { stopPreviewForPlayback } from "../audio/preview.mjs";
import { schedule as scheduleSilence } from "../audio/silence-playback.mjs";
import { error, MODULE_ID, state } from "../core/context.mjs";

const pendingUnlock = new WeakSet();

function syncAfterUnlock(sound, playlist) {
  if (pendingUnlock.has(sound)) return;
  pendingUnlock.add(sound);
  game.audio.unlock.then(() => {
    pendingUnlock.delete(sound);
    if (game.playlists.get(playlist.id) !== playlist) return;
    sound.sync();
    refresh();
  });
}

export function refresh() {
  if (state.suspendRefresh) return;
  game.playlists.initializeTree();
  ui.playlists?.render();
}

export function installFolder(data) {
  const id = data._id;
  const old = game.folders.get(id);
  if (old && old !== state.folders.get(id)) throw error("FolderCollision", { id });
  const folder = new foundry.documents.Folder(data);
  game.folders.set(id, folder);
  state.folders.set(id, folder);
  refresh();
  return folder;
}

export function removeFolder(id) {
  if (game.folders.get(id) === state.folders.get(id)) game.folders.delete(id);
  state.folders.delete(id);
  refresh();
}

export function removeFromClient(id) {
  const playlist = game.playlists.get(id);
  if (playlist && playlist === state.playlists.get(id)) {
    for (const sound of playlist.sounds) sound.sound?.stop();
    game.playlists.delete(id);
    for (const scene of game.scenes) {
      if (scene._source.playlist === id) scene.playlistSound = null;
    }
  }
  state.playlists.delete(id);
  refresh();
}

function withoutLiveFields({
  sort,
  folder,
  playing,
  sounds,
  name,
  description,
  mode,
  sorting,
  fade,
  seed,
  flags,
  ...playlist
}) {
  if (flags) {
    const otherFlags = { ...flags };
    if (otherFlags[MODULE_ID]) {
      const moduleFlags = { ...otherFlags[MODULE_ID] };
      delete moduleFlags.randomPlayback;
      delete moduleFlags.silencePending;
      if (Object.keys(moduleFlags).length) otherFlags[MODULE_ID] = moduleFlags;
      else delete otherFlags[MODULE_ID];
    }
    if (Object.keys(otherFlags).length) playlist.flags = otherFlags;
  }
  return playlist;
}

// Playback state and metadata can update existing Sounds without replacing their audio objects.
function applyLiveChanges(playlist, data, { forceSync = false } = {}) {
  const current = withoutLiveFields(playlist.toObject());
  const incoming = withoutLiveFields(data);
  if (JSON.stringify(current) !== JSON.stringify(incoming)) return false;
  if (
    Array.from(playlist.sounds).length !== data.sounds?.length ||
    data.sounds.some((entry) => !playlist.sounds.get(entry._id))
  ) {
    return false;
  }
  const playlistChanges = {};
  if ("sort" in data && playlist.sort !== data.sort) playlistChanges.sort = data.sort;
  if (playlist._source.folder !== data.folder) playlistChanges.folder = data.folder;
  if ("playing" in data && playlist.playing !== data.playing) playlistChanges.playing = data.playing;
  if ("seed" in data && playlist.seed !== data.seed) playlistChanges.seed = data.seed;
  if (
    JSON.stringify(playlist.flags?.[MODULE_ID]?.silencePending ?? null) !==
      JSON.stringify(data.flags?.[MODULE_ID]?.silencePending ?? null) ||
    Boolean(playlist.flags?.[MODULE_ID]?.randomPlayback) !== Boolean(data.flags?.[MODULE_ID]?.randomPlayback)
  ) {
    playlistChanges.flags = data.flags ?? { [MODULE_ID]: { randomPlayback: false } };
  }
  for (const key of ["name", "description", "mode", "sorting", "fade"]) {
    if ((playlist._source ?? playlist)[key] !== data[key]) playlistChanges[key] = data[key];
  }
  const changes = [];
  const changedSounds = [];
  const soundsToSync = [];
  for (const entry of data.sounds ?? []) {
    const sound = playlist.sounds.get(entry._id);
    const update = {};
    if ("sort" in entry && sound.sort !== entry.sort) update.sort = entry.sort;
    if ("repeat" in entry && sound.repeat !== entry.repeat) update.repeat = entry.repeat;
    if ("volume" in entry && sound.volume !== entry.volume) update.volume = entry.volume;
    if ("playing" in entry && sound.playing !== entry.playing) update.playing = entry.playing;
    if ("pausedTime" in entry && sound.pausedTime !== entry.pausedTime) update.pausedTime = entry.pausedTime;
    for (const key of ["name", "description", "fade"]) {
      if ((sound._source ?? sound)[key] !== entry[key]) update[key] = entry[key];
    }
    if (sound.flags?.[MODULE_ID]?.threshold !== entry.flags?.[MODULE_ID]?.threshold) {
      update.flags = { [MODULE_ID]: { threshold: entry.flags?.[MODULE_ID]?.threshold ?? null } };
    }
    for (const [key, value] of Object.entries(entry)) {
      if (key === "_id" || (key !== "flags" && Object.hasOwn(update, key))) continue;
      if (JSON.stringify((sound._source ?? sound)[key]) !== JSON.stringify(value)) update[key] = value;
    }
    if (Object.keys(update).length) {
      sound.updateSource(update);
      if ("path" in update || "channel" in update) sound._onUpdate?.(update, { render: false }, game.user.id);
      changes.push({ _id: entry._id, ...update });
      changedSounds.push(sound);
      if ("repeat" in update || "volume" in update || "playing" in update || "pausedTime" in update) {
        soundsToSync.push(sound);
      }
    }
  }
  // Playlist.prepareDerivedData derives playing from its Sounds. Update them
  // first or updateSource will immediately revert the playlist's playing flag.
  if (Object.keys(playlistChanges).length || changedSounds.length) playlist.updateSource(playlistChanges);
  if (
    "mode" in playlistChanges ||
    "sorting" in playlistChanges ||
    "seed" in playlistChanges ||
    "flags" in playlistChanges
  ) {
    playlist._onUpdate?.(playlistChanges, { render: false }, game.user.id);
  }
  // updateSource skips preparation when the source value is already correct,
  // even if the live derived value was left stale by an earlier update.
  playlist.prepareDerivedData?.();
  for (const sound of soundsToSync) {
    if (game.audio.locked) syncAfterUnlock(sound, playlist);
    else sound.sync();
  }
  if ("fade" in playlistChanges) {
    for (const sound of playlist.sounds) {
      if (sound.playing && !sound.repeat && sound.fade == null) sound._scheduleFadeOut?.();
    }
  }
  for (const sound of changedSounds) {
    if ("fade" in changes.find((change) => change._id === sound.id) && sound.playing && !sound.repeat) {
      sound._scheduleFadeOut?.();
    }
  }
  if (changes.length) {
    playlist._onUpdateDescendantDocuments(playlist, "sounds", changedSounds, changes, { render: false }, game.user.id);
  }
  if (forceSync) {
    for (const sound of playlist.sounds) {
      if (!sound.playing || changedSounds.includes(sound)) continue;
      if (game.audio.locked) syncAfterUnlock(sound, playlist);
      else sound.sync();
    }
  }
  refresh();
  return true;
}

// Expose global playlists to Foundry's normal UI and playback without storing them in the world database.
export function installInClient(data, options = {}) {
  // Foundry uses Playlist.playing both to advance sequential playback and to
  // decide whether non-owners can see a playlist in the directory.
  if (!data.playing && data.sounds?.some((sound) => sound.playing)) data = { ...data, playing: true };
  const id = data._id;
  stopPreviewForPlayback(id, data.sounds);
  const old = game.playlists.get(id);
  if (old && old !== state.playlists.get(id)) {
    console.error(`[${MODULE_ID}] ID collision with a world playlist: ${id}`);
    return false;
  }
  if (old && applyLiveChanges(old, data, options)) {
    scheduleSilence(old);
    return true;
  }
  if (old) for (const sound of old.sounds) sound.sound?.stop();
  const playlist = new foundry.documents.Playlist(data);
  game.playlists.set(id, playlist);
  state.playlists.set(id, playlist);
  // Scene.playlist resolves dynamically, but Scene.playlistSound is cached during preparation.
  // Preparing the whole scene again also re-prepares its tiles, which is unsafe in Foundry v14.
  for (const scene of game.scenes) {
    if (scene._source.playlist === id) scene.playlistSound = playlist.sounds.get(scene._source.playlistSound) ?? null;
  }
  if (!game.audio.locked) for (const sound of playlist.sounds) sound.sync();
  else for (const sound of playlist.sounds) syncAfterUnlock(sound, playlist);
  refresh();
  scheduleSilence(playlist);
  return true;
}
