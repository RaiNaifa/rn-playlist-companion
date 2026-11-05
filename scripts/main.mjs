import { installBoundedPlayback } from "./audio/bounded-playback.mjs";
import { registerBufferDurationSettings } from "./audio/buffer-duration.mjs";
import { registerPreviewSettings } from "./audio/preview.mjs";
import { installQueuePlayback } from "./audio/queue.mjs";
import { installRandomPlayback } from "./audio/random-playback.mjs";
import { installSilencePlayback } from "./audio/silence-playback.mjs";
import { MODULE_ID, reportError, state } from "./core/context.mjs";
import { patchDocumentMethods } from "./foundry/document-bridge.mjs";
import { onSocket } from "./foundry/socket-sync.mjs";
import { handleConflicts, registerConflictSettings } from "./library/conflict-controller.mjs";
import { reloadGlobalPlaylists } from "./library/global-library.mjs";
import { registerVisibilitySettings } from "./library/visibility.mjs";
import { registerRevisionControlSetting } from "./storage/revision-control.mjs";
import { registerArchiveSettings } from "./ui/archive-dialog.mjs";
import { registerConfigSavePlayback } from "./ui/config-save-playback.mjs";
import { registerFolderLauncher } from "./ui/folder-launcher.mjs";
import { registerHeaderColor } from "./ui/header-color.mjs";
import { registerMiniPlayerUpdates } from "./ui/mini-player.mjs";
import { registerParameterButtonColors } from "./ui/parameter-button-colors.mjs";
import { registerPlayerPrivacySetting } from "./ui/player-privacy.mjs";
import { registerPlaylistLoop } from "./ui/playlist-loop.mjs";
import { patchDirectory } from "./ui/playlist-sidebar.mjs";
import { registerPlaylistTint } from "./ui/playlist-tint.mjs";
import { registerReleaseNotesSettings, showReleaseNotesAfterUpdate } from "./ui/release-notes.mjs";
import { registerSilenceConfig } from "./ui/silence-config.mjs";
import { registerSoundBounds } from "./ui/sound-bounds.mjs";
import { registerSoundWindowSettings } from "./ui/sound-window.mjs";

Hooks.once("init", () => {
  registerArchiveSettings();
  registerConflictSettings();
  registerVisibilitySettings();
  registerPlayerPrivacySetting();
  registerParameterButtonColors();
  registerHeaderColor();
  registerPreviewSettings();
  registerSoundWindowSettings();
  registerReleaseNotesSettings();
  registerBufferDurationSettings();
  registerSoundBounds();
  registerPlaylistLoop();
  registerPlaylistTint();
  registerSilenceConfig();
  registerConfigSavePlayback();
  registerFolderLauncher();
  registerRevisionControlSetting();
  installBoundedPlayback();
  patchDocumentMethods();
  installRandomPlayback();
  installSilencePlayback();
  installQueuePlayback();
  patchDirectory();
  registerMiniPlayerUpdates();
});

Hooks.once("ready", async () => {
  try {
    game.socket.on(`module.${MODULE_ID}`, onSocket);
    await reloadGlobalPlaylists();
    await handleConflicts();
    console.info(`[${MODULE_ID}] Loaded ${state.playlists.size} global playlist(s), revision ${state.revision}.`);
  } catch (e) {
    reportError(e);
  }
});

Hooks.once("ready", () => {
  showReleaseNotesAfterUpdate().catch(console.error);
});
