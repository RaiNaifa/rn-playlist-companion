const cache = new WeakMap();
const labels =
  ".directory-list .playlist > .playlist-header > label.playlist-name, .directory-list .sound > header > label.ellipsis, .currently-playing .sound > header > label.ellipsis";

function watchTooltipOverflow() {
  // Show the fade only when Foundry's tooltip actually overflows, including after images load.
  const tooltip = game.tooltip?.tooltip ?? document.getElementById("tooltip");
  if (!tooltip) {
    Hooks.once("ready", watchTooltipOverflow);
    return;
  }
  let pending = false;
  const measure = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const overflow =
        tooltip.classList.contains("rn-description-tooltip-host") && tooltip.scrollHeight > tooltip.clientHeight + 1;
      tooltip.classList.toggle("rn-description-overflow", overflow);
    });
  };
  new MutationObserver(measure).observe(tooltip, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });
  tooltip.addEventListener("load", measure, true);
}

function updateLabel(label, item) {
  const description = item?.description?.trim() ?? "";
  if (cache.get(label)?.description === description) return;
  if (description) {
    label.dataset.tooltipHtml = description;
    label.dataset.tooltipClass = "rn-description-tooltip-host";
  } else {
    label.removeAttribute("data-tooltip-html");
    label.removeAttribute("data-tooltip-class");
  }
  cache.set(label, { description });
  if (game.tooltip.element === label) {
    // Changing the attribute does not update a tooltip that is already open.
    if (description) game.tooltip.activate(label);
    else game.tooltip.deactivate();
  }
}

export function decorateDescriptions(element) {
  if (!game.user?.isGM) return;
  for (const label of element.querySelectorAll(labels)) {
    const row = label.closest(".playlist, .sound");
    const item = row.classList.contains("playlist")
      ? game.playlists.get(row.dataset.entryId)
      : game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
    updateLabel(label, item);
  }
}

export function registerDescriptionTooltipUpdates() {
  Hooks.once("ready", () => {
    if (game.user?.isGM) watchTooltipOverflow();
  });
  const refresh = (item) => {
    for (const element of document.querySelectorAll(".playlists-sidebar")) {
      for (const label of element.querySelectorAll(labels)) {
        const row = label.closest(".playlist, .sound");
        const sameItem =
          item.documentName === "Playlist"
            ? row.dataset.entryId === item.id
            : row.dataset.soundId === item.id && row.dataset.playlistId === item.parent?.id;
        if (sameItem) updateLabel(label, item);
      }
    }
  };
  Hooks.on("updatePlaylist", (playlist, changes) => {
    if (game.user?.isGM && Object.hasOwn(changes, "description")) refresh(playlist);
  });
  Hooks.on("updatePlaylistSound", (sound, changes) => {
    if (game.user?.isGM && Object.hasOwn(changes, "description")) refresh(sound);
  });
}
