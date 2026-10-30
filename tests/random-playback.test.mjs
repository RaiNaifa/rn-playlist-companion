import assert from "node:assert/strict";
import test from "node:test";
import { installRandomPlayback } from "../scripts/audio/random-playback.mjs";
import { MODULE_ID, state } from "../scripts/core/context.mjs";

function setup(ids, { global = false } = {}) {
  state.playlists.clear();
  state.playbackByWorld = { world: {} };
  globalThis.game = { world: { id: "world" }, i18n: { localize: () => "Random Playback" } };
  globalThis.ui = { playlists: { render() {} } };
  globalThis.Hooks = { on() {} };
  globalThis.CONST = { PLAYLIST_MODES: { DISABLED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 } };
  globalThis.foundry = {
    documents: {
      PlaylistSound: class {
        update() {}
      },
      Playlist: class {
        constructor() {
          this.id = "playlist";
          this.documentName = "Playlist";
          this.mode = 0;
          this.playing = false;
          this.flags = { [MODULE_ID]: { randomPlayback: true, randomHistory: [] } };
          this.sounds = ids.map((id) => ({ id, playing: false, pausedTime: null }));
          this.sounds.get = (id) => this.sounds.find((sound) => sound.id === id);
          this.sounds.has = (id) => Boolean(this.sounds.get(id));
          Object.defineProperty(this.sounds, "size", { get: () => this.sounds.length });
        }

        async update(changes, options = {}) {
          for (const soundChange of changes.sounds ?? []) {
            Object.assign(this.sounds.get(soundChange._id), soundChange);
          }
          if (changes.flags?.[MODULE_ID]) {
            Object.assign(this.flags[MODULE_ID], changes.flags[MODULE_ID]);
          }
          if ("mode" in changes) this.mode = changes.mode;
          this.playing = this.sounds.some((sound) => sound.playing);
          if (global && options.rnRandomHistory) {
            state.playbackByWorld.world.playlist = { randomHistory: options.rnRandomHistory };
          }
          this.lastOptions = options;
          return this;
        }

        playAll() {}
        playNext() {}
        playSound() {}
        stopAll() {}
        stopSound() {}
        cycleMode() {}
        _onSoundEnd() {}
        _onSoundStart() {}
      },
    },
    applications: {
      sheets: {
        PlaylistConfig: class {
          async _prepareContext() {
            return { source: { mode: 0 }, modes: {} };
          }

          _processFormData(_event, _form, formData) {
            return { ...formData };
          }
        },
      },
      sidebar: {
        tabs: {
          PlaylistDirectory: class {
            static PLAYLIST_MODES = {};

            _preparePlaylistContext() {
              return {};
            }
          },
        },
      },
    },
  };
  installRandomPlayback();
  const playlist = new foundry.documents.Playlist();
  if (global) state.playlists.set(playlist.id, playlist);
  return playlist;
}

test("random mode selects each next sound afresh, excludes the current sound, and pops previous history", async () => {
  const playlist = setup(["A", "B", "C"]);
  const originalRandom = Math.random;
  const rolls = [0, 0.99, 0, 0.5];
  Math.random = () => rolls.shift();
  try {
    await playlist.playAll();
    assert.equal(playlist.sounds.find((sound) => sound.playing).id, "A");
    await playlist.playNext();
    assert.equal(playlist.sounds.find((sound) => sound.playing).id, "C");
    await playlist.playNext();
    assert.equal(playlist.sounds.find((sound) => sound.playing).id, "A");
    assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A", "C"]);
    await playlist.playNext(null, { direction: -1 });
    assert.equal(playlist.sounds.find((sound) => sound.playing).id, "C");
    assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A"]);
    await playlist.playNext();
    assert.equal(playlist.sounds.find((sound) => sound.playing).id, "B");
    assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A", "C"]);
  } finally {
    Math.random = originalRandom;
  }
});

test("pause preserves history, stop clears it, and single-track skip buttons do nothing", async () => {
  const playlist = setup(["A", "B"]);
  await playlist.playSound(playlist.sounds.get("A"));
  await playlist.playSound(playlist.sounds.get("B"));
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A"]);
  await playlist.update({ sounds: [{ _id: "B", playing: false, pausedTime: 10 }] });
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A"]);
  await playlist.playAll();
  assert.equal(playlist.sounds.get("B").playing, true);
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A"]);
  await playlist.stopAll();
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, []);

  const single = setup(["only"]);
  await single.playAll();
  const before = single.sounds.get("only");
  await single.playNext();
  await single.playNext(null, { direction: -1 });
  assert.equal(single.sounds.get("only"), before);
  assert.deepEqual(single.flags[MODULE_ID].randomHistory, []);
  await single._onSoundEnd(before);
  assert.equal(single.sounds.get("only").playing, true);
});

test("direct sound playback from scene controls uses random-mode history", async () => {
  const playlist = setup(["A", "B"]);
  const soundA = new foundry.documents.PlaylistSound();
  soundA.id = "A";
  soundA.parent = playlist;
  const soundB = new foundry.documents.PlaylistSound();
  soundB.id = "B";
  soundB.parent = playlist;
  await soundA.update({ playing: true });
  await soundB.update({ playing: true });
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, ["A"]);
  await soundB.update({ playing: false });
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, []);
});

test("global random history stays in world playback state and is capped at 20 sounds", async () => {
  const playlist = setup(["A", "B"], { global: true });
  await playlist.playSound(playlist.sounds.get("A"));
  for (let index = 0; index < 22; index++) await playlist.playNext();
  assert.equal(state.playbackByWorld.world.playlist.randomHistory.length, 20);
  assert.deepEqual(playlist.flags[MODULE_ID].randomHistory, []);
  await playlist.stopAll();
  assert.deepEqual(state.playbackByWorld.world.playlist.randomHistory, []);
});

test("playlist form and mode button expose Random without saving an unsupported mode number", async () => {
  const playlist = setup(["A", "B"]);
  const Config = foundry.applications.sheets.PlaylistConfig;
  const form = new Config();
  form.document = playlist;
  const context = await form._prepareContext();
  assert.equal(context.modes[3], "Random Playback");
  assert.equal(context.source.mode, 3);
  const submitted = form._processFormData(null, null, { mode: "3" });
  assert.equal(submitted.mode, 0);
  assert.equal(submitted.flags[MODULE_ID].randomPlayback, true);
  await playlist.cycleMode();
  assert.equal(playlist.flags[MODULE_ID].randomPlayback, false);
  playlist.mode = CONST.PLAYLIST_MODES.DISABLED;
  await playlist.cycleMode();
  assert.equal(playlist.flags[MODULE_ID].randomPlayback, true);
  assert.equal(playlist.mode, CONST.PLAYLIST_MODES.SEQUENTIAL);
});
