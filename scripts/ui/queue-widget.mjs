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
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      // Queue rows carry a private drag type. Foundry's playlist drags fall through to the list.
      if (!event.dataTransfer.types.includes("text/rn-queue-index")) return;
      const source = Number(event.dataTransfer.getData("text/rn-queue-index"));
      if (!Number.isInteger(source) || source < 0) return;
      event.preventDefault();
      event.stopPropagation();
      changeQueue((current) => {
        if (
          !canManageQueueSound(queueSound(current.entries[source])) ||
          !canManageQueueSound(queueSound(current.entries[index]))
        )
          return current;
        const [item] = current.entries.splice(source, 1);
        current.entries.splice(index, 0, item);
        return current;
      }).catch(reportError);
    });
    list.append(row);
  });
  list.addEventListener("dragover", (event) => event.preventDefault());
  list.addEventListener("drop", (event) => {
    if (event.dataTransfer.types.includes("text/rn-queue-index")) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      const sound = data.uuid ? fromUuidSync(data.uuid) : game.playlists.get(data.parentId)?.sounds.get(data._id);
      if (sound?.parent?.sounds && sound.path) addToQueue(sound).catch(reportError);
    } catch (cause) {
      reportError(cause);
    }
  });
  wrapper.append(list);
  expandable.append(wrapper);
  widget.append(header, expandable);
  playing.after(widget);
}

export function decorateQueue(element) {
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
