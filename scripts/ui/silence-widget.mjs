import { pendingSilence } from "../audio/silence-data.mjs";
import { reportError, t } from "../core/context.mjs";
import { restrictedPlaylist } from "./player-privacy.mjs";

function format(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function refreshTimes(element) {
  for (const row of element.querySelectorAll(".rn-silence-playing")) {
    const playlist = game.playlists.get(row.dataset.playlistId);
    const pending = pendingSilence(playlist);
    const item = row.dataset.soundId ? pending?.repeats?.[row.dataset.soundId] : pending?.tracks;
    if (!item || item.id !== row.dataset.pendingId) {
      row.remove();
      continue;
    }
    const elapsed = Math.min(item.durationMs, Math.max(0, Date.now() - item.startedAt));
    row.querySelector(".rn-silence-current").textContent = format(elapsed / 1000);
    row.querySelector(".rn-silence-duration").textContent = format(item.durationMs / 1000);
    row.querySelector(".rn-silence-progress").style.width =
      `${item.durationMs ? (elapsed / item.durationMs) * 100 : 100}%`;
  }
}

function makeRow(playlist, item, soundId = null) {
  const row = document.createElement("li");
  row.className = "sound rn-silence-playing";
  row.dataset.playlistId = playlist.id;
  row.dataset.pendingId = item.id;
  if (soundId) row.dataset.soundId = soundId;
  const title = soundId ? (playlist.sounds.get(soundId)?.name ?? playlist.name) : playlist.name;
  row.innerHTML = `<header><i class="fa-thin ${soundId ? "fa-music" : "fa-list-music"}" aria-hidden="true"></i><label class="ellipsis"></label><div class="sound-controls flexrow"></div></header>
    <div class="sound-playback flexrow rn-silence-details"><div class="sound-timer"><span class="rn-silence-current">0:00</span><span class="sep"> / </span><span class="rn-silence-duration"></span></div><span class="rn-silence-label">${t("Silence.Title")}</span><div class="rn-silence-track"><div class="rn-silence-progress"></div></div></div>`;
  row.querySelector("header label").textContent = restrictedPlaylist(playlist) ? "" : title;
  const controls = row.querySelector(".sound-controls");
  const action = (icon, label, callback) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `inline-control sound-control icon fa-solid ${icon}`;
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      callback().catch(reportError);
    });
    controls.append(button);
  };
  if (!playlist.isOwner) return row;
  if (!soundId) {
    action("fa-backward", t("Silence.Previous"), () => playlist.playNext(item.soundId, { direction: -1 }));
    action("fa-forward", t("Silence.Next"), () => playlist.playNext(item.soundId));
    action("fa-stop", t("Silence.Stop"), () => playlist.stopAll());
  } else {
    action("fa-stop", t("Silence.StopSound"), () => playlist.stopSound(playlist.sounds.get(soundId)));
  }
  return row;
}

function pendingEntries() {
  const entries = [];
  for (const playlist of game.playlists) {
    const pending = pendingSilence(playlist);
    if (pending?.tracks) entries.push([playlist, pending.tracks]);
    for (const [soundId, item] of Object.entries(pending?.repeats ?? {})) {
      if (item && playlist.sounds.get(soundId)) entries.push([playlist, item, soundId]);
    }
  }
  return entries;
}

export function decorateSilenceWidget(element, entries = pendingEntries()) {
  let widget = element.querySelector(".currently-playing");
  if (!widget && entries.length) {
    widget = document.createElement("section");
    widget.className = "currently-playing rn-silence-only expanded";
    widget.innerHTML = `<header class="playlist-header"><strong>${t("Silence.CurrentlyPlaying")}</strong></header><div class="expandable"><div class="wrapper"><ol class="playlist-sounds plain"></ol></div></div>`;
    element.querySelector(".directory-list")?.before(widget);
    if (!widget.isConnected) element.prepend(widget);
  }
  if (!widget) return;
  const list = widget.querySelector(":scope > .playlist-sounds, :scope > .expandable .playlist-sounds");
  if (!list) return;
  for (const row of list.querySelectorAll(".rn-silence-playing")) row.remove();
  for (const [playlist, item, soundId] of entries) list.append(makeRow(playlist, item, soundId));
  if (!entries.length) {
    if (widget.classList.contains("rn-silence-only")) widget.remove();
    else if (!list.querySelector(".sound")) widget.hidden = true;
  } else {
    widget.hidden = false;
    refreshTimes(element);
  }
}

export function registerSilenceWidgetTimer(decorate) {
  setInterval(() => {
    // Foundry may not rerender Currently Playing when the last audible sound ends.
    const entries = pendingEntries();
    for (const element of document.querySelectorAll(".playlists-sidebar")) {
      const rows = [...element.querySelectorAll(".currently-playing .rn-silence-playing")];
      const current = new Set(
        rows.map((row) => `${row.dataset.playlistId}:${row.dataset.soundId ?? ""}:${row.dataset.pendingId}`),
      );
      const expected = new Set(
        entries.map(([playlist, item, soundId]) => `${playlist.id}:${soundId ?? ""}:${item.id}`),
      );
      if (
        current.size !== expected.size ||
        [...expected].some((key) => !current.has(key)) ||
        (entries.length && element.querySelector(".currently-playing")?.hidden)
      ) {
        decorateSilenceWidget(element, entries);
        decorate(element);
      } else refreshTimes(element);
    }
  }, 250);
}
