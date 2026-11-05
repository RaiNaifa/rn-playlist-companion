import { MODULE_ID } from "../core/context.mjs";

const SETTING = "controlHeaderColor";
const PROPERTY = "--rn-control-header-color";

function applyHeaderColor(color) {
  const value = String(color ?? "").trim();
  document.documentElement.classList.toggle("rn-custom-control-header-color", Boolean(value));
  if (value) document.documentElement.style.setProperty(PROPERTY, value);
  else document.documentElement.style.removeProperty(PROPERTY);
}

export function registerHeaderColor() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.ControlHeaderColor.Name",
    hint: "RNPLAYCOMP.Settings.ControlHeaderColor.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.ColorField({ blank: true, nullable: false }),
    input: (field, { input, ...config }) => field.toInput({ ...config, placeholder: "#000000" }),
    default: "#000000",
    onChange: applyHeaderColor,
  });
  applyHeaderColor(game.settings.get(MODULE_ID, SETTING));
}
