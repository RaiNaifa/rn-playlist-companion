import { MODULE_ID } from "../core/context.mjs";

const SETTING = "infoColorForParameterButtons";
const CLASS_NAME = "rn-info-parameter-buttons";

export function registerParameterButtonColors() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.InfoColorForParameterButtons.Name",
    hint: "RNPLAYCOMP.Settings.InfoColorForParameterButtons.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (enabled) => document.documentElement.classList.toggle(CLASS_NAME, enabled),
  });
  document.documentElement.classList.toggle(CLASS_NAME, game.settings.get(MODULE_ID, SETTING));
}
