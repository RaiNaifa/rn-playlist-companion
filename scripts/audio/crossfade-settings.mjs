import { MODULE_ID } from "../core/context.mjs";

export const CROSSFADE_ENABLED = "crossfadeEnabled";
export const CROSSFADE_FADE = "crossfadeFade";

export function crossfadeEnabled() {
  return Boolean(globalThis.game?.settings?.get?.(MODULE_ID, CROSSFADE_ENABLED));
}

export function fallbackFade() {
  const value = Number(globalThis.game?.settings?.get?.(MODULE_ID, CROSSFADE_FADE) ?? 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function configuredFade(sound) {
  // Empty fields inherit the next level, while an explicit zero stays zero.
  return Math.max(0, sound.fade ?? sound.parent?.fade ?? (crossfadeEnabled() ? fallbackFade() : 0));
}

export function registerCrossfadeSettings() {
  const refresh = () => {
    for (const panel of document.querySelectorAll(".rn-global-panel")) {
      const enabled = panel.querySelector(".rn-crossfade-toggle");
      const fade = panel.querySelector(".rn-crossfade-duration");
      if (enabled && document.activeElement !== enabled) enabled.checked = crossfadeEnabled();
      if (fade && document.activeElement !== fade) fade.value = String(fallbackFade());
    }
  };
  game.settings.register(MODULE_ID, CROSSFADE_ENABLED, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
    onChange: refresh,
  });
  game.settings.register(MODULE_ID, CROSSFADE_FADE, {
    scope: "world",
    config: false,
    type: Number,
    default: 0,
    onChange: refresh,
  });
}
