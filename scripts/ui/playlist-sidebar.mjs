import {
  activePreview,
  duckMusic,
  onPreviewChange,
  previewPlaylistSound,
  previewSound,
  previewVolume,
  togglePreview,
  togglePreviewPause,
} from "../audio/preview.mjs";
import { error, isGlobal, isGlobalFolder, state, t } from "../core/context.mjs";
import { folderBranch, moveBranchToGlobal, moveBranchToLocal, removeGlobal } from "../library/global-library.mjs";
import { filterHiddenTree, hiddenIds, isHidden, setHidden } from "../library/visibility.mjs";
import { decorateSoundNames } from "./sound-marquee.mjs";
import { mountSoundWindows, patchSoundWindows, searchActive } from "./sound-window.mjs";

const uiState = { open: false, editing: false, showHidden: false };
let previewTimer;

function updatePreviewTime() {
  const sound = previewSound();
  const format = foundry.applications.sidebar.tabs.PlaylistDirectory.formatTimestamp;
  for (const row of document.querySelectorAll(".playlists-sidebar .rn-preview-playing")) {
    row.querySelector(".current").textContent = format(sound?.currentTime ?? 0);
    row.querySelector(".duration").textContent = format(sound?.duration ?? 0);
  }
}

function createPreviewVolumeSlider() {
  const slider = foundry.applications.elements.HTMLRangePickerElement.create({
    min: 0,
    max: 1,
    step: 0.05,
    value: foundry.audio.AudioHelper.volumeToInput(previewVolume()),
  });
  slider.classList.add("rn-preview-slider");
  slider.setAttribute("aria-label", t("UI.PreviewVolume"));
  const { volumeToPercentage } = foundry.audio.AudioHelper;
  slider.dataset.tooltip = volumeToPercentage(slider.value);
  slider.ariaValueText = volumeToPercentage(slider.value, { label: true });
  slider.addEventListener("change", () => {
    game.settings.set("rn-playlist-companion", "previewVolume", foundry.audio.AudioHelper.inputToVolume(slider.value));
    const tooltip = volumeToPercentage(slider.value);
    slider.dataset.tooltipText = tooltip;
    slider.ariaValueText = volumeToPercentage(slider.value, { label: true });
    game.tooltip.activate(slider, { text: tooltip });
    for (const other of document.querySelectorAll(".playlists-sidebar .rn-preview-slider")) {
      if (other !== slider) {
        other.value = slider.value;
        other.dataset.tooltipText = tooltip;
        other.ariaValueText = slider.ariaValueText;
      }
    }
  });
  return slider;
}

function addPreviewButton(controls, playlistSound) {
  if (controls.querySelector(".rn-preview")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inline-control sound-control icon fa-solid fa-headphones rn-preview";
  button.dataset.soundUuid = playlistSound.uuid;
  button.setAttribute("data-tooltip", "");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePreview(playlistSound);
  });
  controls.append(button);
}

function syncPreviewWidget(element) {
  const widget = element.querySelector(".currently-playing");
  const list = widget?.querySelector(".playlist-sounds");
  if (!list) return;
  list.querySelector(".rn-preview-playing")?.remove();
  const playlistSound = previewPlaylistSound();
  if (!playlistSound) {
    widget.hidden = !list.querySelector(".sound");
    return;
  }
  const nativeRow = [...list.querySelectorAll(".sound")].find((row) => row.dataset.soundUuid === playlistSound.uuid);
  if (nativeRow) {
    widget.hidden = false;
    return;
  }
  const row = document.createElement("li");
  row.className = "sound rn-preview-playing";
  row.dataset.playlistId = playlistSound.parent.id;
  row.dataset.soundId = playlistSound.id;
  row.dataset.soundUuid = playlistSound.uuid;
  const header = document.createElement("header");
  const icon = document.createElement("i");
  icon.className = "fa-thin fa-music";
  icon.setAttribute("inert", "");
  const name = document.createElement("label");
  name.className = "ellipsis";
  name.textContent = playlistSound.name;
  const controls = document.createElement("div");
  controls.className = "sound-controls flexrow";
  if (playlistSound.isOwner) {
    const repeat = document.createElement("button");
    repeat.type = "button";
    repeat.className = `inline-control sound-control icon fa-solid fa-arrows-rotate${playlistSound.repeat ? "" : " inactive"}`;
    repeat.dataset.action = "soundRepeat";
    repeat.setAttribute("data-tooltip", "");
    repeat.setAttribute("aria-label", game.i18n.localize("PLAYLIST.SoundLoop"));
    controls.append(repeat);
  }
  const play = document.createElement("button");
  play.type = "button";
  play.className = `inline-control sound-control icon fa-solid ${playlistSound.playing ? "fa-square" : "fa-play"}`;
  play.dataset.action = playlistSound.playing ? "soundStop" : "soundPlay";
  play.setAttribute("data-tooltip", "");
  play.setAttribute(
    "aria-label",
    game.i18n.localize(playlistSound.playing ? "PLAYLIST.SoundStop" : "PLAYLIST.SoundPlay"),
  );
  if (!playlistSound.isOwner) play.disabled = true;
  controls.append(play);
  addPreviewButton(controls, playlistSound);
  header.append(icon, name, controls);
  const playback = document.createElement("div");
  playback.className = "sound-playback flexrow";
  playback.innerHTML =
    '<div class="sound-timer"><span class="current">0:00</span><span class="sep"> / </span><span class="duration">0:00</span></div><i class="volume-icon fa-fw fa-solid fa-volume-low" inert></i>';
  playback.append(createPreviewVolumeSlider());
  const pause = document.createElement("button");
  pause.type = "button";
  pause.className = `inline-control sound-control pause icon fa-solid fa-${previewSound()?.playing ? "pause" : "play"}`;
  pause.setAttribute("data-tooltip", "");
  pause.setAttribute("aria-label", game.i18n.localize("PLAYLIST.SoundPause"));
  pause.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePreviewPause().catch(console.error);
  });
  playback.append(pause);
  row.append(header, playback);
  list.append(row);
  widget.hidden = false;
  updatePreviewTime();
}

function updatePreviewButtons() {
  for (const button of document.querySelectorAll(".playlists-sidebar .rn-preview")) {
    const active = button.dataset.soundUuid === activePreview();
    button.classList.toggle("rn-previewing", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", t(`UI.${active ? "StopPreview" : "Preview"}`));
  }
}

function decorateSounds(element) {
  for (const row of element.querySelectorAll(
    ".directory-list .sound[data-playlist-id][data-sound-id], .currently-playing .sound[data-playlist-id][data-sound-id]",
  )) {
    const controls = row.querySelector(":scope > header > .sound-controls");
    if (!controls) continue;
    const playlistSound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    if (!playlistSound?.path) continue;
    addPreviewButton(controls, playlistSound);
  }
  updatePreviewButtons();
}

function decoratePreviewVolume(element) {
  const list = element.querySelector(".global-volume ol.plain");
  if (!list || list.querySelector(".rn-preview-volume")) return;
  const row = document.createElement("li");
  row.className = "flexrow rn-preview-volume";
  row.innerHTML = `<label>${t("UI.PreviewVolume")}</label><i class="volume-icon fa-fw fa-solid fa-headphones" inert></i>`;
  row.append(createPreviewVolumeSlider());
  list.append(row);
}

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
  // Foundry calculates the new sort positions; document patches save them to global storage.
  if (sourceGlobal) return original.call(app, event);
  return original.call(app, event);
}

export function addMoveMenu(options, kind) {
  const getDocument = (header) => {
    const li = header.closest(".directory-item");
    return kind === "folder" ? game.folders.get(li?.dataset.folderId) : game.playlists.get(li?.dataset.entryId);
  };
  options.push(
    {
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
          console.error(e);
        }
      },
    },
    {
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
          console.error(e);
        }
      },
    },
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
  mountSoundWindows(app, element, () => {
    decorateSounds(element);
    decorateSoundNames(element);
  });
  decorateSounds(element);
  decorateSoundNames(element);
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
          console.error(e);
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
          console.error(e);
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
  onPreviewChange(() => {
    for (const element of document.querySelectorAll(".playlists-sidebar")) {
      syncPreviewWidget(element);
      decorateSounds(element);
      decorateSoundNames(element);
    }
    updatePreviewButtons();
    clearInterval(previewTimer);
    previewTimer = activePreview() ? setInterval(updatePreviewTime, 1000) : undefined;
  });
  const Directory = foundry.applications.sidebar.tabs.PlaylistDirectory;
  patchSoundWindows(Directory);
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
  };
  const original = Directory.prototype._onDrop;
  Directory.prototype._onDrop = function (event) {
    return handleDrop(this, original, event);
  };
  Hooks.on("getPlaylistContextOptions", (_app, options) => {
    const deletion = options.find((option) => option.label === "SIDEBAR.Delete");
    if (deletion) {
      const originalVisible = deletion.visible;
      deletion.visible = (header) => {
        const playlist = game.playlists.get(header.closest(".directory-item")?.dataset.entryId);
        return (
          !isGlobal(playlist) && (typeof originalVisible === "function" ? originalVisible(header) : originalVisible)
        );
      };
    }
    addMoveMenu(options, "playlist");
    options.push({
      label: t("UI.DeleteEverywhere"),
      icon: "fa-solid fa-trash",
      visible: (header) =>
        game.user.isGM && isGlobal(game.playlists.get(header.closest(".directory-item")?.dataset.entryId)),
      onClick: async (_event, header) => {
        const playlist = game.playlists.get(header.closest(".directory-item")?.dataset.entryId);
        if (!playlist) return;
        const yes = await foundry.applications.api.DialogV2.confirm({
          window: { title: t("UI.DeleteGlobalPlaylist") },
          content: `<p>${foundry.utils.escapeHTML(t("UI.DeleteGlobalPlaylistConfirm", { name: playlist.name }))}</p>`,
          yes: { label: t("UI.DeleteEverywhere") },
        });
        if (yes) await removeGlobal(playlist.id);
      },
    });
  });
  Hooks.on("getFolderContextOptions", (app, options) => {
    if (app.documentName !== "Playlist") return;
    for (const option of options) {
      if (!["FOLDER.Remove", "FOLDER.Delete"].includes(option.label)) continue;
      const originalVisible = option.visible;
      option.visible = (header) => {
        const folder = game.folders.get(header.closest(".directory-item")?.dataset.folderId);
        return (
          !isGlobalFolder(folder) && (typeof originalVisible === "function" ? originalVisible(header) : originalVisible)
        );
      };
    }
    addMoveMenu(options, "folder");
    options.push({
      label: t("UI.DeleteEverywhere"),
      icon: "fa-solid fa-trash",
      visible: (header) =>
        game.user.isGM && isGlobalFolder(game.folders.get(header.closest(".directory-item")?.dataset.folderId)),
      onClick: async (_event, header) => {
        const folder = game.folders.get(header.closest(".directory-item")?.dataset.folderId);
        try {
          await folder?.delete();
        } catch (e) {
          console.error(e);
        }
      },
    });
  });
  Hooks.on("renderPlaylistDirectory", (app) => decorateDirectory(app));
}
