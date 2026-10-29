import assert from "node:assert/strict";
import test from "node:test";
import { detectBounds, effectiveThreshold, readBounds, SUPPORTED_AUDIO } from "../scripts/audio/bounds.mjs";
import { storedData } from "../scripts/audio/playback-state.mjs";

function fixture(values, sampleRate = 1000) {
  const data = Float32Array.from(values);
  return {
    sampleRate,
    length: data.length,
    duration: data.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

test("silence search accepts Foundry audio formats except MIDI", () => {
  for (const extension of ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"]) {
    assert.equal(SUPPORTED_AUDIO.test(`audio/file.${extension}?version=1`), true);
  }
  assert.equal(SUPPORTED_AUDIO.test("audio/file.mid"), false);
});

test("silence detection finds both ends and ignores one isolated peak", () => {
  const values = new Array(1000).fill(0);
  values[40] = 1;
  values.fill(0.2, 200, 700);
  const result = detectBounds(fixture(values), -60, { margin: 0 });
  assert.equal(result.silent, false);
  assert.ok(result.start >= 0.19 && result.start <= 0.2);
  assert.ok(result.end >= 0.7 && result.end <= 0.72);
});

test("silent file and threshold override are explicit", () => {
  assert.deepEqual(detectBounds(fixture(new Array(100).fill(0)), -80).silent, true);
  assert.equal(effectiveThreshold(null, -80), -80);
  assert.equal(effectiveThreshold(-50, -80), -50);
  assert.throws(() => effectiveThreshold(Infinity));
  assert.throws(() => effectiveThreshold(-121));
});

test("short and fully audible files retain their full duration", () => {
  const short = detectBounds(fixture(new Array(10).fill(0.1)), -80);
  assert.equal(short.silent, false);
  assert.equal(short.start, 0);
  assert.equal(short.end, 0.01);
});

test("a weak noise floor is ignored or retained according to dBFS threshold", () => {
  const samples = new Array(1000).fill(10 ** (-90 / 20));
  samples.fill(10 ** (-60 / 20), 250, 750);
  const musicOnly = detectBounds(fixture(samples), -80, { margin: 0 });
  const withNoise = detectBounds(fixture(samples), -100, { margin: 0 });
  assert.ok(musicOnly.start >= 0.24 && musicOnly.end <= 0.76);
  assert.equal(withNoise.start, 0);
  assert.equal(withNoise.end, 1);
});

test("boundaries are rejected after a path change or if outside duration", () => {
  const sound = {
    path: "one.ogg",
    flags: {
      "rn-playlist-companion": {
        bounds: { start: 1, end: 3, path: "one.ogg" },
      },
    },
  };
  assert.deepEqual(readBounds(sound, 4), { start: 1, end: 3 });
  assert.equal(readBounds(sound, 2), null);
  sound.path = "two.ogg";
  assert.equal(readBounds(sound, 4), null);
});

test("global playlist storage retains sound flags while clearing playback state", () => {
  globalThis.foundry = { utils: { deepClone: structuredClone } };
  const playlist = {
    playing: true,
    sounds: [
      {
        playing: true,
        pausedTime: 2,
        flags: { "rn-playlist-companion": { bounds: { start: 1, end: 3, path: "music.ogg" } } },
      },
    ],
  };
  const stored = storedData(playlist);
  assert.equal(stored.sounds[0].playing, false);
  assert.equal(stored.sounds[0].flags["rn-playlist-companion"].bounds.end, 3);
});
