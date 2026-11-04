import assert from "node:assert/strict";
import { test } from "node:test";
import { canManageQueueSound, receiveQueueMessage, visibleQueueEntries } from "../scripts/audio/queue.mjs";

test("players see only sounds from owned playlists with playlist management permission", () => {
  const user = { isGM: false, hasPermission: (key) => key === "PLAYLIST_CREATE" };
  const owned = { testUserPermission: (_user, level) => level === "OWNER", sounds: new Map() };
  const observed = { testUserPermission: () => false, sounds: new Map() };
  owned.sounds.set("a", { id: "a", parent: owned });
  observed.sounds.set("b", { id: "b", parent: observed });
  globalThis.game = {
    user,
    playlists: new Map([
      ["owned", owned],
      ["observed", observed],
    ]),
  };
  const entries = [
    { playlistId: "observed", soundId: "b" },
    { playlistId: "owned", soundId: "a" },
  ];
  assert.deepEqual(
    visibleQueueEntries(entries).map(({ index }) => index),
    [1],
  );
  assert.equal(canManageQueueSound(observed.sounds.get("b")), false);
  user.hasPermission = () => false;
  assert.deepEqual(visibleQueueEntries(entries), []);
  user.isGM = true;
  assert.deepEqual(
    visibleQueueEntries(entries).map(({ index }) => index),
    [0, 1],
  );
});

test("GM accepts owned queue edits and rejects changes to hidden entries", async () => {
  const player = { id: "player", hasPermission: () => true, isGM: false };
  const gm = { id: "gm", isGM: true };
  const owned = { sounds: new Map(), testUserPermission: () => true };
  const hidden = { sounds: new Map(), testUserPermission: () => false };
  owned.sounds.set("a", { id: "a", parent: owned });
  hidden.sounds.set("b", { id: "b", parent: hidden });
  const hiddenEntry = { playlistId: "hidden", soundId: "b" };
  const ownedEntry = { playlistId: "owned", soundId: "a" };
  let state = { entries: [hiddenEntry, ownedEntry], linked: null };
  const replies = [];
  globalThis.game = {
    user: gm,
    users: new Map([["player", player]]),
    playlists: new Map([
      ["owned", owned],
      ["hidden", hidden],
    ]),
    settings: {
      get: () => state,
      set: async (_module, _key, next) => {
        state = next;
      },
    },
    socket: { emit: (_channel, reply) => replies.push(reply) },
  };
  receiveQueueMessage({
    type: "queue-change",
    sender: "player",
    target: "gm",
    requestId: "bad",
    before: state,
    after: { entries: [ownedEntry], linked: null },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).ok, false);
  assert.deepEqual(state.entries, [hiddenEntry, ownedEntry]);
  receiveQueueMessage({
    type: "queue-change",
    sender: "player",
    target: "gm",
    requestId: "good",
    before: state,
    after: { entries: [hiddenEntry], linked: null },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).ok, true);
  assert.deepEqual(state.entries, [hiddenEntry]);
  state = { entries: [hiddenEntry, ownedEntry], linked: hiddenEntry };
  receiveQueueMessage({
    type: "queue-change",
    sender: "player",
    target: "gm",
    requestId: "hidden-link",
    before: state,
    after: { entries: [hiddenEntry], linked: hiddenEntry },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).ok, true);
  assert.deepEqual(state, { entries: [hiddenEntry], linked: hiddenEntry });
  state = { entries: [hiddenEntry, ownedEntry], linked: hiddenEntry };
  receiveQueueMessage({
    type: "queue-change",
    sender: "player",
    target: "gm",
    requestId: "play-owned",
    before: state,
    after: { entries: [hiddenEntry], linked: ownedEntry },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).ok, true);
  assert.deepEqual(state, { entries: [hiddenEntry], linked: ownedEntry });
});

test("Next starts the first queued sound without an existing linked sound", async () => {
  let state = { entries: [{ playlistId: "p", soundId: "s" }], linked: null };
  const played = [];
  const sound = { id: "s" };
  const playlist = { sounds: new Map([["s", sound]]), playSound: async (item) => played.push(item) };
  sound.parent = playlist;
  globalThis.game = {
    user: { isGM: true },
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

test("Play in the queue stops the linked sound and links the selected sound", async () => {
  let state = {
    entries: [
      { playlistId: "p", soundId: "first" },
      { playlistId: "p", soundId: "selected" },
    ],
    linked: { playlistId: "p", soundId: "playing" },
  };
  const actions = [];
  let writes = 0;
  const playlist = {
    sounds: new Map(),
    stopSound: async (sound) => actions.push(`stop:${sound.id}`),
    playSound: async (sound) => actions.push(`play:${sound.id}`),
  };
  for (const id of ["playing", "first", "selected"])
    playlist.sounds.set(id, { id, parent: playlist, playing: id === "playing" });
  globalThis.game = {
    user: { isGM: true },
    playlists: new Map([["p", playlist]]),
    settings: {
      get: () => state,
      set: async (_module, _key, next) => {
        writes++;
        state = next;
      },
    },
  };
  const { playQueueEntry } = await import("../scripts/audio/queue.mjs");
  await playQueueEntry(1);
  assert.deepEqual(actions, ["stop:playing", "play:selected"]);
  assert.deepEqual(state.entries, [{ playlistId: "p", soundId: "first" }]);
  assert.deepEqual(state.linked, { playlistId: "p", soundId: "selected" });
  assert.equal(writes, 1);
});

test("the final queued sound ends playback and clears its queue link", async () => {
  let state = { entries: [], linked: { playlistId: "p", soundId: "last" } };
  const actions = [];
  class Playlist {
    constructor() {
      this.id = "p";
      this.sounds = new Map();
    }
    _onSoundEnd() {
      actions.push("normal-next");
    }
    async stopSound(sound) {
      actions.push(`stop:${sound.id}`);
    }
  }
  const playlist = new Playlist();
  const sound = { id: "last", parent: playlist, repeat: false };
  playlist.sounds.set(sound.id, sound);
  globalThis.foundry = { documents: { Playlist } };
  globalThis.ui = { playlists: { render() {} } };
  globalThis.game = {
    user: { isGM: true },
    playlists: new Map([["p", playlist]]),
    settings: {
      register() {},
      get: () => state,
      set: async (_module, _key, next) => {
        state = next;
      },
    },
  };
  const { installQueuePlayback } = await import("../scripts/audio/queue.mjs");
  installQueuePlayback();
  await playlist._onSoundEnd(sound);
  assert.deepEqual(actions, ["stop:last"]);
  assert.equal(state.linked, null);
});

test("failed queue save does not stop the current sound", async () => {
  const current = { id: "current", playing: true };
  const next = { id: "next" };
  const actions = [];
  const playlist = {
    id: "p",
    sounds: new Map([
      ["current", current],
      ["next", next],
    ]),
    stopSound: async () => actions.push("stop"),
    playSound: async () => actions.push("play"),
  };
  current.parent = playlist;
  next.parent = playlist;
  const state = { entries: [{ playlistId: "p", soundId: "next" }], linked: { playlistId: "p", soundId: "current" } };
  globalThis.game = {
    user: { isGM: true },
    playlists: new Map([["p", playlist]]),
    settings: {
      get: () => state,
      set: async () => {
        throw new Error("write failed");
      },
    },
  };
  const { playQueueNext } = await import("../scripts/audio/queue.mjs");
  await assert.rejects(playQueueNext(), /write failed/);
  assert.deepEqual(actions, []);
});
