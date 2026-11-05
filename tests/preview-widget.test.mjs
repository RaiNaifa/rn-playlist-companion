import assert from "node:assert/strict";
import test from "node:test";
import { decoratePreviewVolume } from "../scripts/ui/preview-widget.mjs";

test("preview volume stays in sync across players without repeating change events", () => {
  const sliders = [];
  const saved = [];
  class Slider extends EventTarget {
    constructor(value) {
      super();
      this.current = value;
      this.classList = { add() {} };
      this.dataset = {};
    }

    get value() {
      return this.current;
    }

    set value(value) {
      this.current = value;
      // Foundry's range picker emits change whenever its value is assigned.
      this.dispatchEvent(new Event("change"));
    }

    setAttribute() {}
  }
  globalThis.foundry = {
    applications: { elements: { HTMLRangePickerElement: { create: ({ value }) => new Slider(value) } } },
    audio: {
      AudioHelper: {
        volumeToInput: (value) => value,
        inputToVolume: (value) => value,
        volumeToPercentage: (value) => `${Math.round(value * 100)}%`,
      },
    },
  };
  globalThis.game = {
    i18n: { localize: (key) => key },
    settings: {
      get: () => 0.2,
      set: (_module, key, value) => saved.push([key, value]),
    },
    tooltip: { activate() {} },
  };
  globalThis.document = {
    createElement: () => ({
      dataset: {},
      append(slider) {
        sliders.push(slider);
      },
    }),
    querySelectorAll: () => sliders,
  };
  const element = () => ({
    querySelector: () => ({
      querySelector: (selector) => (selector === ".rn-duck-volume" ? {} : null),
      append() {},
    }),
  });
  decoratePreviewVolume(element());
  decoratePreviewVolume(element());

  sliders[0].value = 0.5;
  assert.equal(sliders[1].value, 0.5);
  assert.deepEqual(saved, [["previewVolume", 0.5]]);
});
