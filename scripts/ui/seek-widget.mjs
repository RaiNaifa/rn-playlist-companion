import { activePreview, previewSound, seekPreview } from "../audio/preview.mjs";
import { requestSeek, seekRange } from "../audio/seek.mjs";
import { reportError, t } from "../core/context.mjs";

const expanded = new Set();
const pending = new WeakMap();

function format(seconds) {
  return foundry.applications.sidebar.tabs.PlaylistDirectory.formatTimestamp(Math.max(0, seconds));
}

function details(row) {
  const document = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
  const preview = activePreview() === document?.uuid;
  const audio = preview ? previewSound() : document?.sound;
  const range = seekRange(document, audio);
  return document && range ? { document, audio, range, preview } : null;
}

export function updateSeekWidget(row) {
  if (!row.matches?.(".sound[data-playlist-id][data-sound-id]")) return;
  const input = row.querySelector(".rn-seek input");
  // Keep the user's draft position during dragging, wheel input, and an in-flight seek.
  if (!input || pending.has(input)) return;
  const data = details(row);
  if (!data) return;
  const position = data.preview
    ? data.audio?.currentTime
    : data.document.playing
      ? data.audio?.currentTime
      : data.document.pausedTime;
  input.value = String(
    Math.max(0, Math.min(data.range.maximum - data.range.start, (position ?? 0) - data.range.start)),
  );
  input.max = String(data.range.maximum - data.range.start);
  input.setAttribute("aria-valuetext", format(Number(input.value)));
}

export function updateSeekWidgets() {
  for (const row of document.querySelectorAll(".playlists-sidebar .currently-playing:not(.rn-queue) .sound"))
    updateSeekWidget(row);
}

export function decorateSeekWidgets(element) {
  for (const row of element.querySelectorAll(
    ".currently-playing:not(.rn-queue) .sound[data-playlist-id][data-sound-id]",
  )) {
    const playlistSound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    const mode = activePreview() === playlistSound?.uuid ? "preview" : "playback";
    // Event handlers capture the target mode. Rebuild them when preview takes over this row or ends.
    if (row.dataset.rnSeekMode && row.dataset.rnSeekMode !== mode) {
      const previous = row.querySelector(".rn-seek input");
      if (previous) {
        clearTimeout(pending.get(previous)?.timer);
        pending.delete(previous);
      }
      row.querySelector(".rn-seek")?.remove();
      row.querySelector(".rn-seek-toggle")?.remove();
    }
    row.dataset.rnSeekMode = mode;
    const data = details(row);
    const playback = row.querySelector(".sound-playback");
    const timer = playback?.querySelector(".sound-timer");
    if (!data || !timer || row.querySelector(".rn-seek")) continue;
    const key = data.document.uuid;
    const visible = data.preview || expanded.has(key);
    if (!data.preview && !playback.querySelector(".rn-seek-toggle")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rn-seek-toggle inline-control icon fa-solid fa-sliders";
      const setButtonState = (open) => {
        const label = t(`UI.${open ? "HideSeek" : "ShowSeek"}`);
        button.setAttribute("aria-label", label);
        button.dataset.tooltip = label;
        button.setAttribute("aria-expanded", String(open));
      };
      setButtonState(visible);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        const seek = row.querySelector(".rn-seek");
        seek.hidden = !expanded.has(key);
        setButtonState(!seek.hidden);
        game.tooltip?.activate(button, { text: button.dataset.tooltip });
      });
      timer.before(button);
    }
    const seek = document.createElement("div");
    seek.className = "rn-seek";
    seek.hidden = !visible;
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = String(data.range.maximum - data.range.start);
    input.step = "0.01";
    input.disabled = !data.preview && !data.document.parent.isOwner;
    input.setAttribute("aria-label", t("UI.Seek"));
    const tooltip = document.createElement("output");
    tooltip.className = "rn-seek-time";
    const show = (seconds, clientX) => {
      tooltip.textContent = format(seconds);
      seek.classList.add("rn-seek-hover");
      const container = seek.getBoundingClientRect();
      const halfWidth = tooltip.getBoundingClientRect().width / 2;
      const center = Math.max(halfWidth, Math.min(container.width - halfWidth, clientX - container.left));
      tooltip.style.left = `${center}px`;
    };
    const valueX = () => {
      const rect = input.getBoundingClientRect();
      return rect.left + (Number(input.value) / Number(input.max)) * rect.width;
    };
    const commit = () => {
      clearTimeout(pending.get(input)?.timer);
      const seconds = data.range.start + Number(input.value);
      const action = data.preview ? seekPreview(seconds) : requestSeek(data.document, seconds);
      const request = { timer: null };
      pending.set(input, request);
      action.catch(reportError).finally(() => {
        // A newer interaction owns the draft value. An older request must not reset it.
        if (pending.get(input) !== request) return;
        pending.delete(input);
        updateSeekWidget(row);
      });
      input.setAttribute("aria-valuetext", format(Number(input.value)));
    };
    let pointerRequest;
    input.addEventListener("pointerdown", () => {
      // A click or drag supersedes a wheel seek that has not been committed yet.
      clearTimeout(pending.get(input)?.timer);
      pointerRequest = { timer: null };
      pending.set(input, pointerRequest);
    });
    const finishPointer = () => {
      const request = pointerRequest;
      // Let the range input's change event commit before resuming timer-driven updates.
      setTimeout(() => {
        if (pending.get(input) === request) pending.delete(input);
      }, 0);
    };
    input.addEventListener("pointerup", finishPointer);
    input.addEventListener("pointercancel", finishPointer);
    input.addEventListener("pointermove", (event) => {
      const rect = input.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      show(ratio * (data.range.maximum - data.range.start), event.clientX);
    });
    input.addEventListener("pointerleave", () => seek.classList.remove("rn-seek-hover"));
    input.addEventListener("input", () => {
      pending.set(input, { timer: null });
      show(Number(input.value), valueX());
    });
    input.addEventListener("change", commit);
    input.addEventListener(
      "wheel",
      (event) => {
        if (input.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        const step = data.range.end - data.range.start < 60 ? 1 : 5;
        const next = Math.max(0, Math.min(Number(input.max), Number(input.value) - Math.sign(event.deltaY) * step));
        input.value = String(next);
        show(next, valueX());
        clearTimeout(pending.get(input)?.timer);
        pending.set(input, { timer: setTimeout(commit, 300) });
      },
      { passive: false },
    );
    seek.append(input, tooltip);
    row.append(seek);
    updateSeekWidget(row);
  }
}
