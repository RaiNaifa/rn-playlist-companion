import { MODULE_ID, reportError, state } from "../core/context.mjs";
import { openConflictDialog } from "../ui/conflict-dialog.mjs";
import { resolveLocalConflict } from "./conflicts.mjs";
import { onGlobalDataApplied } from "./global-library.mjs";

let conflictTask;
let reportedConflicts = new Set();

export function handleConflicts({ manual = false } = {}) {
  if (!game.user.isGM || !state.ready) return Promise.resolve();
  if (conflictTask) return conflictTask;
  conflictTask = (async () => {
    if (manual) return openConflictDialog({ showEmpty: true });
    if (!state.conflicts.length) return;
    const mode = game.settings.get(MODULE_ID, "conflictResolution");
    const newConflicts = state.conflicts.filter(
      (conflict) => !reportedConflicts.has(`${conflict.type}:${conflict.id}`),
    );
    if (mode === "local") {
      if (!newConflicts.length) return;
      for (const conflict of newConflicts) reportedConflicts.add(`${conflict.type}:${conflict.id}`);
      ui.notifications.info(
        game.i18n.format("RNPLAYCOMP.Notifications.LocalPriority", { count: state.conflicts.length }),
      );
      return;
    }
    if (mode === "both") {
      // Only one active GM may rewrite IDs. Simultaneous automatic resolutions would duplicate local copies.
      const activeGMs = [...(game.users ?? [])]
        .filter((user) => user.active && user.isGM)
        .sort((a, b) => a.id.localeCompare(b.id));
      if (activeGMs.length && activeGMs[0].id !== game.user.id) return;
      let resolved = 0;
      while (state.conflicts.length) {
        const { type, id } = state.conflicts[0];
        await resolveLocalConflict(type, id);
        resolved++;
      }
      ui.notifications.info(game.i18n.format("RNPLAYCOMP.Notifications.AutoResolved", { count: resolved }));
      return;
    }
    if (!newConflicts.length) return;
    for (const conflict of newConflicts) reportedConflicts.add(`${conflict.type}:${conflict.id}`);
    await openConflictDialog();
    if (state.conflicts.length) ui.notifications.warn(game.i18n.localize("RNPLAYCOMP.Notifications.Unresolved"));
  })().finally(() => {
    conflictTask = null;
  });
  return conflictTask;
}

export function registerConflictSettings() {
  class ConflictSettingsMenu extends foundry.applications.api.ApplicationV2 {
    render() {
      handleConflicts({ manual: true }).catch(reportError);
      return this;
    }
  }
  game.settings.registerMenu(MODULE_ID, "globalIdConflicts", {
    name: "RNPLAYCOMP.UI.ResolveConflicts",
    label: "RNPLAYCOMP.UI.ResolveConflictsButton",
    hint: "RNPLAYCOMP.Settings.ConflictMenu.Hint",
    icon: "fa-solid fa-link-slash",
    type: ConflictSettingsMenu,
    restricted: true,
  });
  game.settings.register(MODULE_ID, "conflictResolution", {
    name: "RNPLAYCOMP.Settings.ConflictResolution.Name",
    hint: "RNPLAYCOMP.Settings.ConflictResolution.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      local: "RNPLAYCOMP.Settings.ConflictResolution.Local",
      both: "RNPLAYCOMP.Settings.ConflictResolution.Both",
      ask: "RNPLAYCOMP.Settings.ConflictResolution.Ask",
    },
    default: "ask",
    onChange: () => {
      reportedConflicts = new Set();
      handleConflicts().catch(reportError);
    },
  });
  onGlobalDataApplied(() => handleConflicts().catch(reportError));
}
