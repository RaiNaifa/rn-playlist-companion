import { MODULE_ID, t } from "../core/context.mjs";

export function registerPlaylistLoop() {
  Hooks.on("renderPlaylistConfig", (app, element) => {
    if (!game.user.isGM) return;
    const form = app.form ?? (element.tagName === "FORM" ? element : element.querySelector("form"));
    if (!form || form.querySelector(".rn-playlist-loop")) return;
    const row = document.createElement("div");
    row.className = "form-group rn-playlist-loop";
    const label = document.createElement("label");
    label.textContent = t("UI.LoopPlaylist");
    const fields = document.createElement("div");
    fields.className = "form-fields";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    // Missing flags belong to existing playlists and retain Foundry's looping behavior.
    checkbox.checked = app.document.flags?.[MODULE_ID]?.loopPlaylist !== false;
    fields.append(checkbox);
    row.append(label, fields);
    const mode = form.querySelector('[name="mode"]')?.closest(".form-group");
    if (mode) mode.after(row);
    else form.querySelector("footer")?.before(row);
  });

  const Config = foundry.applications.sheets.PlaylistConfig;
  const original = Config.prototype._processFormData;
  Config.prototype._processFormData = function (event, form, formData) {
    const data = original.call(this, event, form, formData);
    const checkbox = form.querySelector(".rn-playlist-loop input");
    if (!checkbox) return data;
    data.flags ??= {};
    data.flags[MODULE_ID] = { ...data.flags[MODULE_ID], loopPlaylist: checkbox.checked };
    return data;
  };
}
