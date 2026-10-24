export const MODULE_ID = "rn-playlist-companion";
export const DIRECTORY = "rn-global-playlists";

export function t(key, data) {
  const fullKey = `RNPLAYCOMP.${key}`;
  return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

export const state = {
  playlists: new Map(),
  folders: new Map(),
  playbackByWorld: {},
  revision: 0,
  queue: Promise.resolve(),
  suspendRefresh: false,
  ready: false,
  stale: false,
};

export function error(key, data) {
  const e = new Error(`[${MODULE_ID}] ${t(`Errors.${key}`, data)}`);
  ui.notifications?.error(e.message);
  return e;
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
