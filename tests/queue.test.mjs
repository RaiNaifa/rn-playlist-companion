import assert from "node:assert/strict";
import { test } from "node:test";

test("Next starts the first queued sound without an existing linked sound", async () => {
  let state = { entries: [{ playlistId: "p", soundId: "s" }], linked: null };
  const played = [];
  const sound = { id: "s" };
  const playlist = { sounds: new Map([["s", sound]]), playSound: async (item) => played.push(item) };
  sound.parent = playlist;
  globalThis.game = {
    playlists: new Map([["p", playlist]]),
    settings: {
      get: () => state,
      set: async (_module, _key, next) => {
        state = next;
      },
    },
  };
  const { playQueueNext } = await import("../scripts/audio/queue.mjs");
  await playQueueNext();
  assert.deepEqual(played, [sound]);
  assert.deepEqual(state.entries, []);
  assert.deepEqual(state.linked, { playlistId: "p", soundId: "s" });
});

test("Play in the queue stops the linked sound and links the selected sound", async () => {
  let state = {
    entries: [
      { playlistId: "p", soundId: "first" },
      { playlistId: "p", soundId: "selected" },
    ],
    linked: { playlistId: "p", soundId: "playing" },
  };
  const actions = [];
  const playlist = {
    sounds: new Map(),
    stopSound: async (sound) => actions.push(`stop:${sound.id}`),
    playSound: async (sound) => actions.push(`play:${sound.id}`),
  };
  for (const id of ["playing", "first", "selected"])
    playlist.sounds.set(id, { id, parent: playlist, playing: id === "playing" });
  globalThis.game = {
    playlists: new Map([["p", playlist]]),
    settings: {
      get: () => state,
      set: async (_module, _key, next) => {
        state = next;
      },
    },
  };
  const { playQueueEntry } = await import("../scripts/audio/queue.mjs");
  await playQueueEntry(1);
  assert.deepEqual(actions, ["stop:playing", "play:selected"]);
  assert.deepEqual(state.entries, [{ playlistId: "p", soundId: "first" }]);
  assert.deepEqual(state.linked, { playlistId: "p", soundId: "selected" });
});
