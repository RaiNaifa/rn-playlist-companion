import { MODULE_ID } from "../core/context.mjs";

const SETTING = "hideRestrictedPlaylists";

export function registerPlayerPrivacySetting() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.HideRestrictedPlaylists.Name",
    hint: "RNPLAYCOMP.Settings.HideRestrictedPlaylists.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      for (const app of new Set([ui.playlists, ui.playlists?.popout, ...Object.values(ui.windows ?? {})])) {
        if (app instanceof foundry.applications.sidebar.tabs.PlaylistDirectory) app.render();
      }
    },
  });
}

export function restrictedPlaylist(playlist) {
  if (!game.settings.get(MODULE_ID, SETTING) || game.user.isGM) return false;
  if (typeof playlist.testUserPermission !== "function") playlist = game.playlists.get(playlist.id);
  if (!playlist) return false;
  return !playlist.testUserPermission(game.user, "OBSERVER");
}

export function decorateRestrictedPlaying(element) {
  for (const row of element.querySelectorAll(".currently-playing .sound[data-playlist-id]")) {
    const playlist = game.playlists.get(row.dataset.playlistId);
    row.classList.toggle("rn-restricted-playing", !!playlist && restrictedPlaylist(playlist));
  }
}
