import assert from "node:assert/strict";
import test from "node:test";
import { boundedPlayingTime, patchPlayingTimer } from "../scripts/ui/playing-timer.mjs";

function boundedSound({ buffered = false, playing = true } = {}) {
  const sound = {
    id: "track",
    path: "track.ogg",
    flags: { "rn-playlist-companion": { bounds: { start: 15, end: 45, path: "track.ogg" } } },
    playing,
    pausedTime: 27,
    sound: buffered
      ? { buffer: { duration: 90 }, currentTime: 27, duration: 30 }
      : { element: { duration: 90 }, currentTime: 27, duration: 90 },
  };
  return sound;
}

test("bounded timers use the selected section for buffered, streamed, and paused sounds", () => {
  assert.deepEqual(boundedPlayingTime(boundedSound({ buffered: true })), { current: 12, duration: 30 });
  assert.deepEqual(boundedPlayingTime(boundedSound()), { current: 12, duration: 30 });
  assert.deepEqual(boundedPlayingTime(boundedSound({ playing: false })), { current: 12, duration: 30 });
  const sound = boundedSound();
  sound.sound.currentTime = 100;
  assert.deepEqual(boundedPlayingTime(sound), { current: 30, duration: 30 });
  sound.flags["rn-playlist-companion"].bounds.path = "another.ogg";
  assert.equal(boundedPlayingTime(sound), null);
});

test("playlist context shows section time for world and global playlists alike", () => {
  class Directory {
    static formatTimestamp(seconds) {
      return String(seconds);
    }
    _preparePlaylistContext() {
      return { sounds: [{ id: "track", currentTime: "27", durationTime: "90", duration: "90" }] };
    }
    updateTimestamps() {}
  }
  patchPlayingTimer(Directory);
  for (const global of [false, true]) {
    const sound = boundedSound();
    const playlist = { global, sounds: { get: () => sound } };
    const entry = new Directory()._preparePlaylistContext({}, playlist).sounds[0];
    assert.equal(entry.currentTime, "12");
    assert.equal(entry.durationTime, "30");
    assert.equal(entry.duration, "30");
  }
});

test("collapsed playlists still update their Currently Playing context", () => {
  class Directory {
    static formatTimestamp(seconds) {
      return String(seconds);
    }
    _playing = { context: [{ id: "track", playlistId: "playlist", currentTime: "27", durationTime: "90" }] };
    _preparePlaylistContext() {
      return { sounds: [] };
    }
    updateTimestamps() {}
  }
  patchPlayingTimer(Directory);
  const directory = new Directory();
  const playlist = { id: "playlist", sounds: { get: () => boundedSound() } };
  directory._preparePlaylistContext({}, playlist);
  assert.equal(directory._playing.context[0].currentTime, "12");
  assert.equal(directory._playing.context[0].durationTime, "30");
});

test("the running Currently Playing timer stays relative to the selected section", () => {
  const sound = boundedSound({ buffered: true });
  const current = { textContent: "" };
  const duration = { textContent: "" };
  const row = {
    dataset: { playlistId: "playlist", soundId: "track" },
    querySelector: (selector) => (selector === ".current" ? current : duration),
  };
  globalThis.document = {
    querySelectorAll: () => [{ querySelectorAll: () => [row] }],
  };
  globalThis.game = {
    playlists: { get: () => ({ sounds: { get: () => sound } }) },
  };
  class Directory {
    static formatTimestamp(seconds) {
      return String(seconds);
    }
    updateTimestamps() {
      current.textContent = "27";
      duration.textContent = "90";
    }
  }
  patchPlayingTimer(Directory);
  const directory = new Directory();
  directory.updateTimestamps();
  assert.equal(current.textContent, "12");
  assert.equal(duration.textContent, "30");
  sound.sound.currentTime = 32;
  directory.updateTimestamps();
  assert.equal(current.textContent, "17");
});
