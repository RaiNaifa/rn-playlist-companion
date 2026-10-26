import { MODULE_ID, t } from "../core/context.mjs";
import { RELEASE_NOTES } from "./release-notes-content.mjs";

const SETTING = "lastSeenReleaseNotesVersion";

export function registerReleaseNotesSettings() {
  game.settings.register(MODULE_ID, SETTING, {
    scope: "user",
    config: false,
    type: String,
    default: "",
  });
}

export function notesToShow(previousVersion, currentVersion, language) {
  const entries = RELEASE_NOTES[language] ?? RELEASE_NOTES.en;
  const isNewer = foundry.utils.isNewerVersion;
  return Object.entries(entries)
    .filter(([version]) => {
      if (!previousVersion) return false;
      return !isNewer(version, currentVersion);
    })
    .sort(([a], [b]) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
}

export async function showReleaseNotesAfterUpdate() {
  if (!game.user?.isGM) return;

  const currentVersion = game.modules.get(MODULE_ID)?.version;
  if (!currentVersion) return;

  const previousVersion = game.settings.get(MODULE_ID, SETTING);
  if (previousVersion === currentVersion) return;

  if (!previousVersion || !foundry.utils.isNewerVersion(currentVersion, previousVersion)) {
    await game.settings.set(MODULE_ID, SETTING, currentVersion);
    return;
  }

  const notes = notesToShow(previousVersion, currentVersion, game.i18n.lang);
  if (notes.length) {
    const html = (value) => foundry.utils.escapeHTML(String(value));
    const checkbox = 'input[name="suppressReleaseNotes"]';
    const isSuppressed = (root) => Boolean(root?.querySelector(checkbox)?.checked);
    let suppressOnClose = false;
    const entries = notes
      .map(
        ([version, items]) =>
          `<section class="rn-release-note"><h3>${html(version)}</h3><ul>${items.map((item) => `<li>${html(item)}</li>`).join("")}</ul></section>`,
      )
      .join("");
    const content = `<div class="rn-release-notes">${entries}</div><label class="rn-release-notes-optout"><input type="checkbox" name="suppressReleaseNotes"> ${t("ReleaseNotes.Suppress")}</label>`;
    const submitted = await foundry.applications.api.DialogV2.wait({
      classes: ["rn-release-notes-dialog"],
      window: { title: t("ReleaseNotes.Title"), resizable: true },
      position: { width: 600 },
      content,
      render: (_event, dialog) => {
        const label = dialog.element?.querySelector(".rn-release-notes-optout");
        const footer = dialog.element?.querySelector("form footer");
        if (!label || !footer) return;
        dialog.element.querySelector(".rn-release-notes")?.parentElement?.classList.add("rn-release-notes-body");
        footer.prepend(label);
      },
      buttons: [
        {
          action: "close",
          label: t("ReleaseNotes.Close"),
          default: true,
          callback: (_event, button) => isSuppressed(button.form),
        },
      ],
      close: (_event, dialog) => {
        suppressOnClose ||= isSuppressed(dialog.element);
      },
    });
    if (!submitted && !suppressOnClose) return;
  }

  await game.settings.set(MODULE_ID, SETTING, currentVersion);
}
