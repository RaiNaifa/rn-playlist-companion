const repeatCycles = new WeakMap();

export function repeatCycle(audio) {
  let state = repeatCycles.get(audio);
  if (!state) {
    state = { number: 0, position: null, failed: null };
    repeatCycles.set(audio, state);
  }
  return state;
}

export function noteRepeatSeek(audio, position) {
  const cycle = repeatCycles.get(audio);
  // A user seek should not look like a natural loop to the repeat watcher.
  if (cycle) cycle.position = position;
}
