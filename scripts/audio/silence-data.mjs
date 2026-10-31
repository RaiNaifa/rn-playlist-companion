import { MODULE_ID } from "../core/context.mjs";

export function silenceSettings(playlist) {
  return playlist?.flags?.[MODULE_ID]?.silenceTime ?? {};
}

export function pendingSilence(playlist) {
  return playlist?.flags?.[MODULE_ID]?.silencePending ?? null;
}

export function enabledRange(settings) {
  if (!settings?.enabled) return null;
  const min = Number(settings.min);
  const max = Number(settings.max);
  return Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max >= min ? { min, max } : null;
}

export function repeatRange(sound) {
  const own = sound?.flags?.[MODULE_ID]?.repeatSilence;
  return own?.enabled ? enabledRange(own) : enabledRange(silenceSettings(sound?.parent).repeat);
}

export function transitionRange(playlist) {
  return enabledRange(silenceSettings(playlist).tracks);
}

export function drawDuration(range) {
  return Math.round((range.min + Math.random() * (range.max - range.min)) * 1000);
}
