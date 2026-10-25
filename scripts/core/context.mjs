export const MODULE_ID = "rn-playlist-companion";
export const DIRECTORY = "rn-global-playlists";

export function t(key, data) {
  const fullKey = `RNPLAYCOMP.${key}`;
  return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

export const state = {
  playlists: new Map(),
  folders: new Map(),
  blockedPlaylists: new Map(),
  blockedFolders: new Map(),
  conflicts: [],
  playlistOrder: [],
  folderOrder: [],
  playbackByWorld: {},
  revision: 0,
  queue: Promise.resolve(),
  suspendRefresh: false,
  ready: false,
  stale: false,
};

export function error(key, data) {
  return new Error(`[${MODULE_ID}] ${t(`Errors.${key}`, data)}`);
}

const reportedErrors = new WeakSet();

export function reportError(cause) {
  if (cause instanceof Error) {
    if (reportedErrors.has(cause)) return cause;
    reportedErrors.add(cause);
  }
  console.error(cause);
  ui.notifications.error(cause instanceof Error ? cause.message : String(cause));
  return cause;
}

export function isGlobal(document) {
  const playlist = document?.documentName === "PlaylistSound" ? document.parent : document;
  return playlist?.documentName === "Playlist" && state.playlists.has(playlist.id);
}

export function isGlobalFolder(folder) {
  return folder?.documentName === "Folder" && state.folders.has(folder.id);
}

export function publish(type, payload) {
  game.socket.emit(`module.${MODULE_ID}`, { type, payload, sender: game.user.id });
}
