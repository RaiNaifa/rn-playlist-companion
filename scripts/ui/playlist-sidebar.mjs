import { duckMusic } from "../audio/preview.mjs";
import { error, isGlobal, isGlobalFolder, reportError, state, t } from "../core/context.mjs";
import { folderBranch, moveBranchToGlobal, moveBranchToLocal, removeGlobal } from "../library/global-library.mjs";
import { filterHiddenTree, hiddenIds, isHidden, setHidden } from "../library/visibility.mjs";
import { decorateDescriptions, registerDescriptionTooltipUpdates } from "./description-tooltip.mjs";
import { decorateNames } from "./name-marquee.mjs";
import { decorateRestrictedPlaying, restrictedPlaylist } from "./player-privacy.mjs";
import { patchPlayingTimer } from "./playing-timer.mjs";
import {
  decoratePreviewVolume,
  decorateSounds,
  registerPreviewWidgetUpdates,
  syncPreviewWidget,
} from "./preview-widget.mjs";
import { decorateSoundChannelIcons } from "./sound-channel-icon.mjs";
import { mountSoundWindows, patchSoundWindows, searchActive } from "./sound-window.mjs";

const uiState = { open: false, editing: false, showHidden: false };
export function folderForDrop(target, sourceType) {
  if (!target) return null;
  if (target.matches(".folder")) {
    const folder = game.folders.get(target.dataset.folderId);
    return sourceType === "Playlist" || target.classList.contains("expanded")
      ? folder?.id
      : (folder?._source.folder ?? null);
  }
  if (target.dataset.entryId) return game.playlists.get(target.dataset.entryId)?._source.folder ?? null;
  return target.closest(".folder")?.dataset.folderId ?? null;
}

export async function handleDrop(app, original, event) {
  const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  if (!["Playlist", "Folder"].includes(data.type)) return original.call(app, event);
  const document = await foundry.utils.fromUuid(data.uuid);
  if (!document || (data.type === "Folder" && document.type !== "Playlist")) return original.call(app, event);
  const target = event.target.closest(".directory-item");
  const destination = folderForDrop(target, data.type);
  const inWorld =
    data.type === "Folder" ? game.folders.get(document.id) === document : game.playlists.get(document.id) === document;
  if (!inWorld && isGlobalFolder(game.folders.get(destination))) {
    throw error("ImportFirst");
  }
  if (!inWorld) return original.call(app, event);
  if (document.id === destination) return;
  if (data.type === "Folder" && destination) {
    const descendants = folderBranch(document.id, isGlobalFolder(document)).folders;
    if (descendants.some((folder) => folder.id === destination)) return;
  }
  const sourceGlobal = data.type === "Folder" ? isGlobalFolder(document) : isGlobal(document);
  const destGlobal = isGlobalFolder(game.folders.get(destination));
  if (!sourceGlobal && destGlobal) return moveBranchToGlobal(document, destination);
  if (sourceGlobal && destination && !destGlobal) return moveBranchToLocal(document, destination);
  // Dropping a global item at the root keeps it global.
  // Foundry calculates the new sort positions. Document patches save them to global storage.
  if (sourceGlobal) return original.call(app, event);
  return original.call(app, event);
}

function contextOption(options, { label, icon, visible, onClick }) {
  if (options.some((option) => "name" in option)) {
    return {
      name: label,
      icon: `<i class="${icon}"></i>`,
      condition: visible,
      callback: (header) => onClick(null, header),
    };
  }
  return { label, icon, visible, onClick };
}

function hideNativeOption(option, visible) {
  const key = "name" in option ? "condition" : "visible";
  const original = option[key];
  option[key] = (header) => visible(header) && (typeof original === "function" ? original(header) : original !== false);
}

export function addMoveMenu(options, kind) {
  const getDocument = (header) => {
    const li = header.closest(".directory-item");
    return kind === "folder" ? game.folders.get(li?.dataset.folderId) : game.playlists.get(li?.dataset.entryId);
  };
  options.push(
    contextOption(options, {
      label: t("UI.MakeGlobal"),
      icon: "fa-solid fa-globe",
      visible: (header) =>
        game.user.isGM &&
        !!getDocument(header) &&
        !(kind === "folder" ? isGlobalFolder(getDocument(header)) : isGlobal(getDocument(header))),
      onClick: async (_event, header) => {
        try {
          await moveBranchToGlobal(getDocument(header));
        } catch (e) {
          reportError(e);
        }
      },
    }),
    contextOption(options, {
      label: t("UI.MakeLocal"),
      icon: "fa-solid fa-house",
      visible: (header) =>
        game.user.isGM &&
        !!getDocument(header) &&
        (kind === "folder" ? isGlobalFolder(getDocument(header)) : isGlobal(getDocument(header))),
      onClick: async (_event, header) => {
        try {
          await moveBranchToLocal(getDocument(header));
        } catch (e) {
          reportError(e);
        }
      },
    }),
  );
}

function stateMark(kind, icon, label) {
  const mark = document.createElement("span");
  mark.className = `rn-${kind}-mark rn-state-mark`;
  mark.setAttribute("data-tooltip", "");
  mark.setAttribute("aria-label", t(label));
  const glyph = document.createElement("i");
  glyph.className = `fa-light fa-${icon}`;
  glyph.setAttribute("aria-hidden", "true");
  mark.append(glyph);
  return mark;
}

export function decorateDirectory(app) {
  const element = app.element;
  if (!element) return;
  syncPreviewWidget(element);
  decorateRestrictedPlaying(element);
  mountSoundWindows(app, element, () => {
    decorateSounds(element);
    decorateSoundChannelIcons(element);
    decorateNames(element);
    decorateDescriptions(element);
  });
  decorateSounds(element);
  decorateSoundChannelIcons(element);
  decorateNames(element);
  decorateDescriptions(element);
  decoratePreviewVolume(element);
  for (const li of element.querySelectorAll(
    ".directory-item.playlist[data-entry-id], .directory-item.folder[data-folder-id]",
  )) {
    const folder = li.classList.contains("folder");
    const id = folder ? li.dataset.folderId : li.dataset.entryId;
    const global = folder ? state.folders.has(id) : state.playlists.has(id);
    const item = folder ? game.folders.get(id) : game.playlists.get(id);
    const hidden = isHidden(item);
    const name = li.querySelector(
      folder ? ":scope > .folder-header .folder-name" : ":scope > .playlist-header .playlist-name",
    );
    if (!name) continue;
    name.parentElement.querySelector(":scope > .rn-global-mark")?.remove();
    name.parentElement.querySelector(":scope > .rn-move")?.remove();
    name.parentElement.querySelector(":scope > .rn-visibility")?.remove();
    name.parentElement.querySelector(":scope > .rn-hidden-mark")?.remove();
    if (game.user.isGM && uiState.editing) {
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "rn-visibility";
      eye.setAttribute("data-tooltip", "");
      eye.setAttribute("aria-label", t(`UI.${hidden ? "Show" : "Hide"}`));
      eye.setAttribute("aria-pressed", String(hidden));
      const eyeGlyph = document.createElement("i");
      eyeGlyph.className = `fa-solid ${hidden ? "fa-eye-slash" : "fa-eye"}`;
      eyeGlyph.setAttribute("aria-hidden", "true");
      eye.append(eyeGlyph);
      eye.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await setHidden(item, !hidden);
        } catch (e) {
          reportError(e);
        }
      });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rn-move";
      button.setAttribute("data-tooltip", "");
      button.setAttribute("aria-label", t(`UI.${global ? "MakeLocal" : "MakeGlobal"}`));
      const glyph = document.createElement("i");
      glyph.className = `fa-solid ${global ? "fa-globe" : "fa-house"}`;
      glyph.setAttribute("aria-hidden", "true");
      button.append(glyph);
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const item = folder ? game.folders.get(id) : game.playlists.get(id);
          if (global) await moveBranchToLocal(item);
          else await moveBranchToGlobal(item);
        } catch (e) {
          reportError(e);
        }
      });
      name.before(eye, button);
    } else {
      if (hidden) name.before(stateMark("hidden", "eye-slash", "UI.HiddenHint"));
      if (!global) continue;
      name.before(stateMark("global", "globe", "UI.GlobalHint"));
    }
  }
  const volume = element.querySelector(".global-volume");
  if (!volume) return;
  const existing = element.querySelector(".rn-global-panel");
  if (existing) {
    existing.classList.toggle("expanded", uiState.open);
    const edit = existing.querySelector(".rn-edit-toggle");
    const showHidden = existing.querySelector(".rn-show-hidden");
    if (edit) edit.checked = uiState.editing;
    if (showHidden) showHidden.checked = uiState.showHidden;
    existing.querySelector(".rn-duck-option").checked = duckMusic();
    return;
  }
  const panel = document.createElement("div");
  panel.className = `rn-global-panel global-control ${uiState.open ? "expanded" : ""}`;
  const management = game.user.isGM
    ? `<li><label class="rn-toggle-row"><span>${t("UI.ManagementMode")}</span><input type="checkbox" class="rn-toggle-input rn-edit-toggle" ${uiState.editing ? "checked" : ""}></label></li>
      <li><label class="rn-toggle-row"><span>${t("UI.ShowHidden")}</span><input type="checkbox" class="rn-toggle-input rn-show-hidden" ${uiState.showHidden ? "checked" : ""}></label></li>`
    : "";
  panel.innerHTML = `<header class="playlist-header"><i class="expand fa-solid fa-angle-up" inert></i><strong>Playlist Companion</strong></header>
    <div class="expandable"><div class="wrapper"><ol class="plain">${management}<li>
      <label class="rn-toggle-row"><span>${t("UI.DuckMusic")}</span><input type="checkbox" class="rn-toggle-input rn-duck-option" ${duckMusic() ? "checked" : ""}></label>
    </li></ol></div></div>`;
  panel.querySelector("header").addEventListener("click", () => {
    uiState.open = !uiState.open;
    panel.classList.toggle("expanded", uiState.open);
  });
  panel.querySelector(".rn-edit-toggle")?.addEventListener("change", (event) => {
    uiState.editing = event.currentTarget.checked;
    decorateDirectory(app);
  });
  panel.querySelector(".rn-show-hidden")?.addEventListener("change", (event) => {
    uiState.showHidden = event.currentTarget.checked;
    app.render({ parts: ["directory"] });
  });
  panel.querySelector(".rn-duck-option").addEventListener("change", (event) => {
    game.settings.set("rn-playlist-companion", "duckMusic", event.currentTarget.checked);
  });
  volume.before(panel);
}

export function patchDirectory() {
  registerDescriptionTooltipUpdates();
  registerPreviewWidgetUpdates();
  Hooks.on("updatePlaylistSound", (_sound, changes) => {
    if (!Object.hasOwn(changes, "channel")) return;
    for (const element of document.querySelectorAll(".playlists-sidebar")) decorateSoundChannelIcons(element);
  });
  Hooks.on("updatePlaylist", (_playlist, changes) => {
    if (!Object.hasOwn(changes, "channel")) return;
    for (const element of document.querySelectorAll(".playlists-sidebar")) decorateSoundChannelIcons(element);
  });
  const Directory = foundry.applications.sidebar.tabs.PlaylistDirectory;
  patchSoundWindows(Directory);
  patchPlayingTimer(Directory);
  const prepareDirectory = Directory.prototype._prepareDirectoryContext;
  Directory.prototype._prepareDirectoryContext = async function (context, options) {
    await prepareDirectory.call(this, context, options);
    const playingIds = new Set(
      game.playlists
        .filter((playlist) => playlist.playing || [...playlist.sounds].some((sound) => sound.playing))
        .map((p) => p.id),
    );
    context.tree = filterHiddenTree(context.tree, {
      ...hiddenIds(),
      playingIds,
      showHidden: game.user.isGM && (uiState.showHidden || searchActive(this)),
    });
    const removeRestricted = (node) => {
      if (!node) return null;
      const entries = node.entries.filter((entry) => {
        const playlist = game.playlists.get(entry.id);
        return !playlist || !restrictedPlaylist(playlist);
      });
      const children = node.children.map(removeRestricted).filter(Boolean);
      return entries.length || children.length || !node.folder ? { ...node, entries, children } : null;
    };
    context.tree = removeRestricted(context.tree);
  };
  const original = Directory.prototype._onDrop;
  Directory.prototype._onDrop = async function (event) {
    try {
      return await handleDrop(this, original, event);
    } catch (cause) {
      reportError(cause);
    }
  };
  Hooks.on("getPlaylistContextOptions", (_app, options) => {
    const deletion = options.find((option) => (option.label ?? option.name) === "SIDEBAR.Delete");
    if (deletion) {
      hideNativeOption(deletion, (header) => {
        const playlist = game.playlists.get(header.closest(".directory-item")?.dataset.entryId);
        return !isGlobal(playlist);
      });
    }
    addMoveMenu(options, "playlist");
    options.push(
      contextOption(options, {
        label: t("UI.DeleteEverywhere"),
        icon: "fa-solid fa-trash",
        visible: (header) =>
          game.user.isGM && isGlobal(game.playlists.get(header.closest(".directory-item")?.dataset.entryId)),
        onClick: async (_event, header) => {
          const playlist = game.playlists.get(header.closest(".directory-item")?.dataset.entryId);
          if (!playlist) return;
          const yes = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("UI.DeleteGlobalPlaylist") },
            content: `<p class="rn-confirm-message">${foundry.utils.escapeHTML(t("UI.DeleteGlobalPlaylistConfirm", { name: playlist.name }))}</p>`,
            yes: { label: t("UI.DeleteEverywhere") },
          });
          if (yes) {
            try {
              await removeGlobal(playlist.id);
            } catch (cause) {
              reportError(cause);
            }
          }
        },
      }),
    );
  });
  Hooks.on("getFolderContextOptions", (app, options) => {
    if (app.documentName !== "Playlist") return;
    for (const option of options) {
      if (!["FOLDER.Remove", "FOLDER.Delete"].includes(option.label ?? option.name)) continue;
      hideNativeOption(option, (header) => {
        const folder = game.folders.get(header.closest(".directory-item")?.dataset.folderId);
        return !isGlobalFolder(folder);
      });
    }
    addMoveMenu(options, "folder");
    options.push(
      contextOption(options, {
        label: t("UI.DeleteEverywhere"),
        icon: "fa-solid fa-trash",
        visible: (header) =>
          game.user.isGM && isGlobalFolder(game.folders.get(header.closest(".directory-item")?.dataset.folderId)),
        onClick: async (_event, header) => {
          const folder = game.folders.get(header.closest(".directory-item")?.dataset.folderId);
          try {
            await folder?.delete();
          } catch (e) {
            reportError(e);
          }
        },
      }),
    );
  });
  Hooks.on("renderPlaylistDirectory", (app) => decorateDirectory(app));
}
