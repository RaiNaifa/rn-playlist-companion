import { MODULE_ID, reportError, state } from "../core/context.mjs";

const SETTING = "disableRevisionChecks";

export function registerRevisionControlSetting() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.DisableRevisionChecks.Name",
    hint: "RNPLAYCOMP.Settings.DisableRevisionChecks.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: false,
    onChange: () => {
      if (!state.ready) return;
      state.stale = true;
      const pendingWrites = state.queue;
      pendingWrites
        .then(() => import("../library/global-library.mjs"))
        .then(({ reloadGlobalPlaylists }) => reloadGlobalPlaylists())
        .catch(reportError);
    },
  });
}

export function revisionChecksDisabled() {
  return game.settings.get(MODULE_ID, SETTING) === true;
}

export function revisionMessage(saved) {
  return saved?.revisionChecksDisabled ? {} : { revision: saved?.revision ?? state.revision };
}
