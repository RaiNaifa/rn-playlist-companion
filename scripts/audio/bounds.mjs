import { MODULE_ID } from "../core/context.mjs";

export const DEFAULT_THRESHOLD = -60;
export const SUPPORTED_AUDIO = /\.(?:aac|flac|m4a|mp3|ogg|opus|wav|webm)(?:[?#]|$)/i;

export function effectiveThreshold(override, fallback = DEFAULT_THRESHOLD) {
  const value =
    override === null || override === undefined || override === ""
      ? fallback
      : Number(typeof override === "string" ? override.replace(",", ".") : override);
  if (!Number.isFinite(value) || value < -120 || value > 0)
    throw new Error("Threshold must be between -120 and 0 dBFS.");
  return value;
}

export function readBounds(sound, duration = undefined) {
  const data = sound?.flags?.[MODULE_ID]?.bounds;
  if (!data) return null;
  const start = Number(data.start);
  const end = Number(data.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  if (Number.isFinite(duration) && (duration <= start || end > duration + 0.5)) return null;
  if (data.path !== sound.path) return null;
  // Browser metadata and decoded duration can differ slightly for compressed audio.
  return { start, end: Number.isFinite(duration) ? Math.min(end, duration) : end };
}

export function detectBounds(buffer, thresholdDb, { windowSeconds = 0.02, consecutive = 3, margin = 0.03 } = {}) {
  const threshold = 10 ** (effectiveThreshold(thresholdDb) / 20);
  const samples = Math.max(1, Math.round(buffer.sampleRate * windowSeconds));
  const count = Math.ceil(buffer.length / samples);
  const required = Math.max(1, Math.min(consecutive, count));
  const active = new Uint8Array(count);
  // Peak RMS across channels keeps a quiet mono source audible. Consecutive
  // active windows prevent one click from defining the start or end.
  for (let window = 0; window < count; window++) {
    const from = window * samples;
    const to = Math.min(from + samples, buffer.length);
    let power = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      let sum = 0;
      for (let index = from; index < to; index++) sum += data[index] ** 2;
      power = Math.max(power, Math.sqrt(sum / (to - from)));
    }
    active[window] = Number(power >= threshold);
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i <= count - required; i++) {
    if (active.slice(i, i + required).every(Boolean)) {
      first = i;
      break;
    }
  }
  for (let i = count - required; i >= 0; i--) {
    if (active.slice(i, i + required).every(Boolean)) {
      last = i + required;
      break;
    }
  }
  if (first < 0 || last < 0) return { silent: true, duration: buffer.duration };
  return {
    silent: false,
    duration: buffer.duration,
    start: Math.max(0, (first * samples) / buffer.sampleRate - margin),
    end: Math.min(buffer.duration, (last * samples) / buffer.sampleRate + margin),
  };
}
