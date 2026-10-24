import { MODULE_ID } from "../core/context.mjs";

const SETTING = "hiddenLocal";

function refreshPlaylistViews() {
  const Directory = foundry.applications.sidebar?.tabs?.PlaylistDirectory;
  if (!Directory) return;
  const views = new Set([ui.playlists, ...Object.values(ui.windows ?? {})]);
  for (const view of views) if (view instanceof Directory) view.render();
}

export function registerVisibilitySettings() {
  game.settings.register(MODULE_ID, SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: { folders: [], playlists: [] },
    onChange: refreshPlaylistViews,
  });
}

function localHidden() {
  return game.settings.get(MODULE_ID, SETTING);
}

export function isHidden(document) {
  const folder = document.documentName === "Folder";
  const ids = localHidden();
  return (folder ? ids.folders : ids.playlists).includes(document.id);
}

export async function setHidden(document, hidden) {
  const folder = document.documentName === "Folder";
  const current = localHidden();
  const type = folder ? "folders" : "playlists";
  const ids = new Set(current[type]);
  if (hidden) ids.add(document.id);
  else ids.delete(document.id);
  const next = { ...current, [type]: [...ids] };
  await game.settings.set(MODULE_ID, SETTING, next);
}

export function filterHiddenTree(
  node,
  { showHidden = false, hiddenFolders, hiddenPlaylists, playingIds },
  ancestorHidden = false,
) {
  const folderHidden = ancestorHidden || (node.folder && hiddenFolders.has(node.folder.id));
  const entries = node.entries.filter((entry) => {
    if (showHidden) return true;
    if (folderHidden) return playingIds.has(entry.id);
    return !hiddenPlaylists.has(entry.id) || playingIds.has(entry.id);
  });
  const children = node.children
    .map((child) => filterHiddenTree(child, { showHidden, hiddenFolders, hiddenPlaylists, playingIds }, folderHidden))
    .filter(Boolean);
  if (folderHidden && !showHidden && !entries.length && !children.length) return null;
  return { ...node, entries, children };
}

export function hiddenIds() {
  const local = localHidden();
  return {
    hiddenFolders: new Set(local.folders),
    hiddenPlaylists: new Set(local.playlists),
  };
}
