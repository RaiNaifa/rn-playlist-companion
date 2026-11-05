import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginMiniPlayerTransition,
  endMiniPlayerTransition,
  openMiniPlayer,
  refreshMiniPlayer,
} from "../scripts/ui/mini-player.mjs";

test("player companion opens independently, focuses on repeat click, and reopens after closing", async () => {
  const instances = [];
  const windows = [];
  class BaseDirectory {
    async _onFirstRender() {}
  }
  class Directory extends BaseDirectory {
    constructor() {
      super();
      this.rendered = false;
      this.focuses = 0;
      this.renders = [];
      this.replacements = 0;
      instances.push(this);
    }
    render(options) {
      this.rendered = true;
      this.renders.push(options);
      return Promise.resolve(this);
    }
    bringToFront() {
      this.focuses++;
    }
    setPosition(position) {
      return position;
    }
    async close() {
      this.rendered = false;
    }
    async _onRender() {}
    _onClose() {}
    _replaceHTML() {
      this.replacements++;
    }
    _configureRenderOptions() {}
    updateTimestamps() {}
  }
  class Application {
    constructor() {
      this.rendered = false;
      this.focuses = 0;
      this.host = { children: [], replaceChildren: (...children) => (this.host.children = children) };
      this.element = { querySelector: () => this.host };
      windows.push(this);
    }
    async render() {
      this.rendered = true;
      await this._onRender();
      return this;
    }
    async _onRender() {}
    async renderChild(child, options) {
      child._insertElement({ id: "directory-element" });
      await child.render(options);
      return child;
    }
    bringToFront() {
      this.focuses++;
    }
    setPosition(position) {
      return position;
    }
    async close() {
      this.rendered = false;
    }
  }
  globalThis.foundry = {
    applications: { api: { ApplicationV2: Application }, sidebar: { tabs: { PlaylistDirectory: Directory } } },
  };
  const listeners = [];
  const audio = {
    playing: false,
    addEventListener: (type, listener) => listeners.push({ type, listener }),
  };
  globalThis.game = {
    i18n: { localize: (key) => key },
    playlists: [{ sounds: [{ playing: true, sound: audio }] }],
  };
  openMiniPlayer();
  openMiniPlayer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 1);
  assert.equal(windows.length, 1);
  assert.equal(instances[0]._volumeExpanded, false);
  await instances[0]._onRender();
  assert.equal(instances[0].active, true);
  const partialRender = { parts: ["playing"] };
  instances[0]._configureRenderOptions(partialRender);
  assert.deepEqual(partialRender.parts, ["directory", "playing"]);
  assert.deepEqual(windows[0].host.children, [{ id: "directory-element" }]);
  assert.equal(windows[0].focuses, 1);
  assert.deepEqual(windows[0].constructor.DEFAULT_OPTIONS.classes, ["rn-player-companion-window"]);
  assert.notEqual(
    windows[0].constructor.DEFAULT_OPTIONS.id,
    instances[0].constructor.tabName,
    "The directory must not replace the parent window's element in Foundry",
  );
  assert.equal(Object.hasOwn(windows[0].constructor.prototype, "setPosition"), false);
  const pendingOptions = { parts: ["playing"] };
  await instances[0].render(pendingOptions);
  const staleOptions = { ...instances[0].renders.at(-1), parts: ["playing"] };
  beginMiniPlayerTransition();
  instances[0]._replaceHTML({}, {}, instances[0].renders.at(-1));
  assert.equal(instances[0].replacements, 0);
  assert.deepEqual(instances[0].renders.at(-1).parts, []);
  const beforeTransition = instances[0].renders.length;
  await instances[0].render({ parts: ["playing"] });
  refreshMiniPlayer();
  assert.equal(instances[0].renders.length, beforeTransition);
  endMiniPlayerTransition();
  assert.equal(instances[0].renders.length, beforeTransition + 1);
  instances[0]._replaceHTML({}, {}, staleOptions);
  assert.equal(instances[0].replacements, 0);
  assert.deepEqual(staleOptions.parts, []);
  refreshMiniPlayer();
  assert.deepEqual(instances[0].renders.at(-1).parts, ["controls", "directory", "playing"]);
  assert.equal(listeners.length, 1);
  audio.playing = true;
  listeners[0].listener();
  assert.equal(instances[0].renders.length, 5);
  const row = { dataset: { soundUuid: "Playlist.one.Sound.two" } };
  const shown = [];
  const widget = { hidden: true, querySelectorAll: () => shown };
  instances[0].element = { querySelector: () => widget };
  game.playlists[0].sounds[0].uuid = row.dataset.soundUuid;
  instances[0].updateTimestamps();
  assert.equal(instances[0].renders.length, 6);
  widget.hidden = false;
  shown.push(row);
  instances[0].updateTimestamps();
  assert.equal(instances[0].renders.length, 6);
  game.playlists[0].sounds[0].playing = false;
  instances[0].updateTimestamps();
  assert.equal(instances[0].renders.length, 7);
  instances[0]._volumeExpanded = true;
  const nativeSetInterval = globalThis.setInterval;
  const nativeClearInterval = globalThis.clearInterval;
  let timerDelay;
  let clearedTimer;
  try {
    globalThis.setInterval = (_callback, delay) => {
      timerDelay = delay;
      return 41;
    };
    globalThis.clearInterval = (handle) => {
      clearedTimer = handle;
    };
    await instances[0]._onFirstRender();
    await windows[0].close();
  } finally {
    globalThis.setInterval = nativeSetInterval;
    globalThis.clearInterval = nativeClearInterval;
  }
  assert.equal(timerDelay, 1000);
  assert.equal(clearedTimer, 41);
  assert.equal(instances[0].rendered, false);
  openMiniPlayer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instances.length, 2);
  assert.equal(instances[1]._volumeExpanded, true);
  await windows[1].close();
});
