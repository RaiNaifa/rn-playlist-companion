import { silenceSettings } from "../audio/silence-data.mjs";
import { MODULE_ID, t } from "../core/context.mjs";

function rangeForm(kind, value = {}, personal = false) {
  const title = t(`Silence.${kind === "tracks" ? "Tracks" : personal ? "PersonalRepeats" : "Repeats"}`);
  const min = Number.isFinite(Number(value.min)) && Number(value.min) >= 0 ? Number(value.min) : 0;
  const max = Number.isFinite(Number(value.max)) && Number(value.max) >= 0 ? Number(value.max) : 0;
  return `<div class="form-group stacked rn-silence-section" data-kind="${kind}">
    <label class="rn-silence-enable"><input type="checkbox" ${value.enabled ? "checked" : ""}><span>${title}</span></label>
    <div class="form-fields rn-silence-fields">
      <label><span>${t("Silence.Minimum")} <span class="units">(${t("Bounds.Seconds")})</span></span><input class="rn-silence-min" type="text" inputmode="decimal" value="${min}"></label>
      <label><span>${t("Silence.Maximum")} <span class="units">(${t("Bounds.Seconds")})</span></span><input class="rn-silence-max" type="text" inputmode="decimal" value="${max}"></label>
    </div>
  </div>`;
}

function normalize(input) {
  const value = Number(input.value.trim().replace(",", "."));
  if (!Number.isFinite(value) || value < 0) throw new Error(t("Silence.InvalidNumber"));
  return value;
}

function readRange(section) {
  const min = normalize(section.querySelector(".rn-silence-min"));
  const max = normalize(section.querySelector(".rn-silence-max"));
  if (min > max) {
    section.querySelector(".rn-silence-min").setAttribute("aria-invalid", "true");
    section.querySelector(".rn-silence-max").setAttribute("aria-invalid", "true");
    throw new Error(t("Silence.InvalidRange"));
  }
  return { enabled: section.querySelector('input[type="checkbox"]').checked, min, max };
}

function mount(app, element, sound = false) {
  if (!game.user.isGM) return;
  const form = app.form ?? (element.tagName === "FORM" ? element : element.querySelector("form"));
  if (!form || form.querySelector(sound ? ".rn-silence-section" : ".rn-silence")) return;
  const saved = sound ? app.document.flags?.[MODULE_ID]?.repeatSilence : silenceSettings(app.document);
  let section;
  if (sound) {
    const template = document.createElement("template");
    template.innerHTML = rangeForm("repeat", saved, true);
    section = template.content.firstElementChild;
  } else {
    section = document.createElement("fieldset");
    section.className = "rn-silence";
    section.innerHTML = `<legend class="control"><button class="plain rn-silence-toggle" type="button" aria-expanded="false"><i class="fa-solid fa-angle-right rn-silence-chevron" aria-hidden="true"></i><span>${t("Silence.Title")}</span></button></legend>
    ${rangeForm("tracks", saved.tracks)}${rangeForm("repeat", saved.repeat)}`;
  }
  const anchor = sound ? form.querySelector(".rn-bounds") : form.querySelector('[name="fade"]')?.closest(".form-group");
  if (sound && anchor) anchor.querySelector(":scope > legend")?.after(section);
  else if (anchor) anchor.after(section);
  else form.querySelector("footer")?.before(section);
  if (sound && section.isConnected) {
    const divider = document.createElement("hr");
    divider.className = "rn-silence-divider";
    section.after(divider);
  }
  if (!sound) installPlaylistScroll(form);
  const toggle = section.querySelector(".rn-silence-toggle");
  toggle?.addEventListener("click", () => {
    const expanded = section.dataset.expanded !== "true";
    section.dataset.expanded = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
  });
  for (const range of sound ? [section] : section.querySelectorAll(".rn-silence-section")) {
    const checkbox = range.querySelector('input[type="checkbox"]');
    const refresh = () => range.classList.toggle("rn-silence-disabled", !checkbox.checked);
    checkbox.addEventListener("change", refresh);
    refresh();
    for (const input of range.querySelectorAll('input[type="text"]')) {
      input.addEventListener("blur", () => {
        if (!input.value.trim()) input.value = "0";
        input.removeAttribute("aria-invalid");
      });
      input.addEventListener(
        "wheel",
        (event) => {
          if (!event.deltaY) return;
          event.preventDefault();
          const current = Number(input.value.replace(",", "."));
          input.value = String(
            Math.max(
              0,
              Math.round(((Number.isFinite(current) ? current : 0) + (event.deltaY < 0 ? 0.1 : -0.1)) * 10) / 10,
            ),
          );
        },
        { passive: false },
      );
    }
  }
}

function installPlaylistScroll(form) {
  const body = form.querySelector(".window-content");
  if (!body || body.querySelector(":scope > .rn-playlist-scroll")) return;
  const footer = body.querySelector(":scope > footer.form-footer");
  if (!footer) {
    body.classList.add("rn-playlist-scroll-fallback");
    return;
  }
  const scroll = document.createElement("div");
  scroll.className = "rn-playlist-scroll scrollable";
  for (const child of [...body.children]) if (child !== footer) scroll.append(child);
  body.insertBefore(scroll, footer);
  body.classList.add("rn-playlist-scroll-layout");
}

export function registerSilenceConfig() {
  Hooks.on("renderPlaylistConfig", (app, element) => mount(app, element));
  Hooks.on("renderPlaylistSoundConfig", (app, element) => mount(app, element, true));
  for (const [Sheet, sound] of [
    [foundry.applications.sheets.PlaylistConfig, false],
    [foundry.applications.sheets.PlaylistSoundConfig, true],
  ]) {
    const original = Sheet.prototype._processFormData;
    Sheet.prototype._processFormData = function (event, form, formData) {
      const data = original.call(this, event, form, formData);
      const panel = form.querySelector(sound ? ".rn-silence-section" : ".rn-silence");
      if (!panel) return data;
      data.flags ??= {};
      data.flags[MODULE_ID] ??= {};
      if (sound) data.flags[MODULE_ID].repeatSilence = readRange(panel);
      else
        data.flags[MODULE_ID].silenceTime = {
          tracks: readRange(panel.querySelector('[data-kind="tracks"]')),
          repeat: readRange(panel.querySelector('[data-kind="repeat"]')),
        };
      return data;
    };
  }
}
