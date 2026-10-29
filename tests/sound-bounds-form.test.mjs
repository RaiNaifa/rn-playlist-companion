import assert from "node:assert/strict";
import test from "node:test";
import { isDecimalDraft, registerSoundBounds, stepDecimal } from "../scripts/ui/sound-bounds.mjs";

test("decimal inputs accept comma and dot but reject letters and exponents", () => {
  for (const value of ["", "12", "12.5", "12,5", ".5", "12,"]) assert.equal(isDecimalDraft(value), true);
  for (const value of ["-1", "1e3", "12x", "1.2.3", "Infinity", "NaN"]) assert.equal(isDecimalDraft(value), false);
  assert.equal(isDecimalDraft("-80,5", { signed: true }), true);
  assert.equal(isDecimalDraft("--80", { signed: true }), false);
});

test("wheel steps accept comma decimals and stay inside boundaries", () => {
  assert.equal(stepDecimal("15,5", 1, { step: 0.1, min: 0, max: 30 }), 15.6);
  assert.equal(stepDecimal("15.5", -1, { step: 0.1, min: 0, max: 30 }), 15.4);
  assert.equal(stepDecimal("29.95", 1, { step: 0.1, min: 0, max: 29.999 }), 29.999);
  assert.equal(stepDecimal("-80", -1, { step: 1, min: -120, max: 0 }), -81);
  assert.equal(stepDecimal("-80,1254", 1, { step: 1, min: -120, max: 0 }), -79.1254);
  assert.equal(stepDecimal("bad", 1, { step: 1, min: -120, max: 0 }), null);
});

test("untouched boundaries never block normal Sound saving", () => {
  class PlaylistSoundConfig {
    _processFormData() {
      return {};
    }
  }
  globalThis.foundry = { applications: { sheets: { PlaylistSoundConfig } } };
  globalThis.game = { settings: { register() {}, get: () => -60 } };
  globalThis.Hooks = { on() {} };
  registerSoundBounds();
  const fields = {
    ".rn-bound-start": { value: "" },
    ".rn-bound-end": { value: "" },
    ".rn-bound-threshold": { value: "-60" },
  };
  const panel = { dataset: {}, querySelector: (selector) => fields[selector] };
  const form = { querySelector: () => panel, elements: { path: { value: "music.ogg" } } };
  const sheet = new PlaylistSoundConfig();
  sheet.document = { path: "music.ogg", flags: {} };
  const result = sheet._processFormData(null, form, null);
  assert.equal(result.flags["rn-playlist-companion"].bounds, undefined);
  assert.equal(result.flags["rn-playlist-companion"].threshold, null);
  globalThis.game.i18n = { localize: (key) => key };
  fields[".rn-bound-threshold"].value = "";
  assert.throws(() => sheet._processFormData(null, form, null));
  fields[".rn-bound-threshold"].value = "-65";
  assert.equal(sheet._processFormData(null, form, null).flags["rn-playlist-companion"].threshold, -65);
  fields[".rn-bound-threshold"].value = "-60";
  assert.equal(sheet._processFormData(null, form, null).flags["rn-playlist-companion"].threshold, null);
  panel.dataset.reset = "true";
  assert.equal(sheet._processFormData(null, form, null).flags["rn-playlist-companion"].bounds, null);
  panel.dataset.reset = "false";
  panel.dataset.edited = "true";
  assert.throws(() => sheet._processFormData(null, form, null));
});
