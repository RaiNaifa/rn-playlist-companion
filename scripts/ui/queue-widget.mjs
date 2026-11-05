import { activePreview, togglePreview } from "../audio/preview.mjs";
import {
  addToQueue,
  canManageQueueSound,
  changeQueue,
  playQueueEntry,
  playQueueNext,
  queueSound,
  queueState,
  sameSound,
  soundEntry,
  toggleQueueLink,
  visibleQueueEntries,
} from "../audio/queue.mjs";
import { reportError, t } from "../core/context.mjs";
import { soundChannelIconClass } from "./sound-channel-icon.mjs";

const queueOpenBySurface = { sidebar: true, companion: true };

function button(icon, label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = `inline-control sound-control icon fa-solid ${icon}`;
  control.setAttribute("aria-label", label);
  control.setAttribute("data-tooltip", "");
  control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(action()).catch(reportError);
  });
  return control;
}

function dropPosition(event, list) {
  // The upper and lower halves of a row represent the slots before and after it.
  const row = event.target.closest?.(".rn-queue-sound");
  if (!row || !list.contains(row)) return null;
  const index = Number(row.dataset.index);
  if (!Number.isInteger(index)) return null;
  return {
    row,
    index: index + Number(event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2),
  };
}

function droppedSound(event) {
  try {
    const data = JSON.parse(event.dataTransfer.getData("text/plain"));
    const sound = data.uuid ? fromUuidSync(data.uuid) : game.playlists.get(data.parentId)?.sounds.get(data._id);
    return sound?.parent?.sounds && sound.path && canManageQueueSound(sound) ? sound : null;
  } catch {
    return null;
  }
}

function acceptQueueDrop(target) {
  // The companion window survives directory rerenders. Install its listeners only once.
  if (!target || target.dataset.rnQueueDropTarget) return;
  target.dataset.rnQueueDropTarget = "true";
  target.addEventListener("dragover", (event) => {
    if (event.target.closest?.(".rn-queue")) return;
    if (event.dataTransfer.types.includes("text/rn-queue-index") || !event.dataTransfer.types.includes("text/plain"))
      return;
    event.preventDefault();
    target.classList.add("rn-queue-drop-target");
  });
  target.addEventListener("dragleave", (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove("rn-queue-drop-target");
  });
  target.addEventListener(
    "drop",
    (event) => {
      target.classList.remove("rn-queue-drop-target");
      if (event.target.closest?.(".rn-queue")) return;
      const sound = droppedSound(event);
      if (!sound) return;
      event.preventDefault();
      event.stopPropagation();
      addToQueue(sound).catch(reportError);
    },
    // Handle the drop before Foundry's directory listeners can consume it.
    { capture: true },
  );
}

function renderQueue(element) {
  element.querySelector(".rn-queue")?.remove();
  const surface = element.closest(".rn-player-companion-window") ? "companion" : "sidebar";
  const state = queueState();
  const visible = visibleQueueEntries(state.entries);
  if (!visible.length) return;
  const playing = element.querySelector(".currently-playing:not(.rn-queue)");
  if (!playing) return;
  const widget = document.createElement("section");
  // Reuse Foundry's playing styles, but exclude this block from playing-sound selectors.
  widget.className = `currently-playing global-control rn-queue${queueOpenBySurface[surface] ? " expanded" : ""}`;
  const header = document.createElement("header");
  header.className = "playlist-header";
  header.innerHTML = `<i class="expand fa-solid fa-angle-up" inert></i><strong>${t("UI.Queue")}</strong>`;
  header.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    queueOpenBySurface[surface] = !queueOpenBySurface[surface];
    widget.classList.toggle("expanded", queueOpenBySurface[surface]);
  });
  if (game.user.isGM) {
    header.append(button("fa-forward-step", t("UI.NextQueuedSound"), playQueueNext));
    header.append(
      button("fa-trash", t("UI.ClearQueue"), () =>
        changeQueue((current) => ({
          ...current,
          entries: current.entries.filter((entry) => !canManageQueueSound(queueSound(entry))),
        })),
      ),
    );
  }
  const expandable = document.createElement("div");
  expandable.className = "expandable";
  const wrapper = document.createElement("div");
  wrapper.className = "wrapper";
  const list = document.createElement("ol");
  list.className = "playlist-sounds plain";
  visible.forEach(({ sound, index }) => {
    const row = document.createElement("li");
    row.className = "sound rn-queue-sound";
    row.draggable = true;
    row.dataset.index = index;
    row.innerHTML = `<header><i class="fa-thin rn-channel-icon ${soundChannelIconClass(sound)}" inert></i><label class="ellipsis"></label><div class="sound-controls flexrow"></div></header>`;
    row.querySelector("label").textContent = sound.name;
    const controls = row.querySelector(".sound-controls");
    const repeat = button("fa-arrows-rotate", game.i18n.localize("PLAYLIST.SoundLoop"), () =>
      sound.update({ repeat: !sound.repeat }),
    );
    repeat.classList.toggle("inactive", !sound.repeat);
    controls.append(repeat);
    controls.append(button("fa-play", game.i18n.localize("PLAYLIST.SoundPlay"), () => playQueueEntry(index)));
    const previewing = activePreview() === sound.uuid;
    const preview = button("fa-headphones", t(`UI.${previewing ? "StopPreview" : "Preview"}`), () =>
      togglePreview(sound),
    );
    preview.classList.add("rn-preview");
    preview.classList.toggle("rn-previewing", previewing);
    preview.dataset.soundUuid = sound.uuid;
    preview.setAttribute("aria-pressed", String(previewing));
    controls.append(preview);
    controls.append(
      button("fa-xmark", t("UI.RemoveFromQueue"), () =>
        changeQueue((current) => {
          if (canManageQueueSound(queueSound(current.entries[index]))) current.entries.splice(index, 1);
          return current;
        }),
      ),
    );
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/rn-queue-index", String(index));
      event.dataTransfer.effectAllowed = "move";
    });
    list.append(row);
  });
  const clearIndicator = () => {
    for (const row of list.querySelectorAll(".rn-drop-before, .rn-drop-after"))
      row.classList.remove("rn-drop-before", "rn-drop-after");
  };
  list.addEventListener("dragover", (event) => {
    event.preventDefault();
    clearIndicator();
    const position = dropPosition(event, list);
    position?.row.classList.add(
      position.index === Number(position.row.dataset.index) ? "rn-drop-before" : "rn-drop-after",
    );
  });
  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) clearIndicator();
  });
  list.addEventListener("dragend", clearIndicator);
  list.addEventListener("drop", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const position = dropPosition(event, list);
    clearIndicator();
    if (event.dataTransfer.types.includes("text/rn-queue-index")) {
      const source = Number(event.dataTransfer.getData("text/rn-queue-index"));
      if (!Number.isInteger(source) || source < 0) return;
      changeQueue((current) => {
        if (!canManageQueueSound(queueSound(current.entries[source]))) return current;
        if (position && !canManageQueueSound(queueSound(current.entries[Number(position.row.dataset.index)])))
          return current;
        const target = position?.index ?? current.entries.length;
        const [item] = current.entries.splice(source, 1);
        // Removing an earlier row shifts the destination slot one place left.
        current.entries.splice(target > source ? target - 1 : target, 0, item);
        return current;
      }).catch(reportError);
      return;
    }
    const sound = droppedSound(event);
    if (sound) addToQueue(sound, position?.index).catch(reportError);
  });
  wrapper.append(list);
  expandable.append(wrapper);
  widget.append(header, expandable);
  playing.after(widget);
}

export function decorateQueue(element) {
  acceptQueueDrop(element.querySelector(".currently-playing:not(.rn-queue)"));
  if (element.classList.contains("rn-player-companion"))
    acceptQueueDrop(element.closest(".rn-player-companion-window"));
  for (const row of element.querySelectorAll(".directory-list .sound[data-playlist-id][data-sound-id]")) {
    const controls = row.querySelector(":scope > header > .sound-controls");
    const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    if (!controls || !sound?.path || !canManageQueueSound(sound) || controls.querySelector(".rn-add-queue")) continue;
    const add = button("fa-indent", t("UI.AddToQueue"), () => addToQueue(sound));
    add.classList.add("rn-add-queue");
    controls.prepend(add);
  }
  for (const row of element.querySelectorAll(
    ".currently-playing:not(.rn-queue) .sound[data-playlist-id][data-sound-id]",
  )) {
    const controls = row.querySelector(":scope > header > .sound-controls");
    if (row.classList.contains("rn-preview-playing")) {
      controls?.querySelector(".rn-queue-link")?.remove();
      continue;
    }
    const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    if (!controls || !canManageQueueSound(sound) || controls.querySelector(".rn-queue-link")) continue;
    const link = button("fa-right-to-bracket", t("UI.LinkQueue"), () => toggleQueueLink(sound));
    link.classList.add("rn-queue-link");
    const active = sameSound(queueState().linked, soundEntry(sound));
    link.setAttribute("aria-pressed", String(active));
    controls.prepend(link);
  }
  renderQueue(element);
}
