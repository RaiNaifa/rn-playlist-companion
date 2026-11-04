import { pendingSilence } from "../audio/silence-data.mjs";
import { MODULE_ID, reportError, t } from "../core/context.mjs";

export function folderPlaylists(folderId, folders, playlists) {
  // Traverse folder IDs, not rendered rows: collapsed and hidden descendants still belong to the launcher.
  const byParent = new Map();
  for (const folder of folders) {
    if (folder.type !== "Playlist") continue;
    const parent = folder._source.folder;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(folder.id);
  }
  const ids = new Set();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    stack.push(...(byParent.get(id) ?? []));
  }
  return [...playlists].filter((playlist) => ids.has(playlist._source.folder));
}

export function playlistActivity(playlist) {
  const sounds = [...playlist.sounds];
  return {
    // A playlist remains active during a scheduled silence even when no Sound is currently playing.
    playing: !!playlist.playing || !!pendingSilence(playlist) || sounds.some((sound) => sound.playing),
    paused: sounds.some((sound) => sound.pausedTime != null),
  };
}

async function stopFully(playlist) {
  await playlist.stopAll();
  // Foundry can retain pausedTime after stopAll. Clear it to prevent a later resume.
  const paused = [...playlist.sounds].filter((sound) => sound.pausedTime != null);
  if (paused.length) {
    await playlist.update({
      playing: false,
      sounds: paused.map((sound) => ({ _id: sound.id, playing: false, pausedTime: null })),
    });
  }
}

export async function launchFolder(folderId, action, { folders = game.folders, playlists = game.playlists } = {}) {
  // Skip active playlists on play, preserving their current track and playback position.
  // Paused playlists are eligible for playAll so Foundry resumes them.
  const entries = folderPlaylists(folderId, folders, playlists).filter((playlist) => {
    if (!playlist.isOwner) return false;
    const activity = playlistActivity(playlist);
    return action === "play" ? !activity.playing : activity.playing || activity.paused;
  });
  const results = await Promise.allSettled(
    entries.map((playlist) => (action === "play" ? playlist.playAll() : stopFully(playlist))),
  );
  for (const result of results) if (result.status === "rejected") reportError(result.reason);
}

function refreshButtons(element) {
  // Roll each playlist's state up through its ancestors once instead of rescanning a whole branch per button.
  const byFolder = new Map();
  for (const playlist of game.playlists) {
    if (!playlist.isOwner) continue;
    const activity = playlistActivity(playlist);
    let folderId = playlist._source.folder;
    const visited = new Set();
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId);
      const status = byFolder.get(folderId) ?? { canPlay: false, canStop: false };
      status.canPlay ||= !activity.playing;
      status.canStop ||= activity.playing || activity.paused;
      byFolder.set(folderId, status);
      folderId = game.folders.get(folderId)?._source.folder;
    }
  }
  for (const row of element.querySelectorAll(".directory-item.folder[data-folder-id]")) {
    const header = row.querySelector(":scope > .folder-header");
    const play = header?.querySelector(".rn-launch-play");
    const stop = header?.querySelector(".rn-launch-stop");
    if (!play || !stop || row.dataset.launchBusy === "true") continue;
    const status = byFolder.get(row.dataset.folderId);
    play.disabled = !status?.canPlay;
    stop.disabled = !status?.canStop;
  }
}

export function decorateFolderLaunchers(element) {
  for (const row of element.querySelectorAll(".directory-item.folder[data-folder-id]")) {
    const folder = game.folders.get(row.dataset.folderId);
    const header = row.querySelector(":scope > .folder-header");
    if (!header) continue;
    for (const button of header.querySelectorAll(".rn-launch-play, .rn-launch-stop")) button.remove();
    if (!folder?.flags?.[MODULE_ID]?.launcher || !game.user.isGM) continue;
    const create = header.querySelector('[data-action="createFolder"], [data-action="createEntry"]');
    // Share Foundry's existing header controls container. No extra wrapper changes its layout.
    const container = create?.parentElement ?? header;
    for (const [action, icon, label] of [
      ["stop", "fa-stop", "UI.LaunchFolderStop"],
      ["play", "fa-play", "UI.LaunchFolderPlay"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `inline-control icon fa-solid ${icon} rn-launch-${action}`;
      button.setAttribute("data-tooltip", "");
      button.setAttribute("aria-label", t(label));
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        // Document updates can refresh button state before the batch finishes. Keep both locked until then.
        row.dataset.launchBusy = "true";
        for (const control of header.querySelectorAll(".rn-launch-play, .rn-launch-stop")) control.disabled = true;
        try {
          await launchFolder(folder.id, action);
        } catch (cause) {
          reportError(cause);
        } finally {
          delete row.dataset.launchBusy;
          refreshButtons(element);
        }
      });
      container.append(button);
    }
  }
  refreshButtons(element);
}

export function registerFolderLauncher() {
  Hooks.on("renderFolderConfig", (app, element) => {
    if (!game.user.isGM || app.document?.type !== "Playlist") return;
    const form = app.form ?? (element.tagName === "FORM" ? element : element.querySelector("form"));
    if (!form || form.querySelector(".rn-folder-launcher-option")) return;
    const row = document.createElement("div");
    row.className = "form-group rn-folder-launcher-option";
    const label = document.createElement("label");
    label.textContent = t("UI.FolderLauncher");
    const fields = document.createElement("div");
    fields.className = "form-fields";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `rn-folder-launcher-${app.id}`;
    label.htmlFor = checkbox.id;
    checkbox.checked = !!app.document.flags?.[MODULE_ID]?.launcher;
    fields.append(checkbox);
    row.append(label, fields);
    const footer = form.querySelector("footer");
    if (footer) footer.before(row);
    else form.append(row);
  });

  const Config = foundry.applications.sheets.FolderConfig;
  const original = Config.prototype._processFormData;
  Config.prototype._processFormData = function (event, form, formData) {
    const data = original.call(this, event, form, formData);
    const checkbox = form.querySelector(".rn-folder-launcher-option input");
    if (!checkbox) return data;
    // The checkbox is injected into Foundry's sheet, so add its value to the submitted document flags.
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], launcher: checkbox.checked };
    return data;
  };

  const refresh = () => {
    for (const element of document.querySelectorAll(".playlists-sidebar")) refreshButtons(element);
  };
  Hooks.on("updatePlaylist", refresh);
  Hooks.on("updatePlaylistSound", refresh);
}
