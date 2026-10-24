import { stopPreviewForPlayback } from "../audio/preview.mjs";
import { error, MODULE_ID, state } from "../core/context.mjs";

export function refresh() {
  if (state.suspendRefresh) return;
  game.playlists.initializeTree();
  ui.playlists?.render();
}

export function installFolder(data) {
  const id = data._id;
  const old = game.folders.get(id);
  if (old && !state.folders.has(id)) throw error("FolderCollision", { id });
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

function withoutPositions({ sort, folder, sounds, ...playlist }) {
  return { ...playlist, sounds: sounds?.map(({ sort, ...sound }) => sound) };
}

// Sorting must keep the current PlaylistSound objects: replacing them stops audio and restarts playback.
function applyPositionChanges(playlist, data) {
  if (JSON.stringify(withoutPositions(playlist.toObject())) !== JSON.stringify(withoutPositions(data))) return false;
  const playlistChanges = {};
  if ("sort" in data && playlist.sort !== data.sort) playlistChanges.sort = data.sort;
  if (playlist._source.folder !== data.folder) playlistChanges.folder = data.folder;
  if (Object.keys(playlistChanges).length) playlist.updateSource(playlistChanges);
  const changes = [];
  const changedSounds = [];
  for (const entry of data.sounds ?? []) {
    const sound = playlist.sounds.get(entry._id);
    if ("sort" in entry && sound.sort !== entry.sort) {
      sound.updateSource({ sort: entry.sort });
      changes.push({ _id: entry._id, sort: entry.sort });
      changedSounds.push(sound);
    }
  }
  if (changes.length) {
    playlist._onUpdateDescendantDocuments(playlist, "sounds", changedSounds, changes, { render: false }, game.user.id);
  }
  refresh();
  return true;
}

// Expose global playlists to Foundry's normal UI and playback without storing them in the world database.
export function installInClient(data) {
  const id = data._id;
  stopPreviewForPlayback(id, data.sounds);
  const old = game.playlists.get(id);
  if (old && !state.playlists.has(id)) {
    console.error(`[${MODULE_ID}] ID collision with a world playlist: ${id}`);
    return false;
  }
  if (old && applyPositionChanges(old, data)) return true;
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
  else
    game.audio.unlock.then(() => {
      if (state.playlists.get(id) === playlist) for (const sound of playlist.sounds) sound.sync();
    });
  refresh();
  return true;
}
