import { MODULE_ID, reportError, t } from "../core/context.mjs";
import { decorateDirectory } from "./playlist-sidebar.mjs";

let playerCompanion;
// Keep this separate from Foundry's sidebar and retain it when this window is reopened.
let companionVolumeExpanded = false;
let companionPosition = null;
const watchedSounds = new WeakSet();
let transitionDepth = 0;
let transitionGeneration = 0;

export function beginMiniPlayerTransition() {
  transitionDepth++;
  transitionGeneration++;
}

export function endMiniPlayerTransition() {
  if (transitionDepth > 0) transitionDepth--;
  if (transitionDepth === 0) refreshMiniPlayer();
}

function needsPlayingRefresh(element) {
  const widget = element?.querySelector(".currently-playing:not(.rn-queue)");
  if (!widget) return false;
  const expected = new Set();
  for (const playlist of game.playlists) {
    for (const entry of playlist.sounds) {
      if (entry.sound && !entry.sound.failed && (entry.playing || entry.pausedTime != null)) {
        expected.add(entry.uuid);
      }
    }
  }
  const shown = new Set(
    [...widget.querySelectorAll(".sound[data-sound-uuid]:not(.rn-preview-playing)")].map(
      (row) => row.dataset.soundUuid,
    ),
  );
  return (
    widget.hidden !== (expected.size === 0) ||
    expected.size !== shown.size ||
    [...expected].some((uuid) => !shown.has(uuid))
  );
}

function watchSoundStarts() {
  if (!playerCompanion?.directory?.rendered) return;
  for (const playlist of game.playlists) {
    for (const entry of playlist.sounds) {
      const sound = entry.playing && entry.sound;
      // A Playlist update can arrive before its audio finishes loading and starts playback.
      if (!sound || sound.playing || watchedSounds.has(sound)) continue;
      watchedSounds.add(sound);
      sound.addEventListener(
        "play",
        () => {
          watchedSounds.delete(sound);
          refreshMiniPlayer();
        },
        { once: true },
      );
    }
  }
}

export function refreshMiniPlayer() {
  const directory = playerCompanion?.directory;
  // Foundry builds the playing-sound list while preparing the directory part.
  if (directory?.rendered && transitionDepth === 0) {
    directory.render({ parts: ["controls", "directory", "playing"] }).catch(reportError);
  }
  watchSoundStarts();
}

export function openMiniPlayer() {
  if (playerCompanion) {
    if (playerCompanion.rendered) playerCompanion.bringToFront();
    return;
  }
  const Application = foundry.applications.api.ApplicationV2;
  const Directory = foundry.applications.sidebar.tabs.PlaylistDirectory;
  const DirectoryBase = Object.getPrototypeOf(Directory.prototype);
  class CompanionDirectory extends Directory {
    // Foundry uses tabName as the element ID; it must differ from both existing applications.
    static tabName = "rn-player-companion-directory";

    _volumeExpanded = companionVolumeExpanded;
    host = null;
    #timestampInterval = null;
    #renderedOnce = false;

    get active() {
      // Foundry hides sidebar tabs without the active class, even outside its sidebar.
      return true;
    }

    render(options, legacyOptions) {
      // Keep the last visible state until a queued switch has completed.
      if (this.rendered && transitionDepth > 0) return Promise.resolve(this);
      const request = typeof options === "boolean" ? { ...legacyOptions, force: options } : { ...options };
      request.rnTransitionGeneration = transitionGeneration;
      return super.render(request);
    }

    _replaceHTML(result, content, options) {
      // An older render may finish after a switch begins or even after it ends.
      if (this.#renderedOnce && (transitionDepth > 0 || options.rnTransitionGeneration !== transitionGeneration)) {
        options.parts = [];
        return;
      }
      super._replaceHTML(result, content, options);
    }

    async _onFirstRender(...args) {
      // PlaylistDirectory starts an interval without retaining its handle. Run its parent hook instead.
      await DirectoryBase._onFirstRender.call(this, ...args);
      this.#timestampInterval = setInterval(() => this.updateTimestamps(), 1000);
    }

    async close(options) {
      clearInterval(this.#timestampInterval);
      this.#timestampInterval = null;
      return super.close(options);
    }

    _configureRenderOptions(options) {
      super._configureRenderOptions(options);
      // PlaylistDirectory refreshes _playing only while preparing the directory part.
      // A playing-only render can otherwise hide an already playing queued sound.
      if (options.parts?.includes("playing") && !options.parts.includes("directory")) {
        options.parts.splice(options.parts.indexOf("playing"), 0, "directory");
      }
    }

    _insertElement(element) {
      // The default insertion targets document.body, leaving the companion window empty.
      this.host.replaceChildren(element);
    }

    updateTimestamps() {
      super.updateTimestamps();
      // Foundry's one-second ticker also repairs missed or out-of-order playback renders.
      if (this.rendered && needsPlayingRefresh(this.element)) {
        this.render({ parts: ["directory", "playing"] }).catch(reportError);
      }
    }

    async _onRender(...args) {
      await super._onRender(...args);
      this.element?.classList.add("rn-player-companion", "playlists-sidebar");
      decorateDirectory(this);
      this.#renderedOnce = true;
    }
  }

  class PlayerCompanion extends Application {
    static DEFAULT_OPTIONS = {
      id: "rn-player-companion-window",
      classes: ["rn-player-companion-window"],
      window: { frame: true, resizable: true, title: t("UI.MiniPlayer") },
    };

    directory = null;

    async _renderHTML() {
      const host = document.createElement("div");
      host.className = "rn-player-companion-host";
      return host;
    }

    _replaceHTML(result, content) {
      content.replaceChildren(result);
    }

    async _onRender(...args) {
      await super._onRender(...args);
      if (this.directory) return;
      // Render a distinct tab inside this window; reusing the sidebar tab would move it.
      this.directory = new CompanionDirectory();
      this.directory.host = this.element.querySelector(".rn-player-companion-host");
      await this.renderChild(this.directory, { force: true });
      if (companionPosition) this.setPosition(companionPosition);
    }

    async close(options) {
      if (this.directory) companionVolumeExpanded = this.directory._volumeExpanded;
      if (this.rendered) {
        const { left, top } = this.position;
        companionPosition = { left, top };
      }
      // ApplicationV2 only unlinks children in the main window. Close the tab ourselves.
      await this.directory?.close({ animate: false });
      await super.close(options);
      if (playerCompanion === this) playerCompanion = null;
    }
  }
  playerCompanion = new PlayerCompanion();
  playerCompanion.render({ force: true }).catch((cause) => {
    playerCompanion = null;
    reportError(cause);
  });
}

export function toggleMiniPlayer() {
  if (playerCompanion) {
    playerCompanion.close().catch(reportError);
  } else {
    openMiniPlayer();
  }
}

export function registerMiniPlayerKeybinding() {
  game.keybindings.register(MODULE_ID, "toggleMiniPlayer", {
    name: "RNPLAYCOMP.UI.ToggleMiniPlayer",
    editable: [{ key: "KeyP" }],
    onDown: () => {
      toggleMiniPlayer();
      return true;
    },
  });
}

export function decorateMiniPlayerButton(element) {
  if (element.classList.contains("rn-player-companion")) return;
  const footer = element.querySelector(":scope > .directory-footer");
  if (!footer) return;
  element.querySelector(".rn-mini-player-button")?.remove();
  const create =
    element.querySelector('header.directory-header [data-action="createPlaylist"]') ??
    element.querySelector("header.directory-header button");
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${create?.className ?? ""} rn-mini-player-button`;
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-window-restore";
  icon.setAttribute("aria-hidden", "true");
  button.append(icon, document.createTextNode(` ${t("UI.OpenMiniPlayer")}`));
  button.addEventListener("click", openMiniPlayer);
  footer.append(button);
}

export function registerMiniPlayerUpdates() {
  for (const hook of [
    "createPlaylist",
    "updatePlaylist",
    "deletePlaylist",
    "createPlaylistSound",
    "updatePlaylistSound",
    "deletePlaylistSound",
  ]) {
    Hooks.on(hook, refreshMiniPlayer);
  }
}
