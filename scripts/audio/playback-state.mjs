import { state } from "../core/context.mjs";

export function storedData(data) {
  const copy = foundry.utils.deepClone(data);
  copy.playing = false;
  for (const sound of copy.sounds ?? []) {
    sound.playing = false;
    sound.pausedTime = null;
  }
  return copy;
}

export function playbackData(data) {
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
  };
}

export function withPlayback(data, saved) {
  const copy = foundry.utils.deepClone(data);
  if (!saved) return copy;
  copy.playing = Boolean(saved.playing);
  for (const sound of copy.sounds ?? []) {
    const state = saved.sounds?.[sound._id];
    sound.playing = Boolean(state?.playing);
    sound.pausedTime = state?.pausedTime ?? null;
  }
  return copy;
}

export function nextPlayback(id, data) {
  const all = foundry.utils.deepClone(state.playbackByWorld);
  all[game.world.id] ??= {};
  const world = all[game.world.id];
  world[id] = playbackData(data);
  return all;
}
