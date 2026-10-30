import {
  nextPlayback,
  playbackData,
  RANDOM_HISTORY_LIMIT,
  storedData,
  withPlayback,
} from "../audio/playback-state.mjs";
import { error, isGlobal, isGlobalFolder, MODULE_ID, publish, reportError, state, t } from "../core/context.mjs";
import {
  installFolder,
  installInClient,
  refresh,
  removeFolder,
  removeFromClient,
} from "../foundry/client-collection.mjs";
import { persist, readStore, serialize, serializeFolders } from "../storage/global-store.mjs";
import { revisionMessage } from "../storage/revision-control.mjs";
import { archiveEntries } from "./archive.mjs";

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
  if (!next.playing && next.sounds?.some((sound) => sound.playing)) next.playing = true;
  return next;
}

export async function updateGlobal(playlist, changes, options = {}) {
  if (
    !game.user.isGM &&
    (!game.user.hasPermission("PLAYLIST_CREATE") || !playlist.canUserModify(game.user, "update", changes))
  ) {
    throw error("PlaylistPermissionDenied");
  }
  // Foundry's Playlist._preUpdate refreshes the shared shuffle seed when playback
  // or the mode changes. Global updates bypass that document hook.
  if (("mode" in changes || "playing" in changes) && !("seed" in changes)) {
    changes = { ...changes, seed: Math.floor(Math.random() * 1000) };
  }
  const updated = applyChanges(playlist.toObject(), changes);
  const candidate = serialize().map((item) => (item._id === playlist.id ? storedData(updated) : item));
  const randomMode = changes.flags?.[MODULE_ID]?.randomPlayback;
  const modeChanged =
    (randomMode !== undefined && randomMode !== playlist.flags?.[MODULE_ID]?.randomPlayback) ||
    ("mode" in changes && changes.mode !== playlist.mode);
  const randomHistory = options.rnRandomHistory ?? (modeChanged ? [] : undefined);
  const saved = await persist(candidate, nextPlayback(playlist.id, updated, randomHistory), null, null, {
    announceRevision: false,
  });
  installInClient(updated, options);
  publish(
    "patch",
    {
      id: playlist.id,
      changes,
      ...(randomHistory !== undefined ? { randomHistory } : {}),
    },
    revisionMessage(saved),
  );
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
  if (
    !game.user.isGM &&
    (!game.user.hasPermission("PLAYLIST_CREATE") || !playlist.canUserModify(game.user, "update"))
  ) {
    throw error("PlaylistPermissionDenied");
  }
  const next = playlist.toObject();
  next.sounds = sounds;
  const candidate = serialize().map((item) => (item._id === playlist.id ? storedData(next) : item));
  const saved = await persist(candidate, nextPlayback(playlist.id, next), null, null, { announceRevision: false });
  installInClient(next);
  publish("upsert", next, revisionMessage(saved));
  return state.playlists.get(playlist.id);
}

export async function removeGlobal(id) {
  if (!state.playlists.has(id)) throw error("GlobalPlaylistNotFound");
  const playlist = state.playlists.get(id);
  if (
    !game.user.isGM &&
    (!game.user.hasPermission("PLAYLIST_CREATE") || !playlist.canUserModify(game.user, "delete"))
  ) {
    throw error("PlaylistPermissionDenied");
  }
  const playback = foundry.utils.deepClone(state.playbackByWorld);
  for (const world of Object.values(playback)) delete world[id];
  const saved = await persist(
    serialize().filter((item) => item._id !== id),
    playback,
    null,
    {
      add: archiveEntries({
        playlists: [state.playlists.get(id).toObject()],
        reason: "deleted",
      }),
    },
    { announceRevision: false },
  );
  removeFromClient(id);
  publish("remove", { id }, revisionMessage(saved));
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

export function hasBlockedBranch(id) {
  const folders = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of serializeFolders()) {
      if (folder.folder && folders.has(folder.folder) && !folders.has(folder._id)) {
        folders.add(folder._id);
        changed = true;
      }
    }
  }
  return (
    [...state.blockedFolders.keys()].some((folderId) => folders.has(folderId)) ||
    [...state.blockedPlaylists.values()].some((playlist) => folders.has(playlist.folder))
  );
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
    content: `<p class="rn-confirm-message">${foundry.utils.escapeHTML(describeMove(folder, branch, global))}</p>`,
    yes: { label: t("UI.Move") },
  });
}

export async function moveBranchToGlobal(document, targetFolder = null, ask = true) {
  if (!state.ready || !game.user.isGM) throw error("GMOnlyMove");
  let moving = document;
  let folder = moving.documentName === "Folder" ? moving : null;
  if (folder && folder.type !== "Playlist") throw error("NotPlaylistFolder");
  if (isGlobal(moving) || isGlobalFolder(folder)) throw error("AlreadyGlobal");
  if (targetFolder && !isGlobalFolder(game.folders.get(targetFolder))) throw error("TargetNotGlobal");
  let branch = folder ? folderBranch(folder.id, false) : { folders: [], playlists: [moving] };
  if (ask && !(await confirmMove(folder, branch, true))) return null;
  while (true) {
    branch = folder ? folderBranch(folder.id, false) : { folders: [], playlists: [moving] };
    const conflict = state.conflicts.find((item) =>
      item.type === "folder"
        ? branch.folders.some((entry) => entry.id === item.id)
        : branch.playlists.some((entry) => entry.id === item.id),
    );
    if (!conflict) break;
    const { resolveConflictForMove } = await import("./conflicts.mjs");
    const resolved = await resolveConflictForMove(conflict);
    if (!resolved) return null;
    if (moving.id === conflict.id && moving.documentName.toLowerCase() === conflict.type) moving = resolved;
    folder = moving.documentName === "Folder" ? moving : null;
  }
  if (
    branch.folders.some((item) => state.folders.has(item.id) || state.blockedFolders.has(item.id)) ||
    branch.playlists.some((item) => state.playlists.has(item.id) || state.blockedPlaylists.has(item.id))
  ) {
    throw error("DuplicateID");
  }
  const folderData = branch.folders.map((f) => f.toObject());
  const playlistData = branch.playlists.map((p) => p.toObject());
  const root = folder ? folderData.find((f) => f._id === folder.id) : playlistData[0];
  root.folder = targetFolder;
  const playback = foundry.utils.deepClone(state.playbackByWorld);
  playback[game.world.id] ??= {};
  const world = playback[game.world.id];
  for (const data of playlistData) {
    const history = data.flags?.[MODULE_ID]?.randomHistory;
    world[data._id] = playbackData(
      data,
      data.flags?.[MODULE_ID]?.randomPlayback
        ? Array.isArray(history)
          ? history.slice(-RANDOM_HISTORY_LIMIT)
          : []
        : undefined,
    );
    if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID].randomHistory;
  }
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
  return folder ? state.folders.get(folder.id) : state.playlists.get(moving.id);
}

export async function moveBranchToLocal(document, targetFolder = null, ask = true) {
  if (!state.ready || !game.user.isGM) throw error("GMOnlyMove");
  const folder = document.documentName === "Folder" ? document : null;
  if (!(folder ? isGlobalFolder(folder) : isGlobal(document))) throw error("NotGlobal");
  if (targetFolder && isGlobalFolder(game.folders.get(targetFolder))) throw error("TargetGlobal");
  const branch = folder ? folderBranch(folder.id, true) : { folders: [], playlists: [document] };
  if (folder && hasBlockedBranch(folder.id)) throw error("UnresolvedConflict");
  if (ask && !(await confirmMove(folder, branch, false))) return null;
  const folderData = branch.folders.map((f) => f.toObject());
  const playlistData = branch.playlists.map((p) => p.toObject());
  for (const data of playlistData) {
    const history = state.playbackByWorld[game.world.id]?.[data._id]?.randomHistory;
    if (!Array.isArray(history)) continue;
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], randomHistory: history.slice(-RANDOM_HISTORY_LIMIT) };
  }
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
      {
        add: archiveEntries({
          playlists: branch.playlists.map((item) => item.toObject()),
          folders: branch.folders.map((item) => item.toObject()),
          reason: "moved-to-local",
          world: game.world.id,
        }),
      },
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
const reloadListeners = new Set();

export function onGlobalDataApplied(listener) {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

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
    state.indexCache = { revision: disk.revision, index: disk.indexData };
    state.playlistOrder = disk.playlists.map((playlist) => playlist._id);
    state.folderOrder = disk.folders.map((folder) => folder._id);
    state.playbackByWorld = disk.playbackByWorld ?? {};
    state.blockedPlaylists = new Map();
    state.blockedFolders = new Map();
    state.conflicts = [];
    const blockedFolderIds = new Set();
    // A folder whose ID belongs to a local folder cannot be installed, nor can its global descendants.
    for (const folder of disk.folders) {
      const local = game.folders.get(folder._id);
      if (local && local !== state.folders.get(folder._id)) {
        blockedFolderIds.add(folder._id);
        state.conflicts.push({ type: "folder", id: folder._id, local: local.name, global: folder.name });
      }
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const folder of disk.folders) {
        if (folder.folder && blockedFolderIds.has(folder.folder) && !blockedFolderIds.has(folder._id)) {
          blockedFolderIds.add(folder._id);
          expanded = true;
        }
      }
    }
    for (const folder of disk.folders) {
      if (blockedFolderIds.has(folder._id)) {
        if (state.folders.has(folder._id)) removeFolder(folder._id);
        state.blockedFolders.set(folder._id, folder);
      } else installFolder(folder);
    }
    const worldPlayback = state.playbackByWorld[game.world.id] ?? {};
    for (const playlist of disk.playlists) {
      const next = withPlayback(playlist, worldPlayback[playlist._id]);
      const local = game.playlists.get(playlist._id);
      if (local && local !== state.playlists.get(playlist._id)) {
        state.playlists.delete(playlist._id);
        state.blockedPlaylists.set(playlist._id, playlist);
        state.conflicts.push({ type: "playlist", id: playlist._id, local: local.name, global: playlist.name });
        continue;
      }
      if (playlist.folder && state.blockedFolders.has(playlist.folder)) {
        if (state.playlists.has(playlist._id)) removeFromClient(playlist._id);
        state.blockedPlaylists.set(playlist._id, playlist);
        continue;
      }
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

export function reloadGlobalPlaylists() {
  state.indexCache = null;
  reloadPending = true;
  if (reloadTask) return reloadTask;
  reloadTask = (async () => {
    while (reloadPending) {
      reloadPending = false;
      let disk;
      try {
        disk = await readStore();
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
    if (reloadPending) reloadGlobalPlaylists().catch(reportError);
    else for (const listener of reloadListeners) listener();
  });
  return reloadTask;
}
