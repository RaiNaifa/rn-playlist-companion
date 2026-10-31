import { MODULE_ID, state } from "../core/context.mjs";

export const RANDOM_HISTORY_LIMIT = 20;

export function storedData(data) {
  const copy = foundry.utils.deepClone(data);
  if (copy.flags?.[MODULE_ID]) {
    delete copy.flags[MODULE_ID].randomHistory;
    delete copy.flags[MODULE_ID].silencePending;
  }
  copy.playing = false;
  for (const sound of copy.sounds ?? []) {
    sound.playing = false;
    sound.pausedTime = null;
  }
  return copy;
}

export function playbackData(data, randomHistory) {
  return {
    playing: Boolean(data.playing),
    sounds: Object.fromEntries(
      (data.sounds ?? []).map((sound) => [
        sound._id,
        {
          playing: Boolean(sound.playing),
          pausedTime: sound.pausedTime ?? null,
        },
      ]),
    ),
    ...(randomHistory !== undefined ? { randomHistory } : {}),
    silencePending: data.flags?.[MODULE_ID]?.silencePending ?? null,
  };
}

export function withPlayback(data, saved) {
  const copy = foundry.utils.deepClone(data);
  if (!saved) return copy;
  if (saved.silencePending) {
    copy.flags ??= {};
    copy.flags[MODULE_ID] ??= {};
    copy.flags[MODULE_ID].silencePending = saved.silencePending;
  }
  copy.playing = Boolean(saved.playing);
  for (const sound of copy.sounds ?? []) {
    const state = saved.sounds?.[sound._id];
    sound.playing = Boolean(state?.playing);
    sound.pausedTime = state?.pausedTime ?? null;
  }
  return copy;
}

export function nextPlayback(id, data, randomHistory) {
  const all = foundry.utils.deepClone(state.playbackByWorld);
  all[game.world.id] ??= {};
  const world = all[game.world.id];
  world[id] = playbackData(data, randomHistory ?? world[id]?.randomHistory);
  return all;
}
