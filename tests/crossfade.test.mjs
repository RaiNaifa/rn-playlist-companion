import assert from "node:assert/strict";
import test from "node:test";
import { cancelActiveCrossfades, installCrossfadePlayback } from "../scripts/audio/crossfade-playback.mjs";
import { configuredFade } from "../scripts/audio/crossfade-settings.mjs";
import { applySeek } from "../scripts/audio/seek.mjs";

test("blank fades inherit sound, playlist, and global values while zero stays explicit", () => {
  const settings = { crossfadeEnabled: true, crossfadeFade: 5000 };
  globalThis.game = { settings: { get: (_module, key) => settings[key] } };
  const playlist = { fade: null };
  const sound = { fade: null, parent: playlist };
  assert.equal(configuredFade(sound), 5000);
  playlist.fade = 2000;
  assert.equal(configuredFade(sound), 2000);
  sound.fade = 0;
  assert.equal(configuredFade(sound), 0);
  sound.fade = null;
  playlist.fade = null;
  settings.crossfadeEnabled = false;
  assert.equal(configuredFade(sound), 0);
  playlist.fade = 2000;
  assert.equal(configuredFade(sound), 2000);
});

test("a transition holds the outgoing sound while the incoming sound starts", async () => {
  const calls = [];
  const settings = { crossfadeEnabled: true, crossfadeFade: 50 };
  globalThis.game = { settings: { get: (_module, key) => settings[key] } };
  globalThis.Hooks = { once: () => {} };
  globalThis.foundry = { utils: { randomID: () => "transition-1" }, documents: {} };
  class PlaylistSound {
    constructor(id, parent, fade = null) {
      this.id = id;
      this.parent = parent;
      this.fade = fade;
      this.volume = 0.8;
      this.playing = id === "old";
      this.sound = {
        playing: id === "old",
        duration: 20,
        currentTime: 1,
        fade: async (volume, options) => calls.push([id, "fade", volume, options.duration]),
        stop: async () => calls.push([id, "stop"]),
      };
    }
    get fadeDuration() {
      return this.fade ?? this.parent.fade ?? 0;
    }
    sync() {
      calls.push([this.id, "sync"]);
    }
  }
  class Playlist {
    constructor() {
      this.id = "playlist";
      this.fade = null;
      this.flags = {};
      this.sounds = new Map();
      for (const id of ["old", "new"]) this.sounds.set(id, new PlaylistSound(id, this));
      this.sounds[Symbol.iterator] = this.sounds.values.bind(this.sounds);
    }
    async update(data) {
      this.flags = data.flags ?? this.flags;
      for (const entry of data.sounds ?? []) this.sounds.get(entry._id).playing = entry.playing;
      for (const sound of this.sounds) sound.sync();
      return this;
    }
  }
  foundry.documents = { Playlist, PlaylistSound };
  installCrossfadePlayback();
  const playlist = new Playlist();
  assert.equal(playlist.sounds.get("old").fadeDuration, 50);
  settings.crossfadeEnabled = false;
  assert.equal(playlist.sounds.get("old").fadeDuration, 0);
  settings.crossfadeEnabled = true;
  await playlist.update({
    sounds: [
      { _id: "old", playing: false },
      { _id: "new", playing: true },
    ],
  });
  assert.equal(playlist.flags["rn-playlist-companion"].crossfadeTransition.to, "new");
  assert.equal(playlist.flags["rn-playlist-companion"].crossfadeTransition.fadeIn, 50);
  assert.deepEqual(calls.slice(0, 2), [
    ["old", "fade", 0, 50],
    ["new", "sync"],
  ]);
  settings.crossfadeEnabled = false;
  settings.crossfadeFade = 0;
  playlist.fade = 0;
  assert.equal(playlist.sounds.get("new").fadeDuration, 50);
  playlist.sounds.get("old").sync();
  assert.equal(
    calls.some(([id, action]) => id === "old" && action === "stop"),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls.at(-1), ["old", "stop"]);
  assert.equal(calls.filter(([id, action]) => id === "old" && action === "stop").length, 1);
  const fades = calls.filter(([id, action]) => id === "old" && action === "fade").length;
  playlist.sounds.get("old").sync();
  assert.equal(calls.filter(([id, action]) => id === "old" && action === "fade").length, fades);
  settings.crossfadeEnabled = true;
  playlist.sounds.get("old").sync();
  assert.equal(calls.filter(([id, action]) => id === "old" && action === "fade").length, fades);

  const silent = new Playlist();
  silent.flags = { "rn-playlist-companion": { silencePending: { tracks: { id: "pause" } } } };
  await silent.update({
    sounds: [
      { _id: "old", playing: false },
      { _id: "new", playing: true },
    ],
  });
  assert.equal(silent.flags["rn-playlist-companion"].crossfadeTransition, undefined);
});

test("returning to a fading track starts a fresh copy from the beginning", async () => {
  const calls = [];
  let id = 0;
  globalThis.game = {
    settings: { get: (_module, key) => (key === "crossfadeEnabled" ? true : 50) },
  };
  globalThis.Hooks = { once: () => {} };
  globalThis.foundry = { utils: { randomID: () => String(++id) }, documents: {} };
  class Audio {
    constructor(name) {
      this.name = name;
      this.playing = false;
      this.currentTime = 0;
      this.duration = 20;
      this.listeners = new Map();
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    async play(options) {
      this.playing = true;
      this.currentTime = 0;
      calls.push([this.name, "play", options.fade]);
      for (const callback of this.listeners.get("play") ?? []) callback();
      return this;
    }
    async fade(volume) {
      calls.push([this.name, "fade", volume]);
    }
    async stop() {
      this.playing = false;
      calls.push([this.name, "stop"]);
      for (const callback of this.listeners.get("stop") ?? []) callback();
    }
  }
  class PlaylistSound {
    constructor(name, parent) {
      this.id = name;
      this.parent = parent;
      this.fade = null;
      this.volume = 1;
      this.playing = name === "A";
      this.repeat = false;
      this.created = 0;
      this.sound = name === "A" ? this._createSound() : null;
    }
    get fadeDuration() {
      return this.fade ?? this.parent.fade ?? 0;
    }
    _createSound() {
      const audio = new Audio(`${this.id}-${++this.created}`);
      audio.addEventListener("end", this._onEnd.bind(this));
      audio.addEventListener("stop", this._onStop.bind(this));
      return audio;
    }
    sync() {
      if (this.playing) {
        this.sound ||= this._createSound();
        if (!this.sound.playing) return this.sound.play({ fade: this.fadeDuration });
      } else if (this.sound?.playing) return this.sound.stop();
    }
    _onEnd() {
      calls.push([this.id, "end"]);
    }
    _onStop() {}
  }
  class Playlist {
    constructor() {
      this.id = "p";
      this.fade = null;
      this.flags = {};
      this.sounds = new Map(["A", "B"].map((name) => [name, new PlaylistSound(name, this)]));
      this.sounds[Symbol.iterator] = this.sounds.values.bind(this.sounds);
    }
    async update(data) {
      this.flags = data.flags ?? this.flags;
      for (const entry of data.sounds) this.sounds.get(entry._id).playing = entry.playing;
      for (const sound of this.sounds.values()) sound.sync();
      return this;
    }
  }
  foundry.documents = { Playlist, PlaylistSound };
  installCrossfadePlayback();
  const playlist = new Playlist();
  const a = playlist.sounds.get("A");
  await a.sound.play({ fade: 0 });
  a.sound.currentTime = 3;
  await playlist.update({
    sounds: [
      { _id: "A", playing: false },
      { _id: "B", playing: true },
    ],
  });
  const oldA = a.sound;
  assert.equal(oldA.playing, true);
  await playlist.update({
    sounds: [
      { _id: "A", playing: true },
      { _id: "B", playing: false },
    ],
  });
  assert.notEqual(a.sound, oldA);
  assert.equal(a.sound.playing, true);
  assert.equal(a.sound.currentTime, 0);
  assert.ok(calls.some((call) => call[0] === "A-2" && call[1] === "play" && call[2] === 50));
  assert.equal(
    calls.some((call) => call[0] === "A-1" && call[1] === "fade" && call[2] === 1),
    false,
  );
});

test("a repeating sound overlaps two instances when no silence is configured", async () => {
  const events = [];
  let tick;
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = (callback) => {
    tick = callback;
    return 1;
  };
  globalThis.Hooks = { once: (_name, callback) => callback(), callAll: () => {} };
  globalThis.game = {
    settings: { get: (_module, key) => (key === "crossfadeEnabled" ? true : 1000) },
    users: [],
    playlists: [],
  };
  globalThis.foundry = { documents: {} };
  class Audio {
    constructor(document) {
      this.document = document;
      this.duration = 10;
      this.currentTime = 0;
      this.playing = false;
      this.listeners = new Map();
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    async load() {
      return this;
    }
    async play() {
      this.playing = true;
      events.push(["play", this]);
      this.listeners.get("play")?.();
      return this;
    }
    async fade(volume) {
      events.push(["fade", this, volume]);
    }
    async stop() {
      this.playing = false;
      events.push(["stop", this]);
      this.document._onStop();
    }
  }
  class PlaylistSound {
    constructor(parent) {
      this.id = "loop";
      this.parent = parent;
      this.playing = true;
      this.repeat = true;
      this.fade = null;
      this.volume = 1;
      this.flags = {};
      this.sound = this._createSound();
    }
    get fadeDuration() {
      return 0;
    }
    _createSound() {
      return new Audio(this);
    }
    _onEnd() {
      events.push(["document-end"]);
    }
    _onStop() {
      events.push(["document-stop"]);
    }
    sync() {}
  }
  class Playlist {
    update() {}
  }
  foundry.documents = { Playlist, PlaylistSound };
  try {
    installCrossfadePlayback();
    const playlist = { id: "p", fade: null, flags: {}, sounds: [] };
    const document = new PlaylistSound(playlist);
    playlist.sounds.push(document);
    game.playlists.push(playlist);
    const old = document.sound;
    await old.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    old.currentTime = 9.2;
    tick();
    await Promise.resolve();
    assert.notEqual(document.sound, old);
    assert.equal(document.sound.playing, true);
    assert.deepEqual(events.find((event) => event[0] === "fade" && event[1] === old)?.slice(0, 1), ["fade"]);
    await new Promise((resolve) => setTimeout(resolve, 1010));
    assert.equal(old.playing, false);
    assert.equal(
      events.some((event) => event[0] === "document-stop"),
      false,
    );
  } finally {
    globalThis.setInterval = originalInterval;
  }
});

test("a failed repeat crossfade falls back for one cycle and tries again on the next", async () => {
  const originalInterval = globalThis.setInterval;
  const originalError = console.error;
  let tick;
  let created = 0;
  const fades = [];
  const errors = [];
  globalThis.setInterval = (callback) => {
    tick = callback;
    return 1;
  };
  console.error = (cause) => errors.push(cause);
  globalThis.Hooks = { once: (_name, callback) => callback(), callAll: () => {} };
  globalThis.game = {
    settings: { get: (_module, key) => (key === "crossfadeEnabled" ? true : 1000) },
    users: [],
    playlists: [],
  };
  globalThis.foundry = { documents: {} };
  class Audio {
    constructor(index) {
      this.index = index;
      this.duration = 10;
      this.element = { duration: 10, currentTime: 0 };
      this.context = { currentTime: 100 };
      this.playing = false;
      this.listeners = new Map();
    }
    get currentTime() {
      return this.element.currentTime;
    }
    set currentTime(value) {
      this.element.currentTime = value;
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    async load() {
      if (this.index === 1) throw new Error("temporary load failure");
      return this;
    }
    async play() {
      if (this.index === 2) throw new Error("temporary play failure");
      this.playing = true;
      this.listeners.get("play")?.();
      return this;
    }
    async fade(volume) {
      fades.push([this.index, volume]);
    }
    async stop() {
      this.playing = false;
    }
  }
  class PlaylistSound {
    constructor(parent) {
      this.id = "loop";
      this.parent = parent;
      this.playing = true;
      this.repeat = true;
      this.volume = 1;
      this.flags = {};
      this.sound = this._createSound();
    }
    _createSound() {
      return new Audio(created++);
    }
    sync() {}
    _onEnd() {}
    _onStop() {}
  }
  class Playlist {
    update() {}
  }
  foundry.documents = { Playlist, PlaylistSound };
  try {
    installCrossfadePlayback();
    const playlist = { id: "p", fade: null, flags: {}, sounds: [] };
    const document = new PlaylistSound(playlist);
    playlist.sounds.push(document);
    game.playlists.push(playlist);
    const original = document.sound;
    await original.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(created, 2);
    original.currentTime = 9.2;
    tick();
    assert.equal(created, 2);
    assert.equal(document.sound, original);
    tick();
    assert.equal(created, 2);
    assert.equal(await applySeek(document, 0.1), true);
    tick();
    assert.equal(created, 2);
    original.currentTime = 9.2;
    tick();
    assert.equal(created, 2);
    original.currentTime = 0.1;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(created, 3);
    original.currentTime = 9.2;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.sound, original);
    assert.equal(original.playing, true);
    assert.equal(created, 3);
    assert.equal(errors.length, 2);
    tick();
    assert.equal(created, 3);
    original.currentTime = 0.1;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(created, 4);
    original.currentTime = 9.2;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.sound.index, 3);
    assert.equal(document.sound.playing, true);
    assert.deepEqual(fades, [[0, 0]]);
    cancelActiveCrossfades();
  } finally {
    globalThis.setInterval = originalInterval;
    console.error = originalError;
  }
});

test("switching tracks waits for the old fade when crossfade is off", async () => {
  const events = [];
  const startedFades = [];
  const settings = { crossfadeEnabled: false, crossfadeFade: 50 };
  globalThis.game = { settings: { get: (_module, key) => settings[key] } };
  globalThis.Hooks = { once: () => {} };
  globalThis.foundry = { documents: {} };
  class Audio {
    static STATES = { STOPPING: "stopping", STOPPED: "stopped" };
    constructor(playing) {
      this.playing = playing;
      this.listeners = new Map();
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) {
      this.listeners.get(name)?.delete(callback);
    }
    stop() {
      events.push("stop requested");
      this.playing = false;
      this._state = Audio.STATES.STOPPING;
      setTimeout(() => {
        this._state = Audio.STATES.STOPPED;
        events.push("stopped");
        for (const callback of this.listeners.get("stop") ?? []) callback();
      }, 20);
    }
  }
  class PlaylistSound {
    constructor(id, parent) {
      this.id = id;
      this.parent = parent;
      this.playing = id === "old";
      this.fade = id === "old" ? 20 : null;
      this.sound = this.playing ? new Audio(true) : undefined;
    }
    _createSound() {
      events.push("create new");
      return new Audio(false);
    }
    get fadeDuration() {
      return configuredFade(this);
    }
    sync() {
      if (!this.playing && this.sound?.playing) this.sound.stop();
      else if (this.playing && !this.sound?.playing) {
        events.push("start new");
        startedFades.push(this.fadeDuration);
      }
    }
  }
  class Playlist {
    constructor() {
      this.id = "p";
      this.flags = {};
      this.sounds = new Map();
      for (const id of ["old", "new"]) this.sounds.set(id, new PlaylistSound(id, this));
      this.sounds[Symbol.iterator] = this.sounds.values.bind(this.sounds);
    }
    async update(data) {
      for (const entry of data.sounds) this.sounds.get(entry._id).playing = entry.playing;
      for (const sound of this.sounds) sound.sync();
    }
  }
  foundry.documents = { Playlist, PlaylistSound };
  installCrossfadePlayback();
  const playlist = new Playlist();
  await playlist.update({
    sounds: [
      { _id: "old", playing: false },
      { _id: "new", playing: true },
    ],
  });
  assert.deepEqual(events, ["stop requested", "create new"]);
  assert.ok(playlist.sounds.get("new").sound);
  assert.equal(playlist.sounds.get("new").playing, true);
  assert.equal(playlist.sounds.get("new").sound.playing, false);
  settings.crossfadeEnabled = true;
  settings.crossfadeFade = 500;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ["stop requested", "create new", "stopped", "start new"]);
  assert.deepEqual(startedFades, [0]);

  settings.crossfadeEnabled = false;
  for (const absentSound of [undefined, { playing: false }]) {
    const nextPlaylist = new Playlist();
    nextPlaylist.sounds.get("old").sound = absentSound;
    await nextPlaylist.update({
      sounds: [
        { _id: "old", playing: false },
        { _id: "new", playing: true },
      ],
    });
  }
  assert.deepEqual(events.slice(4), ["start new", "start new"]);
});

test("editing fade settings does not replace a transition's active fade-in", () => {
  const calls = [];
  const settings = { crossfadeEnabled: true, crossfadeFade: 5000 };
  globalThis.game = { settings: { get: (_module, key) => settings[key] } };
  globalThis.Hooks = { once: () => {} };
  globalThis.foundry = { documents: {} };
  class Audio extends EventTarget {
    playing = false;
  }
  class PlaylistSound {
    constructor(parent) {
      this.id = "sound";
      this.parent = parent;
      this.playing = true;
      this.repeat = false;
      this.volume = 1;
      this.fade = null;
      this.sound = this._createSound();
    }
    get fadeDuration() {
      return this.fade ?? this.parent.fade ?? 0;
    }
    _createSound() {
      return new Audio();
    }
    sync() {
      if (!this.sound.playing) {
        this.sound.playing = true;
        calls.push(["start", this.fadeDuration]);
        this.sound.dispatchEvent(new Event("play"));
      } else calls.push(["adjust", this.volume]);
    }
  }
  class Playlist {
    update() {}
  }
  foundry.documents = { Playlist, PlaylistSound };
  installCrossfadePlayback();
  const parent = { id: "p", fade: null, flags: {}, sounds: new Map() };
  const sound = new PlaylistSound(parent);
  parent.sounds.set(sound.id, sound);
  sound.sync();
  sound.fade = 500;
  parent.fade = 2000;
  settings.crossfadeFade = 100;
  settings.crossfadeEnabled = false;
  sound.sync();
  assert.deepEqual(calls, [["start", 5000]]);
  sound.volume = 0.5;
  sound.sync();
  assert.deepEqual(calls, [
    ["start", 5000],
    ["adjust", 0.5],
  ]);
});

test("scene music starts while the previous scene playlist is stopping", async () => {
  const actions = [];
  const ready = [];
  let enabled = true;
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  globalThis.Hooks = { once: (_name, callback) => ready.push(callback) };
  globalThis.game = {
    settings: { get: (_module, key) => key === "crossfadeEnabled" && enabled },
    user: { id: "gm" },
    users: [{ id: "gm", active: true, isGM: true }],
    scenes: { active: { _source: { playlist: "old" } } },
  };
  globalThis.foundry = { documents: {} };
  class PlaylistSound {
    get fadeDuration() {
      return 0;
    }
    sync() {}
    _createSound() {}
    _onEnd() {}
    _onStop() {}
  }
  class Playlist {
    update() {}
  }
  class Playlists {
    constructor(old, next) {
      this.items = new Map([
        ["old", old],
        ["new", next],
      ]);
      this.scene = "old";
    }
    get(id) {
      return this.items.get(id);
    }
    async _onChangeScene(scene) {
      const previous = this.scene;
      this.scene = scene._source.playlist;
      actions.push(`original:${previous}->${this.scene}`);
      await this.get(previous).stopAll();
      await this.get(this.scene).playAll();
    }
  }
  foundry.documents = { Playlist, PlaylistSound, collections: { Playlists } };
  let release;
  const stopping = new Promise((resolve) => {
    release = resolve;
  });
  const old = {
    playing: true,
    sounds: new Map(),
    stopAll: () => {
      actions.push("stop");
      return stopping;
    },
    playAll: () => Promise.resolve(),
  };
  const selected = {
    id: "sound",
    update(data) {
      actions.push(data.playing ? "play" : "stop-selected");
      if (data.playing === false) this.sound?.stop();
      return Promise.resolve();
    },
  };
  const next = {
    playing: true,
    sounds: new Map([["sound", selected]]),
    stopAll: () => {
      actions.push("stop-new");
      selected.sound?.stop();
      return Promise.resolve();
    },
    playAll: () => {
      actions.push("play-all");
      return Promise.resolve();
    },
  };
  try {
    installCrossfadePlayback();
    for (const callback of ready) callback();
    const collection = new Playlists(old, next);
    const result = collection._onChangeScene({ _source: { playlist: "new", playlistSound: "sound" } });
    assert.deepEqual(actions, ["play", "original:old->new", "stop"]);
    release();
    await result;
    const listeners = new Map();
    selected.playing = true;
    selected.fadeDuration = 20;
    selected.sound = {
      playing: true,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
      stop() {
        setTimeout(() => {
          this.playing = false;
          listeners.get("stop")?.();
        }, 20);
        return Promise.resolve();
      },
    };
    enabled = false;
    const normal = collection._onChangeScene({ _source: { playlist: "old", playlistSound: null } });
    assert.equal(actions.includes("original:new->old"), false);
    await normal;
    assert.equal(actions.includes("original:new->old"), true);
    assert.equal(actions.includes("stop-new"), true);
  } finally {
    globalThis.setInterval = originalInterval;
  }
});

test("scene changes within one playlist follow the selected transition mode", async () => {
  const actions = [];
  const ready = [];
  const originalInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  const settings = { crossfadeEnabled: true, crossfadeFade: 50 };
  globalThis.game = {
    settings: { get: (_module, key) => settings[key] },
    scenes: { active: { _source: { playlist: "p", playlistSound: "old" } } },
  };
  globalThis.Hooks = { once: (_name, callback) => ready.push(callback) };
  globalThis.foundry = { documents: {} };
  class Audio {
    static STATES = { STOPPING: "stopping", STOPPED: "stopped" };
    constructor(playing) {
      this.playing = playing;
      this.listeners = new Map();
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) {
      this.listeners.get(name)?.delete(callback);
    }
    stop() {
      this.playing = false;
      this._state = Audio.STATES.STOPPING;
      setTimeout(() => {
        this._state = Audio.STATES.STOPPED;
        actions.push("stopped");
        for (const callback of this.listeners.get("stop") ?? []) callback();
      }, 20);
      return Promise.resolve();
    }
  }
  class PlaylistSound {
    constructor(id, parent) {
      this.id = id;
      this.parent = parent;
      this.playing = id === "old";
      this.sound = this._createSound();
    }
    get fadeDuration() {
      return configuredFade(this);
    }
    update({ playing }) {
      if (this.playing === playing) return Promise.resolve();
      this.playing = playing;
      if (playing) {
        actions.push(`start:${this.id}:${this.fadeDuration}`);
        this.sound.playing = true;
        for (const callback of this.sound.listeners.get("play") ?? []) callback();
      } else {
        actions.push(`stop:${this.id}`);
        this.sound.stop();
      }
      return Promise.resolve();
    }
    sync() {}
    _createSound() {
      return new Audio(this.playing);
    }
    _onEnd() {}
    _onStop() {}
  }
  class Playlist {
    update() {}
    stopAll() {
      actions.push("stop-all");
      this.playing = false;
      return Promise.resolve();
    }
  }
  class Playlists {
    constructor() {
      this.playlist = new Playlist();
      this.playlist.id = "p";
      this.playlist.playing = true;
      this.playlist.sounds = new Map();
      for (const id of ["old", "new"]) this.playlist.sounds.set(id, new PlaylistSound(id, this.playlist));
      this.current = "old";
    }
    get() {
      return this.playlist;
    }
    async _onChangeScene(scene) {
      if (this.current === scene._source.playlistSound) return;
      actions.push("native");
      await this.playlist.sounds.get(this.current).update({ playing: false });
      this.current = scene._source.playlistSound;
      await this.playlist.sounds.get(this.current).update({ playing: true });
    }
  }
  foundry.documents = { Playlist, PlaylistSound, collections: { Playlists } };
  try {
    installCrossfadePlayback();
    for (const callback of ready) callback();
    const collection = new Playlists();
    await collection._onChangeScene({ _source: { playlist: "p", playlistSound: "new" } });
    assert.deepEqual(actions.slice(0, 3), ["start:new:50", "native", "stop:old"]);
    assert.equal(actions.filter((action) => action.startsWith("start:new")).length, 1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    actions.length = 0;
    settings.crossfadeEnabled = false;
    const transition = collection._onChangeScene({ _source: { playlist: "p", playlistSound: "old" } });
    assert.deepEqual(actions, ["stop:new"]);
    settings.crossfadeEnabled = true;
    settings.crossfadeFade = 500;
    collection.playlist.fade = 2000;
    await transition;
    assert.deepEqual(actions.slice(0, 4), ["stop:new", "stopped", "native", "start:old:0"]);

    actions.length = 0;
    settings.crossfadeEnabled = false;
    const pending = collection._onChangeScene({ _source: { playlist: "p", playlistSound: "new" } });
    assert.deepEqual(actions, ["stop:old"]);
    const restore = collection._onChangeScene({ _source: { playlist: "p", playlistSound: "old" } });
    await Promise.all([pending, restore]);
    assert.equal(
      actions.some((action) => action.startsWith("start:new")),
      false,
    );
    assert.equal(
      actions.some((action) => action.startsWith("start:old")),
      true,
    );

    actions.length = 0;
    const stoppedTransition = collection._onChangeScene({ _source: { playlist: "p", playlistSound: "new" } });
    await collection.playlist.stopAll();
    await stoppedTransition;
    assert.equal(actions.includes("stop-all"), true);
    assert.equal(
      actions.some((action) => action.startsWith("start:new")),
      false,
    );
  } finally {
    globalThis.setInterval = originalInterval;
  }
});
