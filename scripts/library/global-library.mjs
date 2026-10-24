import { nextPlayback, playbackData, storedData, withPlayback } from "../audio/playback-state.mjs";
import { error, isGlobal, isGlobalFolder, publish, state, t } from "../core/context.mjs";
import {
  installFolder,
  installInClient,
  refresh,
  removeFolder,
  removeFromClient,
} from "../foundry/client-collection.mjs";
import { persist, readStore, serialize, serializeFolders } from "../storage/global-store.mjs";

export function applyChanges(data, changes) {
  const next = foundry.utils.deepClone(data);
  const { sounds, ...rest } = changes;
  delete rest._id;
  foundry.utils.mergeObject(next, rest, { inplace: true });
  if (Array.isArray(sounds)) {
    const byId = new Map((next.sounds ?? []).map((sound) => [sound._id, sound]));
    for (const patch of sounds) {
      const sound = byId.get(patch._id);
      if (!sound) throw error("SoundNotFound", { id: patch._id });
      foundry.utils.mergeObject(sound, patch, { inplace: true });
    }
  }
  return next;
}

export async function updateGlobal(playlist, changes, _options = {}) {
  const updated = applyChanges(playlist.toObject(), changes);
  const candidate = serialize().map((item) => (item._id === playlist.id ? storedData(updated) : item));
  await persist(candidate, nextPlayback(playlist.id, updated));
  installInClient(updated);
  publish("upsert", updated);
  return state.playlists.get(playlist.id);
}

export async function createGlobalSounds(playlist, data) {
  const next = playlist.toObject();
  const created = data.map((raw) => ({ ...raw, _id: raw._id ?? foundry.utils.randomID() }));
  next.sounds.push(...created);
  await replaceGlobalSounds(playlist, next.sounds);
  return created.map((sound) => state.playlists.get(playlist.id).sounds.get(sound._id));
}

export async function deleteGlobalSounds(playlist, ids) {
  const deleted = ids.map((id) => playlist.sounds.get(id)).filter(Boolean);
  const next = playlist.toObject();
  next.sounds = next.sounds.filter((sound) => !ids.includes(sound._id));
  await replaceGlobalSounds(playlist, next.sounds);
  return deleted;
}

export async function replaceGlobalSounds(playlist, sounds) {
  const next = playlist.toObject();
  next.sounds = sounds;
  const candidate = serialize().map((item) => (item._id === playlist.id ? storedData(next) : item));
  await persist(candidate, nextPlayback(playlist.id, next));
  installInClient(next);
  publish("upsert", next);
  return state.playlists.get(playlist.id);
}

export async function removeGlobal(id) {
  if (!state.playlists.has(id)) throw error("GlobalPlaylistNotFound");
  const playback = foundry.utils.deepClone(state.playbackByWorld);
  for (const world of Object.values(playback)) delete world[id];
  await persist(
    serialize().filter((item) => item._id !== id),
    playback,
  );
  removeFromClient(id);
  publish("remove", { id });
  return true;
}

export function folderBranch(id, global) {
  const folders = global
    ? [...state.folders.values()]
    : game.folders.filter((f) => f.type === "Playlist" && !isGlobalFolder(f));
  const playlists = global ? [...state.playlists.values()] : game.playlists.filter((p) => !isGlobal(p));
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!ids.has(folder.id) && ids.has(folder._source.folder)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return {
    folders: folders.filter((f) => ids.has(f.id)),
    playlists: playlists.filter((p) => ids.has(p._source.folder)),
  };
}

export function describeMove(folder, branch, global) {
  return t(`UI.${folder ? "MoveFolderConfirm" : "MovePlaylistConfirm"}`, {
    name: folder?.name ?? branch.playlists[0].name,
    destination: t(`UI.${global ? "ToGlobal" : "ToLocal"}`),
    folders: branch.folders.length,
    playlists: branch.playlists.length,
  });
}

export async function confirmMove(folder, branch, global) {
  return foundry.applications.api.DialogV2.confirm({
    window: { title: t(`UI.${global ? "MoveGlobal" : "MoveLocal"}`) },
    content: `<p>${foundry.utils.escapeHTML(describeMove(folder, branch, global))}</p>`,
    yes: { label: t("UI.Move") },
  });
}

export async function moveBranchToGlobal(document, targetFolder = null, ask = true) {
  if (!state.ready || !game.user.isGM) throw error("GMOnlyMove");
  const folder = document.documentName === "Folder" ? document : null;
  if (folder && folder.type !== "Playlist") throw error("NotPlaylistFolder");
  if (isGlobal(document) || isGlobalFolder(folder)) throw error("AlreadyGlobal");
  if (targetFolder && !isGlobalFolder(game.folders.get(targetFolder))) throw error("TargetNotGlobal");
  const branch = folder ? folderBranch(folder.id, false) : { folders: [], playlists: [document] };
  if (ask && !(await confirmMove(folder, branch, true))) return null;
  const folderData = branch.folders.map((f) => f.toObject());
  const playlistData = branch.playlists.map((p) => p.toObject());
  const root = folder ? folderData.find((f) => f._id === folder.id) : playlistData[0];
  root.folder = targetFolder;
  const ids = new Set([...folderData, ...playlistData].map((d) => d._id));
  if ([...state.folders.keys(), ...state.playlists.keys()].some((id) => ids.has(id))) throw error("DuplicateID");
  const playback = foundry.utils.deepClone(state.playbackByWorld);
  playback[game.world.id] ??= {};
  const world = playback[game.world.id];
  for (const data of playlistData) world[data._id] = playbackData(data);
  // Save the global copy before deleting local documents, so a failed write leaves the originals intact.
  await persist([...serialize(), ...playlistData.map(storedData)], playback, [...serializeFolders(), ...folderData]);
  try {
    for (const playlist of branch.playlists) await playlist.delete();
    for (const item of [...branch.folders].reverse()) await item.delete();
  } catch (e) {
    throw error("GlobalSavedLocalDeleteFailed", { reason: e.message });
  }
  for (const data of folderData) installFolder(data);
  for (const data of playlistData) installInClient(data);
  publish("reload");
  return folder ? state.folders.get(folder.id) : state.playlists.get(document.id);
}

export async function moveBranchToLocal(document, targetFolder = null, ask = true) {
  if (!state.ready || !game.user.isGM) throw error("GMOnlyMove");
  const folder = document.documentName === "Folder" ? document : null;
  if (!(folder ? isGlobalFolder(folder) : isGlobal(document))) throw error("NotGlobal");
  if (targetFolder && isGlobalFolder(game.folders.get(targetFolder))) throw error("TargetGlobal");
  const branch = folder ? folderBranch(folder.id, true) : { folders: [], playlists: [document] };
  if (ask && !(await confirmMove(folder, branch, false))) return null;
  const folderData = branch.folders.map((f) => f.toObject());
  const playlistData = branch.playlists.map((p) => p.toObject());
  const root = folder ? folderData.find((f) => f._id === folder.id) : playlistData[0];
  root.folder = targetFolder;
  // Release the IDs in Foundry's client collections before creating local documents with those same IDs.
  for (const data of playlistData) removeFromClient(data._id);
  for (const data of [...folderData].reverse()) removeFolder(data._id);
  const made = [];
  try {
    for (const data of folderData) made.push(await foundry.documents.Folder.create(data, { keepId: true }));
    for (const data of playlistData) made.push(await foundry.documents.Playlist.create(data, { keepId: true }));
    const folderIds = new Set(folderData.map((d) => d._id));
    const playlistIds = new Set(playlistData.map((d) => d._id));
    const playback = foundry.utils.deepClone(state.playbackByWorld);
    for (const world of Object.values(playback)) for (const id of playlistIds) delete world[id];
    await persist(
      serialize().filter((p) => !playlistIds.has(p._id)),
      playback,
      serializeFolders().filter((f) => !folderIds.has(f._id)),
    );
  } catch (e) {
    for (const item of made.reverse()) await item.delete().catch(console.error);
    for (const data of folderData) installFolder(data);
    for (const data of playlistData) installInClient(data);
    throw error("MakeLocalFailed", { reason: e.message });
  }
  publish("reload");
  return game.folders.get(folder?.id) ?? game.playlists.get(document.id);
}

let reloadTask;
let reloadPending = false;
let createOnReload = false;

// A socket update received during a file read makes that read obsolete.
export function invalidateGlobalReload() {
  if (reloadTask) reloadPending = true;
}

function applyGlobalData(disk) {
  state.suspendRefresh = true;
  try {
    const folderIds = new Set(disk.folders.map((f) => f._id));
    const playlistIds = new Set(disk.playlists.map((p) => p._id));
    for (const id of [...state.playlists.keys()]) if (!playlistIds.has(id)) removeFromClient(id);
    for (const id of [...state.folders.keys()]) if (!folderIds.has(id)) removeFolder(id);
    state.revision = disk.revision;
    state.playbackByWorld = disk.playbackByWorld ?? {};
    for (const folder of disk.folders) installFolder(folder);
    const worldPlayback = state.playbackByWorld[game.world.id] ?? {};
    for (const playlist of disk.playlists) {
      const next = withPlayback(playlist, worldPlayback[playlist._id]);
      const current = state.playlists.get(playlist._id);
      if (current && JSON.stringify(current.toObject()) === JSON.stringify(next)) continue;
      installInClient(next);
    }
    state.stale = false;
    state.ready = true;
  } finally {
    state.suspendRefresh = false;
    refresh();
  }
}

export function reloadGlobalPlaylists({ create = false } = {}) {
  createOnReload ||= create;
  reloadPending = true;
  if (reloadTask) return reloadTask;
  reloadTask = (async () => {
    while (reloadPending) {
      reloadPending = false;
      let disk;
      try {
        disk = await readStore({ create: createOnReload });
      } catch (error) {
        if (reloadPending) continue;
        throw error;
      }
      if (reloadPending) continue;
      // Another local write may have committed while this read was in flight.
      if (disk.revision < state.revision) continue;
      applyGlobalData(disk);
    }
  })().finally(() => {
    reloadTask = null;
    createOnReload = false;
    if (reloadPending) reloadGlobalPlaylists().catch(console.error);
  });
  return reloadTask;
}
