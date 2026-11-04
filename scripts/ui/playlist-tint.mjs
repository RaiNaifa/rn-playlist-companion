import { MODULE_ID, t } from "../core/context.mjs";

const HEX = /^#[0-9a-f]{6}$/i;
const TINT_OPACITY = 0.25;

export function tintBackground(value) {
  if (typeof value !== "string" || !HEX.test(value)) return "";
  const channels = [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  return `rgba(${channels.join(", ")}, ${TINT_OPACITY})`;
}

export function decoratePlaylistTints(element) {
  for (const row of element.querySelectorAll(".directory-item.playlist[data-entry-id]")) {
    const color = game.playlists.get(row.dataset.entryId)?.flags?.[MODULE_ID]?.tint;
    row.style.backgroundColor = tintBackground(color);
  }
}

export function refreshPlaylistTint(playlist, elements = document.querySelectorAll(".playlists-sidebar")) {
  const background = tintBackground(playlist.flags?.[MODULE_ID]?.tint);
  for (const element of elements) {
    for (const row of element.querySelectorAll(".directory-item.playlist[data-entry-id]")) {
      if (row.dataset.entryId === playlist.id) row.style.backgroundColor = background;
    }
  }
}

export function registerPlaylistTint() {
  Hooks.on("updatePlaylist", (playlist) => refreshPlaylistTint(playlist));
  Hooks.on("renderPlaylistConfig", (app, element) => {
    if (!game.user.isGM) return;
    const form = app.form ?? (element.tagName === "FORM" ? element : element.querySelector("form"));
    if (!form || form.querySelector(".rn-playlist-tint")) return;
    const row = document.createElement("div");
    row.className = "form-group rn-playlist-tint";
    const label = document.createElement("label");
    label.textContent = t("UI.PlaylistTint");
    const fields = document.createElement("div");
    fields.className = "form-fields";
    const picker = document.createElement("color-picker");
    const savedTint = app.document.flags?.[MODULE_ID]?.tint ?? "";
    picker.setAttribute("value", savedTint);
    picker.setAttribute("placeholder", "#000000");
    picker.setAttribute("default", "");
    picker.setAttribute("aria-label", t("UI.PlaylistTint"));
    fields.append(picker);
    row.append(label, fields);
    const name = form.querySelector('[name="name"]')?.closest(".form-group");
    if (name) name.after(row);
    else form.querySelector("footer")?.before(row);
    // Foundry's color-picker initializes its visible input when connected to the form.
    picker.value = savedTint;
  });

  const Config = foundry.applications.sheets.PlaylistConfig;
  const original = Config.prototype._processFormData;
  Config.prototype._processFormData = function (event, form, formData) {
    const data = original.call(this, event, form, formData);
    const picker = form.querySelector(".rn-playlist-tint color-picker");
    if (!picker) return data;
    const tint = picker.value.trim();
    if (tint && !HEX.test(tint)) {
      throw new Error(t("UI.InvalidPlaylistTint"));
    }
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], tint: tint.toLowerCase() };
    return data;
  };
}
