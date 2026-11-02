import assert from "node:assert/strict";
import test from "node:test";
import { stopPlaylistFully } from "../scripts/ui/playlist-sidebar.mjs";

test("Stop All clears pause positions left behind by Foundry stopAll", async () => {
  const sound = { id: "track", playing: false, pausedTime: 12 };
  const calls = [];
  const playlist = {
    sounds: [sound],
    async stopAll() {
      calls.push("stopAll");
    },
    async update(changes) {
      calls.push(changes);
      Object.assign(sound, changes.sounds[0]);
    },
  };

  await stopPlaylistFully(playlist);

  assert.deepEqual(calls, [
    "stopAll",
    { playing: false, sounds: [{ _id: "track", playing: false, pausedTime: null }] },
  ]);
  assert.equal(sound.pausedTime, null);
});

test("Stop All needs no extra update when Foundry clears the pause", async () => {
  let updated = false;
  const playlist = {
    sounds: [{ id: "track", playing: true, pausedTime: null }],
    async stopAll() {},
    async update() {
      updated = true;
    },
  };

  await stopPlaylistFully(playlist);

  assert.equal(updated, false);
});
