import { error, MODULE_ID, publish, state, t } from "../core/context.mjs";
import { reloadGlobalPlaylists } from "./global-library.mjs";

function newId(collection, blocked) {
  let id;
  do id = foundry.utils.randomID();
  while (collection.get(id) || blocked.has(id));
  return id;
}

async function remapHidden(type, oldId, newId) {
  const current = game.settings.get(MODULE_ID, "hiddenLocal");
  const key = type === "folder" ? "folders" : "playlists";
  if (!current[key].includes(oldId)) return null;
  await game.settings.set(MODULE_ID, "hiddenLocal", {
    ...current,
    [key]: current[key].map((id) => (id === oldId ? newId : id)),
  });
  return current;
}

export async function resolveLocalConflict(type, id) {
  // Keep the original local document until its replacement and references are saved, so failure can roll back.
  if (!game.user.isGM) throw error("GMOnlyEdit");
  if (!state.conflicts.some((item) => item.type === type && item.id === id)) throw error("ArchiveConflictMissing");
  let created;
  if (type === "playlist") {
    const original = game.playlists.get(id);
    const copy = original.toObject();
    copy._id = newId(game.playlists, state.blockedPlaylists);
    let oldHidden;
    const scenes = [...game.scenes].filter((scene) => scene._source.playlist === id);
    const updated = [];
    try {
      created = await foundry.documents.Playlist.create(copy, { keepId: true });
      for (const scene of scenes) {
        await scene.update({ playlist: copy._id });
        updated.push(scene);
      }
      oldHidden = await remapHidden(type, id, copy._id);
      await original.delete();
    } catch (cause) {
      if (oldHidden) await game.settings.set(MODULE_ID, "hiddenLocal", oldHidden).catch(console.error);
      for (const scene of updated.reverse()) await scene.update({ playlist: id }).catch(console.error);
      if (created) await created.delete().catch(console.error);
      throw cause;
    }
  } else {
    const original = game.folders.get(id);
    const copy = original.toObject();
    copy._id = newId(game.folders, state.blockedFolders);
    const children = [
      ...game.folders.filter((item) => item._source.folder === id && !state.folders.has(item.id)),
      ...game.playlists.filter((item) => item._source.folder === id && !state.playlists.has(item.id)),
    ];
    const updated = [];
    let oldHidden;
    try {
      created = await foundry.documents.Folder.create(copy, { keepId: true });
      for (const child of children) {
        await child.update({ folder: copy._id });
        updated.push(child);
      }
      oldHidden = await remapHidden(type, id, copy._id);
      await original.delete();
    } catch (cause) {
      if (oldHidden) await game.settings.set(MODULE_ID, "hiddenLocal", oldHidden).catch(console.error);
      for (const child of updated.reverse()) await child.update({ folder: id }).catch(console.error);
      if (created) await created.delete().catch(console.error);
      throw cause;
    }
  }
  await reloadGlobalPlaylists();
  publish("reload");
  return created;
}

export async function resolveConflictForMove(conflict) {
  const content = `<p>${foundry.utils.escapeHTML(t("Archive.MoveConflictIntro", { name: conflict.local }))}</p>
    <p>${foundry.utils.escapeHTML(t("Archive.MoveConflictGlobal", { name: conflict.global }))}</p>
    <p>${foundry.utils.escapeHTML(t("Archive.MoveConflictEffect"))}</p>`;
  const accepted = await foundry.applications.api.DialogV2.confirm({
    window: { title: t("Archive.ConflictTitle") },
    content: `<div class="rn-confirm-message">${content}</div>`,
    yes: { label: t("Archive.KeepBothAndMove") },
  });
  return accepted ? resolveLocalConflict(conflict.type, conflict.id) : null;
}
