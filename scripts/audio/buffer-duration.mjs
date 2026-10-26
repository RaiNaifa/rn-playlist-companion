import { MODULE_ID } from "../core/context.mjs";

const SETTING = "maxBufferDuration";
const DEFAULT_DURATION = 600;

function applyBufferDuration(value) {
  const seconds = Number(value);
  foundry.audio.Sound.MAX_BUFFER_DURATION = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_DURATION;
}

export function registerBufferDurationSettings() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "RNPLAYCOMP.Settings.MaxBufferDuration.Name",
    hint: "RNPLAYCOMP.Settings.MaxBufferDuration.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: DEFAULT_DURATION,
    onChange: applyBufferDuration,
  });
  applyBufferDuration(game.settings.get(MODULE_ID, SETTING));
}
