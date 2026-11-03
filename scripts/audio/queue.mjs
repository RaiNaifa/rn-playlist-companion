import { MODULE_ID, reportError } from "../core/context.mjs";

const KEY = "soundQueue";
let transition = Promise.resolve();

export function queueState() {
  return game.settings.get(MODULE_ID, KEY) ?? { entries: [], linked: null };
}

export function queueSound(entry) {
  if (!entry) return null;
  return game.playlists.get(entry.playlistId)?.sounds.get(entry.soundId);
}

export function soundEntry(sound) {
  return { playlistId: sound.parent.id, soundId: sound.id };
}

export function sameSound(a, b) {
  return a?.playlistId === b?.playlistId && a?.soundId === b?.soundId;
}

export function changeQueue(change) {
  // Serialize read-modify-write operations so rapid clicks cannot overwrite earlier queue edits.
  const run = transition.then(async () => {
    const current = queueState();
    await game.settings.set(MODULE_ID, KEY, change({ entries: [...current.entries], linked: current.linked }));
  });
  transition = run.catch(reportError);
  return run;
}

export function addToQueue(sound) {
  return changeQueue((state) => {
    state.entries.push(soundEntry(sound));
    return state;
  });
}

export function toggleQueueLink(sound) {
  return changeQueue((state) => {
    const entry = soundEntry(sound);
    state.linked = sameSound(state.linked, entry) ? null : entry;
    return state;
  });
}

async function startQueuedSound(index) {
  const current = queueState();
  const linked = queueSound(current.linked);
  // Unlink before stopping: a forced stop must never be mistaken for a natural transition.
  await changeQueue((state) => {
    state.linked = null;
    return state;
  });
  if (linked?.playing) await linked.parent.stopSound(linked);
  let next;
  await changeQueue((state) => {
    if (index == null) {
      while (state.entries.length && !next) {
        const entry = state.entries.shift();
        if (queueSound(entry)) next = entry;
      }
    } else {
      const [entry] = state.entries.splice(index, 1);
      if (queueSound(entry)) next = entry;
    }
    state.linked = next ?? null;
    return state;
  });
  const sound = queueSound(next);
  if (sound) await sound.parent.playSound(sound);
}

export function playQueueNext() {
  return startQueuedSound(null);
}

export function playQueueEntry(index) {
  return startQueuedSound(index);
}

export function installQueuePlayback() {
  game.settings.register(MODULE_ID, KEY, {
    scope: "world",
    config: false,
    type: Object,
    default: { entries: [], linked: null },
    onChange: () => ui.playlists?.render(),
  });
  const Playlist = foundry.documents.Playlist;
  const originalEnd = Playlist.prototype._onSoundEnd;
  Playlist.prototype._onSoundEnd = async function (sound) {
    const linked = queueState().linked;
    // Only this sound may replace its playlist's normal end-of-track behavior.
    if (!sameSound(linked, soundEntry(sound)) || sound.repeat) return originalEnd.call(this, sound);
    await playQueueNext();
    return this;
  };
}
