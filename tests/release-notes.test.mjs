import assert from "node:assert/strict";
import test from "node:test";
import { notesToShow, showReleaseNotesAfterUpdate } from "../scripts/ui/release-notes.mjs";
import { RELEASE_NOTES } from "../scripts/ui/release-notes-content.mjs";

globalThis.foundry = {
  utils: {
    isNewerVersion: (a, b) => a.localeCompare(b, "en", { numeric: true }) > 0,
  },
};

test("first launch establishes a baseline, while an upgrade shows all notes newest first", () => {
  RELEASE_NOTES.en = {
    "0.1.0": ["First"],
    "0.2.0": ["Second"],
    "0.3.0": ["Third"],
    "0.4.0": ["Fourth"],
    "0.5.0": ["Fifth"],
  };

  assert.deepEqual(notesToShow("", "0.3.0", "en"), []);
  assert.deepEqual(
    notesToShow("0.1.0", "0.3.0", "en").map(([version]) => version),
    ["0.3.0", "0.2.0", "0.1.0"],
  );
  assert.deepEqual(
    notesToShow("0.3.0", "0.3.0", "en").map(([version]) => version),
    ["0.3.0", "0.2.0", "0.1.0"],
  );
  assert.deepEqual(
    notesToShow("0.4.0", "0.5.0", "en").map(([version]) => version),
    ["0.5.0", "0.4.0", "0.3.0", "0.2.0", "0.1.0"],
  );
});

test("only a GM sees new installed release notes once", async () => {
  let installedVersion = "0.2.0";
  let seenVersion = "";
  let dialogs = 0;
  let suppress = false;
  let checkboxPlacement = "";
  RELEASE_NOTES.en = { "0.3.0": ["New feature"] };
  globalThis.game = {
    user: { isGM: true },
    modules: new Map([
      [
        "rn-playlist-companion",
        {
          get version() {
            return installedVersion;
          },
        },
      ],
    ]),
    settings: {
      get: () => seenVersion,
      set: async (_module, _key, value) => {
        seenVersion = value;
      },
    },
    i18n: { lang: "en", localize: (key) => key },
  };
  foundry.utils.escapeHTML = (value) => value;
  foundry.applications = {
    api: {
      DialogV2: {
        wait: async (config) => {
          dialogs += 1;
          const label = {};
          config.render(null, {
            element: {
              querySelector: (selector) => {
                if (selector === ".rn-release-notes-optout") return label;
                if (selector === "form footer")
                  return {
                    prepend: (node) => {
                      assert.equal(node, label);
                      checkboxPlacement = "footer";
                    },
                    classList: { add: () => {} },
                  };
                if (selector === 'button[data-action="close"]')
                  return {
                    parentElement: {
                      prepend: () => {
                        checkboxPlacement = "header";
                      },
                    },
                  };
                return null;
              },
            },
          });
          return config.buttons[0].callback(null, {
            form: { querySelector: () => ({ checked: suppress }) },
          });
        },
      },
    },
  };

  await showReleaseNotesAfterUpdate();
  assert.equal(seenVersion, "0.2.0");
  assert.equal(dialogs, 0);

  installedVersion = "0.3.0";
  await showReleaseNotesAfterUpdate();
  await showReleaseNotesAfterUpdate();
  assert.equal(seenVersion, "0.2.0");
  assert.equal(dialogs, 2);
  assert.equal(checkboxPlacement, "footer");

  suppress = true;
  await showReleaseNotesAfterUpdate();
  await showReleaseNotesAfterUpdate();
  assert.equal(seenVersion, "0.3.0");
  assert.equal(dialogs, 3);

  RELEASE_NOTES.en["0.4.0"] = ["Another feature"];
  installedVersion = "0.4.0";
  foundry.applications.api.DialogV2.wait = async (config) => {
    config.close(null, { element: { querySelector: () => ({ checked: true }) } });
    return null;
  };
  await showReleaseNotesAfterUpdate();
  assert.equal(seenVersion, "0.4.0");

  game.user.isGM = false;
  installedVersion = "0.5.0";
  await showReleaseNotesAfterUpdate();
  assert.equal(dialogs, 3);
});
