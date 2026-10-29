import assert from "node:assert/strict";
import test from "node:test";
import { state } from "../scripts/core/context.mjs";
import { registerConfigSavePlayback, safeConfigChanges } from "../scripts/ui/config-save-playback.mjs";

const settings = new Map();
class PlaylistConfig {
  async _processSubmitData(_event, _form, data) {
    return data;
  }
}
class PlaylistSoundConfig extends PlaylistConfig {
  async _processSubmitData(_event, _form, data) {
    return data;
  }
}

globalThis.game = {
  settings: {
    register: (_module, key, config) => settings.set(key, config.default),
    get: (_module, key) => settings.get(key),
  },
};
globalThis.Hooks = { on: () => {} };
globalThis.foundry = {
  applications: { sheets: { PlaylistConfig, PlaylistSoundConfig } },
  audio: { AudioHelper: { inputToVolume: (value) => value } },
};
registerConfigSavePlayback();

function document(kind, global = false) {
  const source =
    kind === "sound"
      ? { channel: null, name: "Before", volume: 0.5, repeat: false, fade: 100, flags: {} }
      : { channel: null, name: "Before", mode: 0, sorting: "m", fade: 100 };
  const doc = {
    id: kind,
    documentName: kind === "sound" ? "PlaylistSound" : "Playlist",
    _source: source,
    collection: { has: () => true },
    updateSource(data) {
      return Object.fromEntries(
        Object.entries(data).filter(([key, value]) => JSON.stringify(source[key]) !== JSON.stringify(value)),
      );
    },
  };
  if (kind === "playlist") {
    doc.sounds = [
      { id: "first", playing: true },
      { id: "second", playing: false },
    ];
  } else {
    doc.parent = { id: "playlist", documentName: "Playlist" };
  }
  if (global) state.playlists.set(kind === "sound" ? "playlist" : doc.id, doc);
  else state.playlists.clear();
  return doc;
}

async function submit(kind, global, enabled, data) {
  settings.set("keepPlayingOnConfigSave", enabled);
  const sheet = kind === "sound" ? new PlaylistSoundConfig() : new PlaylistConfig();
  sheet.document = document(kind, global);
  return sheet._processSubmitData(null, null, data);
}

test("disabled setting preserves Foundry's local form and stops global config saves", async () => {
  const local = await submit("sound", false, false, { channel: null, name: "Before", volume: 0.5 });
  assert.equal(Object.hasOwn(local, "playing"), false);
  assert.equal(Object.hasOwn(local, "channel"), true);
  const global = await submit("sound", true, false, { channel: null, name: "Before", volume: 0.5 });
  assert.equal(global.playing, false);
  assert.equal(global.pausedTime, null);
  const playlist = await submit("playlist", true, false, { channel: null, name: "Before" });
  assert.equal(playlist.playing, false);
  assert.deepEqual(
    playlist.sounds.map(({ playing }) => playing),
    [false, false],
  );
});

test("enabled setting preserves playback for listed changes in local and global forms", async () => {
  for (const global of [false, true]) {
    const sound = await submit("sound", global, true, {
      channel: null,
      name: "After",
      volume: 0.7,
      repeat: true,
      fade: 200,
    });
    assert.equal(Object.hasOwn(sound, "channel"), false);
    assert.equal(Object.hasOwn(sound, "playing"), false);
    const playlist = await submit("playlist", global, true, { channel: null, mode: 1, sorting: "a" });
    assert.equal(Object.hasOwn(playlist, "channel"), false);
    assert.equal(Object.hasOwn(playlist, "playing"), false);
  }
});

test("unknown properties and changed audio channels stop playback while preserving submitted fields", async () => {
  for (const global of [false, true]) {
    const sound = await submit("sound", global, true, { channel: "environment", customProperty: 3, volume: 0.5 });
    assert.equal(sound.playing, false);
    assert.equal(sound.channel, "environment");
    assert.equal(sound.customProperty, 3);
    const playlist = await submit("playlist", global, true, { channel: null, customProperty: 3 });
    assert.equal(playlist.playing, false);
    assert.equal(playlist.customProperty, 3);
  }
});

test("only the module's silence threshold flag is safe", () => {
  assert.equal(safeConfigChanges({ flags: { "rn-playlist-companion": { threshold: -40 } } }, true), true);
  assert.equal(safeConfigChanges({ flags: { "rn-playlist-companion": { bounds: {} } } }, true), false);
  assert.equal(safeConfigChanges({ flags: { otherModule: { setting: 1 } } }, true), false);
});
