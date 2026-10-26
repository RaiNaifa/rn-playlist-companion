import {
  activePreview,
  onPreviewChange,
  previewPlaylistSound,
  previewSound,
  previewVolume,
  togglePreview,
  togglePreviewPause,
} from "../audio/preview.mjs";
import { reportError, t } from "../core/context.mjs";
import { decorateDescriptions } from "./description-tooltip.mjs";
import { decorateNames } from "./name-marquee.mjs";
import { soundChannelIconClass } from "./sound-channel-icon.mjs";

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

export function syncPreviewWidget(element) {
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
    togglePreviewPause().catch(reportError);
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

export function decorateSounds(element) {
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

export function decoratePreviewVolume(element) {
  const list = element.querySelector(".global-volume ol.plain");
  if (!list || list.querySelector(".rn-preview-volume")) return;
  const row = document.createElement("li");
  row.className = "flexrow rn-preview-volume";
  row.innerHTML = `<label>${t("UI.PreviewVolume")}</label><i class="volume-icon fa-fw fa-solid fa-headphones" inert></i>`;
  row.append(createPreviewVolumeSlider());
  list.append(row);
}

export function registerPreviewWidgetUpdates() {
  onPreviewChange(() => {
    for (const element of document.querySelectorAll(".playlists-sidebar")) {
      syncPreviewWidget(element);
      decorateSounds(element);
      decorateNames(element);
      decorateDescriptions(element);
    }
    updatePreviewButtons();
    clearInterval(previewTimer);
    previewTimer = activePreview() ? setInterval(updatePreviewTime, 1000) : undefined;
  });
}
