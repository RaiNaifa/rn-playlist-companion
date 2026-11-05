import { MODULE_ID, reportError, t } from "../core/context.mjs";

const SETTING = "hotbarDropBehavior";
const DOCUMENT = Object.freeze({ FOLDER: "Folder", PLAYLIST: "Playlist", SOUND: "PlaylistSound" });
const DRAG_TYPES = new Set(Object.values(DOCUMENT));

function targetPlaying(target) {
  const playlistActive = (playlist) =>
    !!playlist && (playlist.playing || [...playlist.sounds].some((sound) => sound.playing));
  if (target.kind === DOCUMENT.SOUND) return !!game.playlists.get(target.parentId)?.sounds.get(target.id)?.playing;
  if (target.kind === DOCUMENT.PLAYLIST) return playlistActive(game.playlists.get(target.id));
  // A folder macro covers descendants added after the macro was created, so inspect the current tree.
  const ids = new Set([target.id]);
  const stack = [target.id];
  while (stack.length) {
    const id = stack.pop();
    for (const folder of game.folders) {
      if (folder.type !== DOCUMENT.PLAYLIST || folder.folder?.id !== id || ids.has(folder.id)) continue;
      ids.add(folder.id);
      stack.push(folder.id);
    }
  }
  return game.playlists.some((playlist) => ids.has(playlist.folder?.id) && playlistActive(playlist));
}

function refreshHotbar(element = ui.hotbar?.element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  for (const slot of root.querySelectorAll("[data-slot]")) {
    const macro = game.macros.get(game.user.hotbar?.[slot.dataset.slot]);
    // Flags identify the button to decorate. The macro command never reads them.
    const target = macro?.flags?.[MODULE_ID]?.hotbarTarget;
    const playing = !!target && targetPlaying(target);
    slot.classList.toggle("rn-macro-playing", playing);
    let icon = slot.querySelector(":scope > .rn-macro-stop-icon");
    if (playing && !icon) {
      icon = document.createElement("i");
      icon.className = "rn-macro-stop-icon fa-solid fa-stop";
      icon.setAttribute("aria-hidden", "true");
      slot.append(icon);
    } else if (!playing) icon?.remove();
  }
}

function command(id, kind, action, parentId = null) {
  // Embed document IDs and Foundry API calls in the command so world documents still work without this module.
  // JSON.stringify produces safe JavaScript string literals for the stored IDs.
  const lookup = kind === DOCUMENT.FOLDER ? "folders" : "playlists";
  const lines = [
    `const root = game.${lookup}.get(${JSON.stringify(parentId ?? id)});`,
    "if (!root) { ui.notifications.warn('The playlist or folder is unavailable in this world.'); return; }",
  ];
  if (kind === DOCUMENT.SOUND)
    lines.push(
      `const sound = root.sounds.get(${JSON.stringify(id)});`,
      "if (!sound) { ui.notifications.warn('The sound is unavailable in this world.'); return; }",
    );
  if (kind === DOCUMENT.SOUND)
    return [
      ...lines,
      "if (sound.playing || sound.pausedTime != null) { await root.stopSound(sound); if (sound.pausedTime != null) await sound.update({pausedTime: null}); } else await root.playSound(sound);",
    ].join("\n");
  if (kind === DOCUMENT.FOLDER)
    lines.push(
      // Find playlists in this folder and its subfolders each time the macro runs.
      "const ids = new Set();",
      "const stack = [root.id];",
      "while (stack.length) {",
      "  const id = stack.pop();",
      "  if (ids.has(id)) continue;",
      "  ids.add(id);",
      `  for (const folder of game.folders) if (folder.type === ${JSON.stringify(DOCUMENT.PLAYLIST)} && folder.folder?.id === id) stack.push(folder.id);`,
      "}",
      "const playlists = [...game.playlists].filter(p => ids.has(p.folder?.id) && p.isOwner);",
    );
  else lines.push("const playlists = root.isOwner ? [root] : []; ");
  lines.push(
    "const active = p => p.playing || [...p.sounds].some(s => s.playing);",
    "const paused = p => [...p.sounds].some(s => s.pausedTime != null);",
  );
  if (action === "toggle")
    lines.push(
      // One hotbar button chooses a single action for the whole folder branch.
      "const shouldStop = playlists.some(p => active(p) || paused(p));",
      "const results = await Promise.allSettled(playlists.filter(p => p.isOwner).map(async p => {",
      "  if (!shouldStop) { if (!active(p)) await p.playAll(); return; }",
      "  if (!active(p) && !paused(p)) return;",
      "  await p.stopAll();",
      // Foundry may retain pausedTime after stopAll. Clear it so the next play starts from the beginning.
      "  const sounds = [...p.sounds].filter(s => s.pausedTime != null);",
      "  if (sounds.length) await p.update({playing: false, sounds: sounds.map(s => ({_id: s.id, playing: false, pausedTime: null}))});",
      "}));",
      "for (const result of results) if (result.status === 'rejected') console.error(result.reason);",
    );
  return lines.join("\n");
}

async function drop(data, slot) {
  const document = data.uuid
    ? await foundry.utils.fromUuid(data.uuid)
    : data.type === DOCUMENT.SOUND
      ? await foundry.documents.PlaylistSound.implementation.fromDropData(data)
      : null;
  if (!document || !DRAG_TYPES.has(document.documentName)) return;
  if (document.documentName === DOCUMENT.FOLDER && document.type !== DOCUMENT.PLAYLIST) return;
  const macro = await foundry.documents.Macro.create({
    name: `${document.name} — ${t("UI.MacroToggle")}`,
    type: "script",
    img: "icons/svg/sound.svg",
    command: command(document.id, document.documentName, "toggle", document.parent?.id),
    flags: {
      [MODULE_ID]: {
        hotbarTarget: {
          id: document.id,
          kind: document.documentName,
          parentId: document.parent?.id ?? null,
        },
      },
    },
  });
  if (macro) await game.user.assignHotbarMacro(macro, slot);
  if (macro) refreshHotbar();
  return false;
}

function playlistDrop(data) {
  if (!DRAG_TYPES.has(data?.type)) return false;
  if (data.type !== DOCUMENT.FOLDER) return true;
  return game.folders.get(data.uuid?.split(".").at(-1) ?? data.id)?.type === DOCUMENT.PLAYLIST;
}

async function askBeforeDrop(event, data, slot, target) {
  const action = await foundry.applications.api.DialogV2.wait({
    window: { title: t("UI.MacroChoice") },
    content: `<p>${foundry.utils.escapeHTML(t("UI.MacroChoice"))}</p>`,
    buttons: [
      { action: "toggle", label: t("UI.MacroControl"), default: true, callback: () => "toggle" },
      { action: "standard", label: t("UI.MacroNative"), callback: () => "standard" },
    ],
    close: () => null,
  });
  if (action === "toggle") return drop(data, slot);
  if (action !== "standard") return;
  // The original drop was stopped before the dialog. Replay it so Foundry creates its own macro.
  const transfer = new DataTransfer();
  transfer.setData("text/plain", JSON.stringify(data));
  const replay = new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
    clientX: event.clientX,
    clientY: event.clientY,
  });
  nativeReplay.add(replay);
  target.dispatchEvent(replay);
}

// Mark only our replayed event, so the capture listener does not open the same dialog again.
const nativeReplay = new WeakSet();

function captureHotbarDrop(event) {
  if (nativeReplay.has(event) || game.settings.get(MODULE_ID, SETTING) !== "ask") return;
  const slotElement = event.target?.closest?.("#hotbar [data-slot]");
  if (!slotElement) return;
  const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  if (!playlistDrop(data)) return;
  const slot = Number(slotElement.dataset.slot);
  if (!Number.isInteger(slot)) return;
  // Foundry does not await hook callbacks, so intercept the drop before hotbarDrop to ask which macro to create.
  event.preventDefault();
  event.stopImmediatePropagation();
  askBeforeDrop(event, data, slot, event.target).catch(reportError);
}

export function registerHotbarMacros() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.HotbarDrop.Name",
    hint: "RNPLAYCOMP.Settings.HotbarDrop.Hint",
    scope: "client",
    config: true,
    type: String,
    default: "toggle",
    choices: {
      toggle: "RNPLAYCOMP.UI.MacroToggle",
      standard: "RNPLAYCOMP.UI.MacroStandard",
      ask: "RNPLAYCOMP.UI.MacroAsk",
    },
  });
  Hooks.on("hotbarDrop", (_bar, data, slot) => {
    if (!playlistDrop(data)) return;
    if (game.settings.get(MODULE_ID, SETTING) !== "toggle") return;
    // The hook must answer synchronously to prevent Foundry's default macro creation.
    drop(data, slot).catch(reportError);
    return false;
  });
  document.addEventListener("drop", captureHotbarDrop, true);
  Hooks.on("renderHotbar", (_app, element) => refreshHotbar(element));
  Hooks.on("updatePlaylist", () => refreshHotbar());
  Hooks.on("updatePlaylistSound", () => refreshHotbar());
  Hooks.on("createPlaylistSound", () => refreshHotbar());
  Hooks.on("deletePlaylistSound", () => refreshHotbar());
  Hooks.on("updateFolder", () => refreshHotbar());
  Hooks.on("renderPlaylistDirectory", () => refreshHotbar());
}
