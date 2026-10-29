import { DEFAULT_THRESHOLD, detectBounds, effectiveThreshold, readBounds, SUPPORTED_AUDIO } from "../audio/bounds.mjs";
import { MODULE_ID, t } from "../core/context.mjs";

const SETTING = "silenceThreshold";
const durations = new WeakMap();

export function isDecimalDraft(value, { signed = false } = {}) {
  return (signed ? /^-?\d*(?:[.,]\d*)?$/ : /^\d*(?:[.,]\d*)?$/).test(value);
}

export function stepDecimal(value, direction, { step, min, max }) {
  const normalized = String(value).replace(",", ".");
  const current = Number(normalized);
  if (!Number.isFinite(current) || !Number.isFinite(direction) || !direction || min > max) return null;
  const precision = Math.min(
    12,
    Math.max(normalized.split(".")[1]?.length ?? 0, String(step).split(".")[1]?.length ?? 0),
  );
  const next = Number((current + Math.sign(direction) * step).toFixed(precision));
  return Math.max(min, Math.min(max, next));
}

function bindDecimalField(input, { signed = false, min = -Infinity, max = Infinity } = {}) {
  let lastAccepted = input.value;
  const validate = () => {
    const raw = input.value.trim();
    const value = Number(raw.replace(",", "."));
    const ceiling = typeof max === "function" ? max() : max;
    const valid =
      raw !== "" &&
      raw !== "-" &&
      raw !== "." &&
      raw !== "-." &&
      Number.isFinite(value) &&
      value >= min &&
      value <= ceiling;
    input.setAttribute("aria-invalid", String(!valid));
    return valid;
  };
  input.addEventListener("beforeinput", (event) => {
    if (event.isComposing || event.data == null || event.inputType?.startsWith("delete")) return;
    const next = input.value.slice(0, input.selectionStart) + event.data + input.value.slice(input.selectionEnd);
    if (!isDecimalDraft(next, { signed })) event.preventDefault();
  });
  input.addEventListener("input", () => {
    if (!isDecimalDraft(input.value, { signed })) input.value = lastAccepted;
    else lastAccepted = input.value;
    validate();
  });
  input.addEventListener("blur", validate);
  return {
    reset() {
      lastAccepted = input.value;
      input.removeAttribute("aria-invalid");
    },
  };
}

function bindWheelField(input, { step, min, max }) {
  input.addEventListener(
    "wheel",
    (event) => {
      if (input.disabled || input.readOnly || !event.deltaY) return;
      const lower = typeof min === "function" ? min() : min;
      const upper = typeof max === "function" ? max() : max;
      const value = stepDecimal(input.value, -event.deltaY, { step, min: lower, max: upper });
      if (value === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (value === Number(input.value.replace(",", "."))) return;
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { passive: false },
  );
}

export function registerSoundBounds() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Bounds.ThresholdSetting",
    hint: "RNPLAYCOMP.Bounds.ThresholdSettingHint",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULT_THRESHOLD,
    range: { min: -120, max: 0, step: 1 },
  });
  Hooks.on("renderPlaylistSoundConfig", (app, element) => mountBounds(app, element));
  Hooks.on("renderSettingsConfig", (_app, element) => {
    for (const key of [SETTING, "maxBufferDuration"]) {
      const input = element.querySelector(`[name="${MODULE_ID}.${key}"]`);
      const label = input?.closest(".form-group")?.querySelector(":scope > label");
      if (!label || label.querySelector(".units")) continue;
      const match = label.textContent.match(/^(.*?)\s*(\([^)]*\))\s*$/);
      if (!match) continue;
      const units = document.createElement("span");
      units.className = "units rn-setting-units";
      units.textContent = match[2];
      label.replaceChildren(document.createTextNode(`${match[1]} `), units);
    }
  });
  const Sheet = foundry.applications.sheets.PlaylistSoundConfig;
  const original = Sheet.prototype._processFormData;
  Sheet.prototype._processFormData = function (event, form, formData) {
    const data = original.call(this, event, form, formData);
    const panel = form.querySelector(".rn-bounds");
    if (!panel) return data;
    const startRaw = panel.querySelector(".rn-bound-start").value;
    const endRaw = panel.querySelector(".rn-bound-end").value;
    const rawThreshold = panel.querySelector(".rn-bound-threshold").value;
    if (!rawThreshold.trim()) throw new Error(t("Bounds.InvalidThreshold"));
    const moduleThreshold = game.settings.get(MODULE_ID, SETTING);
    const chosenThreshold = effectiveThreshold(rawThreshold, moduleThreshold);
    const threshold = chosenThreshold === moduleThreshold ? null : chosenThreshold;
    data.flags ??= {};
    data.flags[MODULE_ID] ??= {};
    data.flags[MODULE_ID].threshold = threshold;
    if (panel.dataset.reset === "true") {
      data.flags[MODULE_ID].bounds = null;
      return data;
    }
    if (panel.dataset.edited !== "true" && panel.dataset.analyzed !== "true") return data;
    const start = Number(startRaw.replace(",", "."));
    const end = Number(endRaw.replace(",", "."));
    const knownDuration = durations.get(this);
    const path = form.elements.path?.value ?? this.document.path;
    if (
      !startRaw ||
      !endRaw ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      (Number.isFinite(knownDuration) && end > knownDuration + 0.05)
    )
      throw new Error(t("Bounds.InvalidBounds"));
    const bounds = { start, end, path };
    if (panel.dataset.analyzed === "true") {
      bounds.analysis = { path, threshold: chosenThreshold };
    } else if (this.document.flags?.[MODULE_ID]?.bounds?.analysis) {
      bounds.analysis = this.document.flags[MODULE_ID].bounds.analysis;
    }
    data.flags[MODULE_ID].bounds =
      Number.isFinite(knownDuration) && start === 0 && Math.abs(end - knownDuration) < 0.001 ? null : bounds;
    return data;
  };
}

function mountBounds(app, element) {
  if (!game.user.isGM) return;
  const form = app.form ?? (element.tagName === "FORM" ? element : element.querySelector("form"));
  if (!form || form.querySelector(".rn-bounds")) return;
  app._rnBoundsCleanup?.();
  const saved = app.document.flags?.[MODULE_ID];
  const current = readBounds(app.document);
  const threshold = saved?.threshold;
  const section = document.createElement("fieldset");
  section.className = "rn-bounds";
  section.innerHTML = `<legend class="control"><button class="plain rn-bounds-toggle" type="button" aria-expanded="false"><i class="fa-solid fa-angle-right rn-bounds-chevron" aria-hidden="true"></i><span>${t("Bounds.Title")}</span></button></legend>
    <div class="form-group stacked">
      <label>${t("Bounds.ChooseSection")}</label>
      <div class="form-fields rn-bound-row">
        <label class="rn-bound-field"><span>${t("Bounds.Start")} <span class="units">(${t("Bounds.Seconds")})</span></span><input class="rn-bound-start" type="text" inputmode="decimal"></label>
        <div class="rn-bound-slider"><div class="rn-bound-track"><div class="rn-bound-selection"></div><div class="rn-bound-thumb rn-bound-start-thumb" aria-hidden="true"></div><div class="rn-bound-thumb rn-bound-end-thumb" aria-hidden="true"></div></div><input class="rn-bound-start-range" type="range" min="0" step="0.001" aria-label="${t("Bounds.Start")}"><input class="rn-bound-end-range" type="range" min="0" step="0.001" aria-label="${t("Bounds.End")}"></div>
        <label class="rn-bound-field"><span>${t("Bounds.End")} <span class="units">(${t("Bounds.Seconds")})</span></span><input class="rn-bound-end" type="text" inputmode="decimal"></label>
      </div>
      <p class="hint rn-bound-duration"></p>
    </div>
    <div class="form-group slim">
      <label>${t("Bounds.Threshold")} <span class="units">(dBFS)</span></label>
      <div class="form-fields rn-bound-threshold-fields"><range-picker class="rn-bound-threshold-picker" min="-120" max="0" step="1" aria-label="${t("Bounds.Threshold")}"></range-picker><input class="rn-bound-threshold" type="text" inputmode="decimal" aria-label="${t("Bounds.Threshold")}"></div>
      <p class="hint rn-bound-default"></p>
      <p class="hint">${t("Bounds.ThresholdHint")}</p>
    </div>
    <p class="hint rn-bound-status" role="status"></p>
    <div class="rn-bound-actions"><button class="rn-bound-analyze" type="button">${t("Bounds.Analyze")}</button><button class="rn-bound-reset" type="button">${t("Bounds.Reset")}</button></div>`;
  form.querySelector('[name="fade"]')?.closest(".form-group")?.after(section);
  if (!section.isConnected) form.querySelector("footer")?.before(section);
  installSoundScroll(form);
  const start = section.querySelector(".rn-bound-start");
  const end = section.querySelector(".rn-bound-end");
  const startRange = section.querySelector(".rn-bound-start-range");
  const endRange = section.querySelector(".rn-bound-end-range");
  const slider = section.querySelector(".rn-bound-slider");
  const track = section.querySelector(".rn-bound-track");
  const selection = section.querySelector(".rn-bound-selection");
  const startThumb = section.querySelector(".rn-bound-start-thumb");
  const endThumb = section.querySelector(".rn-bound-end-thumb");
  const status = section.querySelector(".rn-bound-status");
  const durationText = section.querySelector(".rn-bound-duration");
  const thresholdPicker = section.querySelector(".rn-bound-threshold-picker");
  const thresholdInput = section.querySelector(".rn-bound-threshold");
  const resetButton = section.querySelector(".rn-bound-reset");
  const toggle = section.querySelector(".rn-bounds-toggle");
  const setExpanded = (expanded) => {
    section.dataset.expanded = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
  };
  toggle.addEventListener("click", () => setExpanded(section.dataset.expanded !== "true"));
  const moduleThreshold = game.settings.get(MODULE_ID, SETTING);
  thresholdInput.value = String(threshold ?? moduleThreshold);
  thresholdPicker.value = Math.round(Number(thresholdInput.value));
  section.querySelector(".rn-bound-default").textContent = t("Bounds.ModuleDefault", { value: moduleThreshold });
  const updateSelection = () => {
    const maximum = Number(startRange.max) || 100;
    const left = Math.max(0, Math.min(100, (Number(startRange.value) / maximum) * 100));
    const right = Math.max(left, Math.min(100, (Number(endRange.value) / maximum) * 100));
    selection.style.left = `${left}%`;
    selection.style.width = `${right - left}%`;
    startThumb.style.left = `${left}%`;
    endThumb.style.left = `${right}%`;
  };
  if (saved?.bounds?.analysis?.path !== undefined && saved.bounds.analysis.path !== app.document.path) {
    status.textContent = t("Bounds.Stale");
    setExpanded(true);
  } else if (
    saved?.bounds?.analysis?.threshold !== undefined &&
    saved.bounds.analysis.threshold !== effectiveThreshold(threshold, moduleThreshold)
  ) {
    status.textContent = t("Bounds.OldThreshold");
  }
  const setDuration = (duration, { analyzed = false } = {}) => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    // Metadata is the single UI duration. Decoded samples may end a few microseconds earlier or later.
    if (analyzed && Number.isFinite(durations.get(app))) return;
    durations.set(app, duration);
    startRange.max = endRange.max = String(duration);
    if (!current && !end.value) end.value = String(duration);
    endField?.reset();
    endRange.value = end.value;
    updateSelection();
    const rounded = duration.toFixed(3);
    durationText.textContent = `${t("Bounds.Duration")}: ${Number(rounded) === duration ? "" : "≈ "}${rounded} s`;
    durationText.dataset.tooltip = `${duration} s`;
  };
  const probePath = (path) => {
    app._rnBoundsProbe?.removeAttribute("src");
    app._rnBoundsProbe = null;
    if (!path || !SUPPORTED_AUDIO.test(path)) return;
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    probe.addEventListener(
      "loadedmetadata",
      () => {
        if (app._rnBoundsProbe === probe) setDuration(probe.duration);
      },
      { once: true },
    );
    probe.src = path;
    app._rnBoundsProbe = probe;
  };
  const displayedBounds = current ?? saved?.bounds;
  start.value = String(displayedBounds?.start ?? 0);
  end.value = displayedBounds?.end == null ? "" : String(displayedBounds.end);
  startRange.value = start.value;
  endRange.value = end.value || endRange.max;
  updateSelection();
  const maximum = () => durations.get(app) ?? Infinity;
  const startField = bindDecimalField(start, { min: 0, max: maximum });
  const endField = bindDecimalField(end, { min: 0, max: maximum });
  const thresholdField = bindDecimalField(thresholdInput, { signed: true, min: -120, max: 0 });
  let pickerValue = Number(thresholdPicker.value);
  thresholdInput.addEventListener("input", () => {
    section.dataset.analyzed = "false";
    const value = Number(thresholdInput.value.replace(",", "."));
    if (!thresholdInput.value.trim() || !Number.isFinite(value) || value < -120 || value > 0) return;
    thresholdPicker.value = Math.round(value);
    pickerValue = Number(thresholdPicker.value);
  });
  thresholdPicker.querySelector('input[type="range"]').addEventListener("input", (event) => {
    section.dataset.analyzed = "false";
    const next = Number(event.currentTarget.value);
    const delta = next - pickerValue;
    const value = stepDecimal(thresholdInput.value, delta, { step: Math.abs(delta), min: -120, max: 0 });
    if (value !== null) {
      thresholdInput.value = String(value);
      thresholdField.reset();
    }
    pickerValue = next;
  });
  const numericValue = (input) => {
    const value = Number(input.value.replace(",", "."));
    return input.value && Number.isFinite(value) ? value : null;
  };
  bindWheelField(start, {
    step: 0.1,
    min: 0,
    max: () => Math.min(maximum(), (numericValue(end) ?? Infinity) - 0.001),
  });
  bindWheelField(end, {
    step: 0.1,
    min: () => (numericValue(start) ?? 0) + 0.001,
    max: maximum,
  });
  bindWheelField(thresholdInput, { step: 1, min: -120, max: 0 });
  const syncFromField = (field, range) => {
    const value = Number(field.value.replace(",", "."));
    if (field.value && Number.isFinite(value)) range.value = String(value);
    section.dataset.edited = "true";
    section.dataset.reset = "false";
    updateSelection();
  };
  start.addEventListener("input", () => syncFromField(start, startRange));
  end.addEventListener("input", () => syncFromField(end, endRange));
  const syncFromRange = (range, field) => {
    field.value = range.value;
    (field === start ? startField : endField).reset();
    section.dataset.edited = "true";
    section.dataset.reset = "false";
    updateSelection();
  };
  startRange.addEventListener("input", () => {
    if (Number(startRange.value) > Number(endRange.value)) startRange.value = endRange.value;
    syncFromRange(startRange, start);
  });
  endRange.addEventListener("input", () => {
    if (Number(endRange.value) < Number(startRange.value)) endRange.value = startRange.value;
    syncFromRange(endRange, end);
  });
  let dragging;
  const setPointerValue = (event) => {
    const rect = track.getBoundingClientRect();
    const maximum = Number(startRange.max) || 100;
    const value =
      Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * maximum * 1000) / 1000;
    const range = dragging === "start" ? startRange : endRange;
    const field = dragging === "start" ? start : end;
    range.value = String(
      dragging === "start" ? Math.min(value, Number(endRange.value)) : Math.max(value, Number(startRange.value)),
    );
    syncFromRange(range, field);
  };
  slider.addEventListener("pointerdown", (event) => {
    const rect = track.getBoundingClientRect();
    const value = ((event.clientX - rect.left) / rect.width) * (Number(startRange.max) || 100);
    dragging = Math.abs(value - Number(startRange.value)) <= Math.abs(value - Number(endRange.value)) ? "start" : "end";
    slider.setPointerCapture(event.pointerId);
    setPointerValue(event);
  });
  slider.addEventListener("pointermove", (event) => {
    if (dragging) setPointerValue(event);
  });
  slider.addEventListener("pointerup", () => {
    dragging = null;
  });
  slider.addEventListener("pointercancel", () => {
    dragging = null;
  });
  resetButton.addEventListener("click", () => {
    const duration = durations.get(app);
    start.value = startRange.value = "0";
    end.value = Number.isFinite(duration) ? String(duration) : "";
    startField.reset();
    endField.reset();
    endRange.value = end.value || endRange.max;
    section.dataset.reset = "true";
    section.dataset.edited = "false";
    section.dataset.analyzed = "false";
    status.textContent = t("Bounds.ResetPending");
    updateSelection();
  });
  const pathInput = form.elements.path;
  const onClose = (closed) => {
    if (closed !== app) return;
    app._rnBoundsCleanup();
  };
  Hooks.on("closePlaylistSoundConfig", onClose);
  app._rnBoundsCleanup = () => {
    Hooks.off("closePlaylistSoundConfig", onClose);
    app._rnBoundsProbe?.removeAttribute("src");
    app._rnBoundsProbe = null;
  };
  pathInput?.addEventListener("change", () => {
    durations.delete(app);
    section.dataset.analyzed = "false";
    section.dataset.edited = "false";
    if (!saved?.bounds) {
      start.value = startRange.value = "0";
      end.value = endRange.value = "";
      startField.reset();
      endField.reset();
      endRange.value = endRange.max;
      updateSelection();
    }
    probePath(pathInput.value);
    if (pathInput.value !== app.document.path) status.textContent = t("Bounds.PathChanged");
  });
  section.querySelector(".rn-bound-analyze").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const path = pathInput?.value || app.document.path;
    if (!SUPPORTED_AUDIO.test(path)) {
      status.textContent = t("Bounds.Unsupported");
      return;
    }
    button.disabled = true;
    resetButton.disabled = true;
    setExpanded(true);
    let context;
    try {
      status.textContent = t("Bounds.Loading");
      const response = await fetch(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      status.textContent = t("Bounds.Decoding");
      context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes);
      const result = detectBounds(buffer, effectiveThreshold(thresholdInput.value, moduleThreshold));
      if ((pathInput?.value || app.document.path) !== path) throw new Error(t("Bounds.PathChanged"));
      setDuration(result.duration, { analyzed: true });
      if (result.silent) {
        section.dataset.analyzed = "false";
        status.textContent = t("Bounds.AllSilent");
      } else {
        start.value = startRange.value = result.start.toFixed(3);
        end.value = endRange.value = result.end.toFixed(3);
        startField.reset();
        endField.reset();
        updateSelection();
        section.dataset.analyzed = "true";
        section.dataset.reset = "false";
        status.textContent = t("Bounds.Proposed", { start: start.value, end: end.value });
      }
    } catch (error) {
      console.error(error);
      status.textContent = t("Bounds.Failed", { reason: error.message });
    } finally {
      button.disabled = false;
      resetButton.disabled = false;
      await context?.close();
    }
  });
  probePath(app.document.path);
}

function installSoundScroll(form) {
  const body = form.querySelector(".window-content");
  if (!body || body.querySelector(":scope > .rn-sound-scroll")) return;
  const footer = body.querySelector(":scope > footer.form-footer");
  if (!footer) {
    body.classList.add("rn-sound-scroll-fallback");
    return;
  }
  const scroll = document.createElement("div");
  scroll.className = "rn-sound-scroll scrollable";
  for (const child of [...body.children]) if (child !== footer) scroll.append(child);
  body.insertBefore(scroll, footer);
  body.classList.add("rn-sound-scroll-layout");
}
