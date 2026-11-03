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
