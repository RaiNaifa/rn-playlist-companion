import { registerPreviewSettings } from "./audio/preview.mjs";
import { MODULE_ID, state } from "./core/context.mjs";
import { patchDocumentMethods } from "./foundry/document-bridge.mjs";
import { onSocket } from "./foundry/socket-sync.mjs";
import { reloadGlobalPlaylists } from "./library/global-library.mjs";
import { registerVisibilitySettings } from "./library/visibility.mjs";
import { patchDirectory } from "./ui/playlist-sidebar.mjs";
import { registerSoundWindowSettings } from "./ui/sound-window.mjs";

Hooks.once("init", () => {
  registerVisibilitySettings();
  registerPreviewSettings();
  registerSoundWindowSettings();
  patchDocumentMethods();
  patchDirectory();
});

Hooks.once("ready", async () => {
  try {
    game.socket.on(`module.${MODULE_ID}`, onSocket);
    await reloadGlobalPlaylists({ create: game.user.isGM });
    console.info(`[${MODULE_ID}] Loaded ${state.playlists.size} global playlist(s), revision ${state.revision}.`);
  } catch (e) {
    console.error(`[${MODULE_ID}] Global playlist storage could not be loaded.`, e);
    ui.notifications.error(`${MODULE_ID}: ${e.message}`);
  }
});
