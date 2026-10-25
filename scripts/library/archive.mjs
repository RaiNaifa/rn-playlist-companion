import { storedData } from "../audio/playback-state.mjs";
import { error, publish, state } from "../core/context.mjs";
import {
  installFolder,
  installInClient,
  refresh,
  removeFolder,
  removeFromClient,
} from "../foundry/client-collection.mjs";
import { persist, readArchive, serialize, serializeFolders } from "../storage/global-store.mjs";

export function archiveEntries({ playlists = [], folders = [], reason, world = null }) {
  const batchId = foundry.utils.randomID();
  const archivedAt = new Date().toISOString();
  const worldName = world === game.world.id ? (game.world.title ?? null) : null;
  return [
    ...folders.map((folder) => ({
      archiveId: foundry.utils.randomID(),
      batchId,
      type: "folder",
      id: folder._id,
      name: folder.name,
      reason,
      world,
      worldName,
      archivedAt,
      data: foundry.utils.deepClone(folder),
    })),
    ...playlists.map((playlist) => ({
      archiveId: foundry.utils.randomID(),
      batchId,
      type: "playlist",
      id: playlist._id,
      name: playlist.name,
      reason,
      world,
      worldName,
      archivedAt,
      data: storedData(playlist),
    })),
  ];
}

export function archivedBranch(entries, selected) {
  if (selected.type !== "folder") return [selected];
  const batch = entries.filter((entry) => entry.batchId === selected.batchId);
  const folders = new Set([selected.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of batch) {
      if (entry.type === "folder" && !folders.has(entry.id) && folders.has(entry.data.folder)) {
        folders.add(entry.id);
        changed = true;
      }
    }
  }
  return batch.filter((entry) => (entry.type === "folder" && folders.has(entry.id)) || folders.has(entry.data.folder));
}

function globalBranch(id, type, playlists, folders) {
  if (type === "playlist") return { playlists: playlists.filter((item) => item._id === id), folders: [] };
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!ids.has(folder._id) && ids.has(folder.folder)) {
        ids.add(folder._id);
        changed = true;
      }
    }
  }
  return {
    playlists: playlists.filter((item) => ids.has(item.folder)),
    folders: folders.filter((item) => ids.has(item._id)),
  };
}

function allocateId(used) {
  let id;
  do id = foundry.utils.randomID();
  while (used.has(id));
  used.add(id);
  return id;
}

export function restorePlan(
  selected,
  entries,
  {
    mode,
    playlists,
    folders,
    localPlaylistIds,
    localFolderIds,
    availableFolderIds = folders.map((folder) => folder._id),
  },
) {
  const branch = archivedBranch(entries, selected);
  const active =
    selected.type === "playlist"
      ? playlists.some((item) => item._id === selected.id)
      : folders.some((item) => item._id === selected.id);
  if (mode === "replace" && !active) throw error("ArchiveReplaceMissing");
  const replaced = active && mode === "replace" ? globalBranch(selected.id, selected.type, playlists, folders) : null;
  const replacedPlaylistIds = new Set(replaced?.playlists.map((item) => item._id));
  const replacedFolderIds = new Set(replaced?.folders.map((item) => item._id));
  const usedPlaylistIds = new Set([
    ...playlists.filter((item) => !replacedPlaylistIds.has(item._id)).map((item) => item._id),
    ...localPlaylistIds,
  ]);
  const usedFolderIds = new Set([
    ...folders.filter((item) => !replacedFolderIds.has(item._id)).map((item) => item._id),
    ...localFolderIds,
  ]);
  const ids = new Map();
  // Replacement keeps the selected active ID. Collisions elsewhere get new IDs before folder links are rebuilt.
  for (const entry of branch) {
    const used = entry.type === "folder" ? usedFolderIds : usedPlaylistIds;
    const keepId = mode === "replace" && entry.id === selected.id;
    if (keepId && used.has(entry.id)) throw error("DuplicateID");
    const nextId = keepId || !used.has(entry.id) ? entry.id : allocateId(used);
    used.add(nextId);
    ids.set(entry.archiveId, nextId);
  }
  const folderIds = new Map(
    branch.filter((entry) => entry.type === "folder").map((entry) => [entry.id, ids.get(entry.archiveId)]),
  );
  const rootFolder =
    mode === "replace"
      ? ((selected.type === "folder" ? folders : playlists).find((item) => item._id === selected.id)?.folder ?? null)
      : availableFolderIds.includes(selected.data.folder)
        ? selected.data.folder
        : null;
  const restoredFolders = branch
    .filter((entry) => entry.type === "folder")
    .map((entry) => ({
      ...foundry.utils.deepClone(entry.data),
      _id: ids.get(entry.archiveId),
      folder: entry.archiveId === selected.archiveId ? rootFolder : (folderIds.get(entry.data.folder) ?? null),
    }));
  const restoredPlaylists = branch
    .filter((entry) => entry.type === "playlist")
    .map((entry) => ({
      ...storedData(entry.data),
      _id: ids.get(entry.archiveId),
      folder: entry.archiveId === selected.archiveId ? rootFolder : (folderIds.get(entry.data.folder) ?? null),
    }));
  return {
    branch,
    ids,
    replaced,
    playlists: restoredPlaylists,
    folders: restoredFolders,
    candidatePlaylists: [...playlists.filter((item) => !replacedPlaylistIds.has(item._id)), ...restoredPlaylists],
    candidateFolders: [...folders.filter((item) => !replacedFolderIds.has(item._id)), ...restoredFolders],
    resetPlaybackIds: [...replacedPlaylistIds],
  };
}

export async function restoreArchived(archiveId, mode, { relinkScenes = false } = {}) {
  if (!game.user.isGM) throw error("GMOnlyEdit");
  const archive = await readArchive();
  const selected = archive.entries.find((entry) => entry.archiveId === archiveId);
  if (!selected) throw error("ArchiveMissing");
  const playlists = serialize();
  const folders = serializeFolders();
  const plan = restorePlan(selected, archive.entries, {
    mode,
    playlists,
    folders,
    localPlaylistIds: [...game.playlists].filter((item) => !state.playlists.has(item.id)).map((item) => item.id),
    localFolderIds: [...game.folders].filter((item) => !state.folders.has(item.id)).map((item) => item.id),
    availableFolderIds: [...state.folders.keys()],
  });
  // Keep the snapshot after restoration: another world's older backup may still refer to its original IDs.
  const mark = Object.fromEntries(
    plan.branch.map((entry) => [
      entry.archiveId,
      { restoredAs: plan.ids.get(entry.archiveId), restoredAt: new Date().toISOString() },
    ]),
  );
  const add = plan.replaced ? archiveEntries({ ...plan.replaced, reason: "replaced", world: game.world.id }) : [];
  await persist(plan.candidatePlaylists, null, plan.candidateFolders, {
    add,
    mark,
    resetPlaybackIds: plan.resetPlaybackIds,
  });
  const wasSuspended = state.suspendRefresh;
  state.suspendRefresh = true;
  try {
    for (const item of plan.replaced?.playlists ?? []) removeFromClient(item._id);
    for (const item of [...(plan.replaced?.folders ?? [])].reverse()) removeFolder(item._id);
    for (const item of plan.replaced?.playlists ?? []) state.blockedPlaylists.delete(item._id);
    for (const item of plan.replaced?.folders ?? []) state.blockedFolders.delete(item._id);
    const replacedIds = new Set([
      ...(plan.replaced?.playlists ?? []).map((item) => item._id),
      ...(plan.replaced?.folders ?? []).map((item) => item._id),
    ]);
    state.conflicts = state.conflicts.filter((conflict) => !replacedIds.has(conflict.id));
    for (const item of plan.folders) installFolder(item);
    for (const item of plan.playlists) {
      if (!installInClient(item)) throw error("ArchiveInstallCollision", { id: item._id });
    }
  } catch (cause) {
    const { reloadGlobalPlaylists } = await import("./global-library.mjs");
    await reloadGlobalPlaylists().catch(console.error);
    throw cause;
  } finally {
    state.suspendRefresh = wasSuspended;
    refresh();
  }
  publish("reload");
  if (relinkScenes) {
    const playlistIds = new Map(
      plan.branch
        .filter((entry) => entry.type === "playlist")
        .map((entry) => [entry.id, plan.ids.get(entry.archiveId)]),
    );
    const failed = [];
    for (const scene of game.scenes) {
      const oldId = scene._source.playlist;
      const nextId = playlistIds.get(oldId);
      if (!nextId || nextId === oldId) continue;
      try {
        await scene.update({ playlist: nextId });
      } catch (cause) {
        failed.push({ scene, cause });
      }
    }
    if (failed.length) {
      const items = failed
        .map(
          ({ scene }) => `<li>${foundry.utils.escapeHTML(scene.name)} (ID: ${foundry.utils.escapeHTML(scene.id)})</li>`,
        )
        .join("");
      await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.localize("RNPLAYCOMP.Archive.SceneRelinkResultTitle") },
        content: `<div class="rn-archive-dialog"><p>${game.i18n.format("RNPLAYCOMP.Archive.SceneRelinkPartial", { count: failed.length })}</p><ul>${items}</ul></div>`,
      });
    }
  }
  return plan;
}

export async function forgetArchiveEntry(archiveId) {
  if (!game.user.isGM) throw error("GMOnlyEdit");
  const archive = await readArchive();
  const selected = archive.entries.find((entry) => entry.archiveId === archiveId);
  if (!selected) throw error("ArchiveMissing");
  const remove = archivedBranch(archive.entries, selected).map((entry) => entry.archiveId);
  await persist(serialize(), null, serializeFolders(), { remove });
}
