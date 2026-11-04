import assert from "node:assert/strict";
import test from "node:test";
import { applySeek, clampSeek, requestSeek, seekRange } from "../scripts/audio/seek.mjs";

const bounded = {
  path: "track.ogg",
  flags: { "rn-playlist-companion": { bounds: { path: "track.ogg", start: 10, end: 40 } } },
};

test("seek stays inside the selected section and leaves 100 ms at the end", () => {
  const audio = { buffer: { duration: 90 } };
  assert.deepEqual(seekRange(bounded, audio), { start: 10, end: 40, maximum: 39.9 });
  assert.equal(clampSeek(bounded, audio, 0), 10);
  assert.equal(clampSeek(bounded, audio, 50), 39.9);
});

test("a paused sound changes its resume position without starting playback", async () => {
  const updates = [];
  const document = {
    ...bounded,
    playing: false,
    pausedTime: 18,
    sound: { buffer: { duration: 90 } },
    update: async (change) => updates.push(change),
  };
  assert.equal(await applySeek(document, 25), true);
  assert.deepEqual(updates, [{ pausedTime: 25 }]);
});

test("a playing sound reuses its Sound and publishes one seek command", async () => {
  const calls = [];
  globalThis.game = { user: { id: "gm" }, socket: { emit: (_channel, message) => calls.push(message) } };
  const audio = {
    playing: true,
    buffer: { duration: 90 },
    loop: true,
    pause() {
      calls.push("pause");
    },
    async play(options) {
      calls.push(options);
    },
  };
  const document = {
    ...bounded,
    id: "sound",
    volume: 0.4,
    parent: { id: "playlist", isOwner: true },
    playing: true,
    sound: audio,
  };
  assert.equal(await requestSeek(document, 20), true);
  assert.deepEqual(calls[0], "pause");
  assert.equal(audio.pausedTime, 20);
  assert.deepEqual(calls[1], { offset: 0, volume: 0.4, loop: true });
  assert.equal(calls[2].type, "seek");
  assert.deepEqual(calls[2].payload, { playlistId: "playlist", soundId: "sound", seconds: 20 });
});

test("a streaming sound seeks its element without stopping or replacing it", async () => {
  const audio = {
    playing: true,
    element: { duration: 90, currentTime: 4 },
    context: { currentTime: 100 },
    stop() {
      throw new Error("stream must stay loaded");
    },
  };
  const document = { ...bounded, volume: 0.7, playing: true, sound: audio };
  assert.equal(await applySeek(document, 30), true);
  assert.equal(audio.element.currentTime, 30);
  assert.equal(audio.startTime, 70);
  assert.equal(audio.volume, 0.7);
});

test("rapid buffered seeks apply and broadcast only the latest pending position", async () => {
  let releaseFirst;
  const firstPlay = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const sent = [];
  globalThis.game = { user: { id: "gm" }, socket: { emit: (_channel, message) => sent.push(message) } };
  const positions = [];
  const audio = {
    playing: true,
    buffer: { duration: 90 },
    loop: false,
    pause() {
      this.playing = false;
    },
    async play() {
      positions.push(this.pausedTime);
      if (positions.length === 1) await firstPlay;
      this.playing = true;
    },
  };
  const document = {
    ...bounded,
    id: "sound",
    volume: 0.4,
    parent: { id: "playlist", isOwner: true },
    playing: true,
    sound: audio,
  };
  const first = requestSeek(document, 15);
  const second = requestSeek(document, 20);
  const last = requestSeek(document, 30);
  releaseFirst();
  await Promise.all([first, second, last]);
  assert.deepEqual(positions, [15, 30]);
  assert.deepEqual(
    sent.map((message) => message.payload.seconds),
    [30],
  );
});
