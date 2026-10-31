import assert from "node:assert/strict";
import test from "node:test";
import { playbackData, storedData, withPlayback } from "../scripts/audio/playback-state.mjs";
import { drawDuration, repeatRange, transitionRange } from "../scripts/audio/silence-data.mjs";
import { installSilencePlayback } from "../scripts/audio/silence-playback.mjs";
import { MODULE_ID } from "../scripts/core/context.mjs";

function setup({ repeat = false, tracks = null, repeats = null } = {}) {
  const hooks = new Map();
  globalThis.Hooks = {
    on(name, callback) {
      hooks.set(name, callback);
    },
    once() {},
  };
  globalThis.CONST = { PLAYLIST_MODES: { DISABLED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 } };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    users: [{ id: "gm", active: true, isGM: true }],
    playlists: null,
  };
  globalThis.foundry = {
    utils: {
      randomID: (() => {
        let n = 0;
        return () => String(++n);
      })(),
    },
    documents: {
      PlaylistSound: class {
        _createSound() {
          return { play: async () => ({ playing: true }) };
        }
        _onEnd() {}
      },
      Playlist: class {
        constructor() {
          this.id = "p";
          this.mode = 0;
          this.playing = true;
          this.flags = { [MODULE_ID]: { silenceTime: { tracks, repeat: repeats } } };
          this.sounds = [
            { id: "a", name: "A", playing: true, repeat, flags: {}, parent: this },
            { id: "b", name: "B", playing: false, repeat: false, flags: {}, parent: this },
          ];
          this.sounds.get = (id) => this.sounds.find((sound) => sound.id === id);
        }
        async update(changes) {
          if (changes.flags?.[MODULE_ID]) Object.assign(this.flags[MODULE_ID], changes.flags[MODULE_ID]);
          for (const patch of changes.sounds ?? []) Object.assign(this.sounds.get(patch._id), patch);
          if ("mode" in changes) this.mode = changes.mode;
          if ("playing" in changes) this.playing = changes.playing;
          hooks.get("updatePlaylist")?.(this);
          return this;
        }
        async playAll() {
          return this;
        }
        async playNext() {
          return this;
        }
        async playSound(sound) {
          sound.playing = true;
          return this;
        }
        async stopAll() {
          this.playing = false;
          return this;
        }
        async stopSound(sound) {
          sound.playing = false;
          return this;
        }
        async _onSoundEnd() {
          this.nativeEnd = true;
          return this;
        }
        _getNextSound(id) {
          return this.sounds[id === "a" ? 1 : 0];
        }
        _getPreviousSound(id) {
          return this.sounds[id === "b" ? 0 : 1];
        }
      },
    },
  };
  installSilencePlayback();
  const playlist = new foundry.documents.Playlist();
  game.playlists = new Map([[playlist.id, playlist]]);
  return playlist;
}

test("fixed ranges and per-sound overrides select the effective interval", () => {
  const playlist = setup({ tracks: { enabled: true, min: 2, max: 2 }, repeats: { enabled: true, min: 4, max: 4 } });
  assert.equal(drawDuration(transitionRange(playlist)), 2000);
  assert.equal(drawDuration(repeatRange(playlist.sounds.get("a"))), 4000);
  playlist.sounds.get("a").flags[MODULE_ID] = { repeatSilence: { enabled: true, min: 1, max: 1 } };
  assert.equal(drawDuration(repeatRange(playlist.sounds.get("a"))), 1000);
});

test("stopping a playlist removes its scheduled transition", async () => {
  const playlist = setup({ tracks: { enabled: true, min: 30, max: 30 } });
  await playlist._onSoundEnd(playlist.sounds.get("a"));
  assert.equal(playlist.flags[MODULE_ID].silencePending.tracks.soundId, "a");
  assert.equal(playlist.sounds.get("a").playing, false);
  await playlist.stopAll();
  assert.equal(playlist.flags[MODULE_ID].silencePending, null);
});

test("changing to soundboard removes the track timer and keeps sound repeat timers", async () => {
  const playlist = setup({ repeat: true, repeats: { enabled: true, min: 30, max: 30 } });
  await playlist._onSoundEnd(playlist.sounds.get("a"));
  assert.ok(playlist.flags[MODULE_ID].silencePending.repeats.a);
  await playlist.update({ mode: CONST.PLAYLIST_MODES.DISABLED });
  assert.ok(playlist.flags[MODULE_ID].silencePending.repeats.a);
  await playlist.stopAll();
});

test("changing from sequential to soundboard cancels track silence", async () => {
  const playlist = setup({ tracks: { enabled: true, min: 30, max: 30 } });
  await playlist._onSoundEnd(playlist.sounds.get("a"));
  await playlist.update({ mode: CONST.PLAYLIST_MODES.DISABLED });
  assert.equal(playlist.flags[MODULE_ID].silencePending, null);
});

test("an elapsed track gap advances exactly once", async () => {
  const playlist = setup({ tracks: { enabled: true, min: 0.01, max: 0.01 } });
  await playlist._onSoundEnd(playlist.sounds.get("a"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(playlist.sounds.get("b").playing, true);
  assert.equal(playlist.flags[MODULE_ID].silencePending, null);
});

test("a cancelled gap cannot start its next sound", async () => {
  const playlist = setup({ tracks: { enabled: true, min: 0.02, max: 0.02 } });
  await playlist._onSoundEnd(playlist.sounds.get("a"));
  await playlist.stopAll();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(playlist.sounds.get("b").playing, false);
});

test("global storage restores a pending deadline without storing it in playlist metadata", () => {
  globalThis.foundry = { utils: { deepClone: structuredClone } };
  const pending = { tracks: { id: "wait", soundId: "a", startedAt: 1000, durationMs: 5000 }, repeats: {} };
  const playlist = { flags: { [MODULE_ID]: { silenceTime: {}, silencePending: pending } }, playing: false, sounds: [] };
  const metadata = storedData(playlist);
  assert.equal(metadata.flags[MODULE_ID].silencePending, undefined);
  const playback = playbackData(playlist);
  const restored = withPlayback(metadata, playback);
  assert.deepEqual(restored.flags[MODULE_ID].silencePending, pending);
});

test("simultaneous repeat gaps keep independent timers", async () => {
  const playlist = setup({ repeat: true, repeats: { enabled: true, min: 30, max: 30 } });
  playlist.mode = CONST.PLAYLIST_MODES.SIMULTANEOUS;
  playlist.sounds.get("b").repeat = true;
  playlist.sounds.get("b").playing = true;
  await Promise.all([playlist._onSoundEnd(playlist.sounds.get("a")), playlist._onSoundEnd(playlist.sounds.get("b"))]);
  assert.ok(playlist.flags[MODULE_ID].silencePending.repeats.a);
  assert.ok(playlist.flags[MODULE_ID].silencePending.repeats.b);
  await playlist.stopSound(playlist.sounds.get("a"));
  assert.equal(playlist.flags[MODULE_ID].silencePending.repeats.a, null);
  assert.ok(playlist.flags[MODULE_ID].silencePending.repeats.b);
  await playlist.stopAll();
});
