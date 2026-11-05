import { readBounds } from "../audio/bounds.mjs";
import {
  activePreview,
  duckStrength,
  onPreviewChange,
  previewPlaylistSound,
  previewSound,
  previewVolume,
  togglePreview,
} from "../audio/preview.mjs";
import { t } from "../core/context.mjs";
import { decorateDescriptions } from "./description-tooltip.mjs";
import { decorateNames } from "./name-marquee.mjs";
import { decorateSeekWidgets, updateSeekWidgets } from "./seek-widget.mjs";
import { soundChannelIconClass } from "./sound-channel-icon.mjs";

let previewTimer;
let syncingPreviewVolume = false;

export function updatePreviewTime() {
  const sound = previewSound();
  const bounds = readBounds(previewPlaylistSound(), sound?.buffer?.duration ?? sound?.element?.duration);
  const format = foundry.applications.sidebar.tabs.PlaylistDirectory.formatTimestamp;
  const previewUuid = previewPlaylistSound()?.uuid;
  for (const row of document.querySelectorAll(".playlists-sidebar .currently-playing:not(.rn-queue) .sound")) {
    if (row.dataset.soundUuid !== previewUuid || !previewUuid) continue;
    row.querySelector(".current").textContent = format(Math.max(0, (sound?.currentTime ?? 0) - (bounds?.start ?? 0)));
    row.querySelector(".duration").textContent = format(bounds ? bounds.end - bounds.start : (sound?.duration ?? 0));
  }
  updateSeekWidgets();
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
    if (syncingPreviewVolume) return;
    game.settings.set("rn-playlist-companion", "previewVolume", foundry.audio.AudioHelper.inputToVolume(slider.value));
    const tooltip = volumeToPercentage(slider.value);
    slider.dataset.tooltipText = tooltip;
    slider.ariaValueText = volumeToPercentage(slider.value, { label: true });
    game.tooltip.activate(slider, { text: tooltip });
    // Updating sibling sliders can dispatch another change event in Foundry.
    syncingPreviewVolume = true;
    try {
      for (const other of document.querySelectorAll(".playlists-sidebar .rn-preview-slider")) {
        if (other !== slider) {
          if (other.value !== slider.value) other.value = slider.value;
          other.dataset.tooltipText = tooltip;
          other.ariaValueText = slider.ariaValueText;
        }
      }
    } finally {
      syncingPreviewVolume = false;
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
  button.disabled = !playlistSound.isOwner && activePreview() !== playlistSound.uuid;
  button.setAttribute("data-tooltip", "");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePreview(playlistSound);
  });
  controls.append(button);
}

export function syncPreviewWidget(element) {
  const widget = element.querySelector(".currently-playing:not(.rn-queue)");
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
  icon.className = `fa-thin rn-channel-icon ${soundChannelIconClass(playlistSound)}`;
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
  header.append(icon, name, controls);
  const playback = document.createElement("div");
  playback.className = "sound-playback flexrow";
  playback.innerHTML =
    '<div class="sound-timer"><span class="current">0:00</span><span class="sep"> / </span><span class="duration">0:00</span></div><i class="volume-icon fa-fw fa-solid fa-volume-low" inert></i>';
  playback.append(createPreviewVolumeSlider());
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

export function decorateSounds(element) {
  for (const button of element.querySelectorAll(".currently-playing:not(.rn-queue) .rn-preview")) button.remove();
  for (const row of element.querySelectorAll(
    ".currently-playing:not(.rn-queue) .sound[data-playlist-id][data-sound-id]",
  )) {
    if (row.dataset.soundUuid !== activePreview()) continue;
    const controls = row.querySelector(":scope > header > .sound-controls");
    const playlistSound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    if (controls && playlistSound) addPreviewButton(controls, playlistSound);
  }
  for (const row of element.querySelectorAll(".directory-list .sound[data-playlist-id][data-sound-id]")) {
    const controls = row.querySelector(":scope > header > .sound-controls");
    if (!controls) continue;
    const playlistSound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    if (!playlistSound?.path) continue;
    addPreviewButton(controls, playlistSound);
  }
  updatePreviewButtons();
}

export function decoratePreviewVolume(element) {
  const list = element.querySelector(".global-volume ol.plain");
  if (!list) return;
  if (!list.querySelector(".rn-preview-volume")) {
    const row = document.createElement("li");
    row.className = "flexrow rn-preview-volume";
    row.dataset.tooltip = t("UI.PreviewVolumeHint");
    row.innerHTML = `<label>${t("UI.PreviewVolume")}</label><i class="volume-icon fa-fw fa-solid fa-headphones" inert></i>`;
    row.append(createPreviewVolumeSlider());
    list.append(row);
  }
  if (list.querySelector(".rn-duck-volume")) return;
  const row = document.createElement("li");
  row.className = "flexrow rn-duck-volume";
  row.dataset.tooltip = t("UI.DuckMusicHint");
  row.innerHTML = `<label>${t("UI.DuckMusic")}</label><i class="volume-icon fa-fw fa-solid fa-volume-xmark" inert></i>`;
  const slider = foundry.applications.elements.HTMLRangePickerElement.create({
    min: 0,
    max: 100,
    step: 5,
    value: duckStrength(),
  });
  slider.setAttribute("aria-label", t("UI.DuckMusic"));
  const percentage = () => `${Math.round(Number(slider.value))}%`;
  slider.dataset.tooltip = percentage();
  slider.ariaValueText = percentage();
  slider.addEventListener("input", () => {
    const tooltip = percentage();
    slider.dataset.tooltipText = tooltip;
    slider.ariaValueText = tooltip;
    game.tooltip.activate(slider, { text: tooltip });
    game.settings.set("rn-playlist-companion", "duckStrength", Number(slider.value));
  });
  row.append(slider);
  list.append(row);
}

export function registerPreviewWidgetUpdates() {
  onPreviewChange(() => {
    for (const element of document.querySelectorAll(".playlists-sidebar")) {
      syncPreviewWidget(element);
      decorateSeekWidgets(element);
      decorateSounds(element);
      decorateNames(element);
      decorateDescriptions(element);
    }
    updatePreviewButtons();
    clearInterval(previewTimer);
    previewTimer = activePreview() ? setInterval(updatePreviewTime, 1000) : undefined;
    if (activePreview()) updatePreviewTime();
  });
}
