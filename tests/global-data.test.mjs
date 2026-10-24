import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { storedData } from "../scripts/audio/playback-state.mjs";
import { state } from "../scripts/core/context.mjs";
import { installFolder, installInClient, removeFromClient } from "../scripts/foundry/client-collection.mjs";
import { patchDocumentMethods } from "../scripts/foundry/document-bridge.mjs";
import { onSocket } from "../scripts/foundry/socket-sync.mjs";
import { moveBranchToGlobal, moveBranchToLocal, reloadGlobalPlaylists } from "../scripts/library/global-library.mjs";
import { filterHiddenTree, isHidden, setHidden } from "../scripts/library/visibility.mjs";
import { persist, readStore } from "../scripts/storage/global-store.mjs";
import { handleDrop } from "../scripts/ui/playlist-sidebar.mjs";

class Collection extends Map {
  filter(predicate) {
    return [...this.values()].filter(predicate);
  }

  initializeTree() {}
}

const english = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8")).RNPLAYCOMP;

function translation(key, data = {}) {
  const text = key
    .split(".")
    .slice(1)
    .reduce((value, part) => value?.[part], english);
  assert.equal(typeof text, "string", `Missing translation: ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, name) => String(data[name]));
}

function setup({ uploadFails = false } = {}) {
  const files = new Map([
    ["rn-global-playlists/index.json", { schema: 2, revision: 0, folders: [], playlists: [], worlds: [] }],
    ["rn-global-playlists/revision.json", { schema: 1, revision: 0 }],
  ]);
  const events = [];
  const hiddenByWorld = new Map();
  const folders = new Collection();
  const playlists = new Collection();

  globalThis.ui = { notifications: { error() {} } };
  globalThis.game = {
    user: { id: "gm", isGM: true },
    i18n: { localize: (key) => translation(key), format: translation },
    settings: {
      get: () => hiddenByWorld.get(game.world.id) ?? { folders: [], playlists: [] },
      set: async (_module, _key, value) => {
        hiddenByWorld.set(game.world.id, value);
      },
    },
    world: { id: "world-a" },
    folders,
    playlists,
    scenes: [],
    audio: { locked: false },
    socket: { emit: (_channel, message) => events.push(message.type) },
  };
  globalThis.foundry = {
    utils: { deepClone: structuredClone },
    applications: {
      apps: {
        FilePicker: {
          createDirectory: async () => {
            throw new Error("Directory already exists");
          },
          configurePath: async () => ({ private: true }),
          browse: async (_source, directory) => ({ target: directory, files: [...files.keys()] }),
          upload: async (_source, directory, file) => {
            const path = `${directory}/${file.name}`;
            events.push(`upload:${path}`);
            if (uploadFails === true || uploadFails === path) throw new Error("Disk write failed");
            files.set(path, file.name.endsWith(".json") ? JSON.parse(await file.text()) : await file.text());
            return { path };
          },
        },
      },
    },
    documents: {
      Folder: class {
        static async create(data) {
          const folder = new this(data);
          folders.set(folder.id, folder);
          events.push(`create:${folder.id}`);
          return folder;
        }

        constructor(data) {
          this.id = data._id;
          this.type = data.type;
          this.documentName = "Folder";
          this._source = data;
        }

        toObject() {
          return structuredClone(this._source);
        }

        async delete() {
          events.push(`rollback:${this.id}`);
          folders.delete(this.id);
        }
      },
      Playlist: class {
        static async create(data) {
          const playlist = new this(data);
          playlists.set(playlist.id, playlist);
          events.push(`create:${playlist.id}`);
          return playlist;
        }

        constructor(data) {
          this.id = data._id;
          this.documentName = "Playlist";
          this._source = data;
          this.sort = data.sort;
          this.sounds = data.sounds.map((sound) => ({
            id: sound._id,
            sort: sound.sort,
            sync() {},
            updateSource: (changes) => {
              Object.assign(sound, changes);
              Object.assign(this.sounds.get(sound._id), changes);
            },
          }));
          this.sounds.get = (id) => this.sounds.find((sound) => sound.id === id);
        }

        updateSource(changes) {
          Object.assign(this._source, changes);
          Object.assign(this, changes);
        }

        _onUpdateDescendantDocuments() {}

        toObject() {
          return structuredClone(this._source);
        }

        async delete() {
          events.push(`rollback:${this.id}`);
          playlists.delete(this.id);
        }
      },
    },
  };
  globalThis.fetch = async (url) => {
    const path = String(url).split("?")[0];
    if (!files.has(path)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => structuredClone(files.get(path)) };
  };

  state.folders = new Map();
  state.playlists = new Map();
  state.playbackByWorld = {};
  state.revision = 0;
  state.queue = Promise.resolve();
  state.ready = true;
  state.stale = false;
  state.suspendRefresh = false;

  const getDisk = () => {
    const index = files.get("rn-global-playlists/index.json");
    return structuredClone({
      ...index,
      revision: files.get("rn-global-playlists/revision.json").revision,
      playlists: index.playlists.map((id) => files.get(`rn-global-playlists/playlists/${id}.json`)),
      playbackByWorld: Object.fromEntries(
        index.worlds.map((world) => [world, files.get(`rn-global-playlists/playback/${world}.json`)?.playlists ?? {}]),
      ),
    });
  };
  const setDisk = (data) => {
    files.set("rn-global-playlists/index.json", {
      schema: 2,
      revision: data.revision,
      folders: data.folders,
      playlists: data.playlists.map((playlist) => playlist._id),
      worlds: Object.keys(data.playbackByWorld ?? {}),
    });
    files.set("rn-global-playlists/revision.json", { schema: 1, revision: data.revision });
    for (const playlist of data.playlists) files.set(`rn-global-playlists/playlists/${playlist._id}.json`, playlist);
    for (const [world, playback] of Object.entries(data.playbackByWorld ?? {})) {
      files.set(`rn-global-playlists/playback/${world}.json`, { schema: 1, world, playlists: playback });
    }
  };
  return { folders, playlists, events, files, getDisk, setDisk };
}

function addLocalFolder(folders, events, id, parent = null) {
  const source = { _id: id, name: id, type: "Playlist", folder: parent };
  const folder = {
    id,
    name: id,
    type: "Playlist",
    documentName: "Folder",
    _source: source,
    toObject: () => structuredClone(source),
    delete: async () => {
      events.push(`delete:${id}`);
      folders.delete(id);
    },
  };
  folders.set(id, folder);
  return folder;
}

function addLocalPlaylist(playlists, events, id, parent) {
  const source = {
    _id: id,
    name: id,
    folder: parent,
    channel: "music",
    playing: true,
    sounds: [{ _id: `${id}-sound`, path: "audio/example.ogg", playing: true, pausedTime: 12 }],
  };
  const playlist = {
    id,
    name: id,
    documentName: "Playlist",
    _source: source,
    toObject: () => structuredClone(source),
    delete: async () => {
      events.push(`delete:${id}`);
      playlists.delete(id);
    },
  };
  playlists.set(id, playlist);
  return playlist;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdFirstIndexRead({ failFirst = false } = {}) {
  const originalFetch = globalThis.fetch;
  const started = deferred();
  const release = deferred();
  let reads = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).split("?")[0] !== "rn-global-playlists/index.json") return originalFetch(url, options);
    reads += 1;
    const response = await originalFetch(url, options);
    if (reads !== 1) return response;
    const snapshot = await response.json();
    started.resolve();
    await release.promise;
    if (failFirst) return { ok: false, status: 503 };
    return { ...response, json: async () => snapshot };
  };
  return { started: started.promise, release: release.resolve, reads: () => reads };
}

test("moving a nested folder saves all original IDs and separates playback by world", async () => {
  const { folders, playlists, events, getDisk } = setup();
  const root = addLocalFolder(folders, events, "root");
  addLocalFolder(folders, events, "child", "root");
  addLocalPlaylist(playlists, events, "playlist-list", "child");

  await moveBranchToGlobal(root, null, false);

  const disk = getDisk();
  assert.equal(disk.revision, 1);
  assert.deepEqual(
    disk.folders.map((folder) => [folder._id, folder.folder]),
    [
      ["root", null],
      ["child", "root"],
    ],
  );
  assert.deepEqual(
    disk.playlists.map((playlist) => [playlist._id, playlist.folder]),
    [["playlist-list", "child"]],
  );
  assert.equal(disk.playlists[0].playing, false);
  assert.equal(disk.playlists[0].sounds[0].playing, false);
  assert.equal(disk.playlists[0].sounds[0].pausedTime, null);
  assert.equal(disk.playbackByWorld["world-a"]["playlist-list"].sounds["playlist-list-sound"].pausedTime, 12);
  assert.deepEqual(events.slice(0, 8), [
    "upload:rn-global-playlists/playlists/playlist-list.json",
    "upload:rn-global-playlists/playback/world-a.json",
    "upload:rn-global-playlists/index.json",
    "upload:rn-global-playlists/revision.json",
    "revision",
    "delete:playlist-list",
    "delete:child",
    "delete:root",
  ]);
  assert.equal(folders.get("child"), state.folders.get("child"));
  assert.equal(playlists.get("playlist-list"), state.playlists.get("playlist-list"));
});

test("failed global-file write keeps local originals and the previous revision", async () => {
  const { folders, playlists, events, getDisk } = setup({ uploadFails: true });
  const root = addLocalFolder(folders, events, "root");
  const playlist = addLocalPlaylist(playlists, events, "playlist-list", "root");

  await assert.rejects(moveBranchToGlobal(root, null, false), /Disk write failed/);

  assert.equal(folders.get("root"), root);
  assert.equal(playlists.get("playlist-list"), playlist);
  assert.equal(state.revision, 0);
  assert.deepEqual(state.playbackByWorld, {});
  assert.deepEqual(getDisk().playlists, []);
  assert.deepEqual(events, ["upload:rn-global-playlists/playlists/playlist-list.json"]);
});

test("failed index write during a move keeps the local originals", async () => {
  const { folders, playlists, events, getDisk } = setup({ uploadFails: "rn-global-playlists/index.json" });
  const root = addLocalFolder(folders, events, "root");
  const playlist = addLocalPlaylist(playlists, events, "playlist-list", "root");

  await assert.rejects(moveBranchToGlobal(root, null, false), /Disk write failed/);

  assert.equal(folders.get("root"), root);
  assert.equal(playlists.get("playlist-list"), playlist);
  assert.equal(state.revision, 0);
  assert.deepEqual(getDisk().playlists, []);
  assert.ok(events.includes("upload:rn-global-playlists/index.json"));
  assert.ok(!events.some((event) => event.startsWith("delete:")));
});

test("a changed disk revision rejects a stale write before uploading", async () => {
  const { events, getDisk, setDisk } = setup();
  setDisk({ ...getDisk(), revision: 1, playlists: [{ _id: "someone-else", name: "Other", sounds: [] }] });

  await assert.rejects(persist([{ _id: "ours", name: "Ours", sounds: [] }]), /changed in another GM client/);

  assert.deepEqual(
    getDisk().playlists.map((playlist) => playlist._id),
    ["someone-else"],
  );
  assert.equal(state.revision, 0);
  assert.deepEqual(events, []);
});

test("changing one sound among 200 playlists writes only its playlist file and the revision", async () => {
  const { files, playlists, events, setDisk } = setup();
  const data = Array.from({ length: 200 }, (_, i) => ({
    _id: `playlist${i}`,
    name: `Playlist ${i}`,
    folder: null,
    sounds: [{ _id: `sound${i}`, path: `audio/${i}.ogg` }],
  }));
  setDisk({ revision: 0, folders: [], playlists: data, playbackByWorld: {} });
  for (const item of data) {
    const document = new foundry.documents.Playlist(item);
    playlists.set(document.id, document);
    state.playlists.set(document.id, document);
  }
  const changed = data.map((item) =>
    storedData(
      item._id === "playlist72" ? { ...item, sounds: [{ ...item.sounds[0], path: "audio/changed.ogg" }] } : item,
    ),
  );

  await persist(changed);

  assert.deepEqual(events, [
    "upload:rn-global-playlists/playlists/playlist72.json",
    "upload:rn-global-playlists/revision.json",
    "revision",
  ]);
  assert.equal(files.get("rn-global-playlists/index.json").revision, 0);
  assert.equal(files.get("rn-global-playlists/playlists/playlist72.json").sounds[0].path, "audio/changed.ogg");
  assert.equal(files.get("rn-global-playlists/playlists/playlist73.json").sounds[0].path, "audio/73.ogg");
});

test("a fresh GM world initializes an empty split store", async () => {
  const { files } = setup();
  files.delete("rn-global-playlists/index.json");
  files.delete("rn-global-playlists/revision.json");

  const data = await readStore({ create: true });

  assert.deepEqual(data.playlists, []);
  assert.deepEqual(data.folders, []);
  assert.equal(files.get("rn-global-playlists/index.json").schema, 2);
  assert.deepEqual(files.get("rn-global-playlists/revision.json"), { schema: 1, revision: 0 });
});

test("missing index with an existing revision never initializes an empty store", async () => {
  const { files } = setup();
  files.delete("rn-global-playlists/index.json");

  await assert.rejects(readStore({ create: true }), /index.json is missing/);
});

test("a missing indexed playlist aborts loading instead of silently hiding it", async () => {
  const { setDisk, files } = setup();
  setDisk({
    revision: 1,
    folders: [],
    playlists: [{ _id: "global", name: "Global", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  files.delete("rn-global-playlists/playlists/global.json");

  await assert.rejects(readStore(), /HTTP 404/);
});

test("a missing indexed world playback file aborts loading", async () => {
  const { setDisk, files } = setup();
  setDisk({ revision: 1, folders: [], playlists: [], playbackByWorld: { "world-a": {} } });
  files.delete("rn-global-playlists/playback/world-a.json");

  await assert.rejects(readStore(), /HTTP 404/);
});

test("failed revision commit restores an edited playlist file", async () => {
  const { files, playlists, events, setDisk } = setup({ uploadFails: "rn-global-playlists/revision.json" });
  const item = { _id: "global", name: "Before", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [item], playbackByWorld: {} });
  const document = new foundry.documents.Playlist(item);
  playlists.set(item._id, document);
  state.playlists.set(item._id, document);

  await assert.rejects(persist([{ ...item, name: "After" }]), /Disk write failed/);

  assert.equal(files.get("rn-global-playlists/playlists/global.json").name, "Before");
  assert.equal(files.get("rn-global-playlists/index.json").revision, 0);
  assert.deepEqual(events, [
    "upload:rn-global-playlists/playlists/global.json",
    "upload:rn-global-playlists/revision.json",
    "upload:rn-global-playlists/playlists/global.json",
  ]);
});

test("removing a playlist clears playback in other worlds", async () => {
  const { files, playlists, events, setDisk } = setup();
  const item = { _id: "global", name: "Global", folder: null, sounds: [] };
  setDisk({
    revision: 0,
    folders: [],
    playlists: [item],
    playbackByWorld: {
      "world-a": { global: { playing: false, sounds: {} } },
      "world-b": { global: { playing: true, sounds: {} } },
    },
  });
  const document = new foundry.documents.Playlist(item);
  playlists.set(item._id, document);
  state.playlists.set(item._id, document);
  state.playbackByWorld = { "world-a": { global: { playing: false, sounds: {} } } };

  await persist([], { "world-a": {} });

  assert.deepEqual(files.get("rn-global-playlists/playback/world-b.json").playlists, {});
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, []);
  assert.ok(events.includes("upload:rn-global-playlists/playback/world-b.json"));
});

test("failed write during global-to-local move rolls back local copies", async () => {
  const { folders, playlists, events, getDisk, setDisk } = setup({ uploadFails: true });
  const folderData = { _id: "global-folder", name: "Global", type: "Playlist", folder: null };
  const playlistData = { _id: "global-list", name: "Global list", folder: "global-folder", sounds: [] };
  setDisk({ ...getDisk(), folders: [folderData], playlists: [playlistData] });
  const folder = new foundry.documents.Folder(folderData);
  const playlist = new foundry.documents.Playlist(playlistData);
  folders.set(folder.id, folder);
  playlists.set(playlist.id, playlist);
  state.folders.set(folder.id, folder);
  state.playlists.set(playlist.id, playlist);

  await assert.rejects(moveBranchToLocal(folder, null, false), /Could not make this item local: Disk write failed/);

  assert.equal(folders.get(folder.id), state.folders.get(folder.id));
  assert.equal(playlists.get(playlist.id), state.playlists.get(playlist.id));
  assert.deepEqual(events, [
    "create:global-folder",
    "create:global-list",
    "upload:rn-global-playlists/index.json",
    "rollback:global-list",
    "rollback:global-folder",
  ]);
  assert.equal(getDisk().playlists[0]._id, playlist.id);
  assert.equal(state.revision, 0);
});

test("hidden state stays in the current world when a folder becomes global or local", async () => {
  const { folders, playlists, events, getDisk } = setup();
  const folder = addLocalFolder(folders, events, "hidden-folder");
  addLocalPlaylist(playlists, events, "hidden-list", folder.id);
  await game.settings.set("rn-playlist-companion", "hiddenLocal", {
    folders: [folder.id],
    playlists: ["hidden-list"],
  });

  const globalFolder = await moveBranchToGlobal(folder, null, false);
  assert.equal(getDisk().hidden, undefined);
  assert.deepEqual(game.settings.get("rn-playlist-companion", "hiddenLocal"), {
    folders: ["hidden-folder"],
    playlists: ["hidden-list"],
  });
  assert.equal(isHidden(globalFolder), true);

  game.world.id = "world-b";
  assert.equal(isHidden(globalFolder), false);
  await setHidden(globalFolder, true);
  assert.deepEqual(game.settings.get("rn-playlist-companion", "hiddenLocal"), {
    folders: ["hidden-folder"],
    playlists: [],
  });
  game.world.id = "world-a";
  assert.equal(isHidden(globalFolder), true);

  await moveBranchToLocal(globalFolder, null, false);
  assert.equal(getDisk().hidden, undefined);
  assert.deepEqual(game.settings.get("rn-playlist-companion", "hiddenLocal"), {
    folders: ["hidden-folder"],
    playlists: ["hidden-list"],
  });
});

test("a hidden folder reveals only the branch containing a playing playlist", () => {
  const tree = {
    folder: null,
    entries: [],
    children: [
      {
        folder: { id: "hidden-root" },
        entries: [{ id: "silent" }],
        children: [{ folder: { id: "child" }, entries: [{ id: "playing" }], children: [] }],
      },
    ],
  };
  const options = {
    hiddenFolders: new Set(["hidden-root"]),
    hiddenPlaylists: new Set(),
    playingIds: new Set(["playing"]),
  };
  const visible = filterHiddenTree(tree, options);
  assert.deepEqual(visible.children[0].entries, []);
  assert.deepEqual(visible.children[0].children[0].entries, [{ id: "playing" }]);
  assert.deepEqual(filterHiddenTree(tree, { ...options, playingIds: new Set() }).children, []);
});

test("global playlist refreshes scene sound without preparing scene tiles again", () => {
  setup();
  const scene = {
    _source: { playlist: "global", playlistSound: "sound" },
    playlistSound: null,
    prepareData() {
      throw new Error("Scene preparation must not run again");
    },
  };
  game.scenes.push(scene);

  assert.equal(installInClient({ _id: "global", sounds: [{ _id: "sound" }] }), true);
  const firstSound = scene.playlistSound;
  assert.equal(firstSound.id, "sound");
  assert.equal(installInClient({ _id: "global", sounds: [{ _id: "sound" }] }), true);
  assert.equal(scene.playlistSound, firstSound);

  removeFromClient("global");
  assert.equal(scene.playlistSound, null);
});

test("reloads arriving during initial loading share one follow-up read", async () => {
  const { setDisk } = setup();
  state.ready = false;
  const held = holdFirstIndexRead();
  const first = reloadGlobalPlaylists({ create: true });
  await held.started;
  setDisk({
    revision: 1,
    folders: [],
    playlists: [{ _id: "latest", name: "Latest", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  const second = reloadGlobalPlaylists();
  const third = reloadGlobalPlaylists();
  assert.equal(first, second);
  assert.equal(second, third);
  held.release();
  await first;

  assert.equal(held.reads(), 2);
  assert.equal(state.playlists.get("latest")?.toObject().name, "Latest");
  assert.equal(state.revision, 1);
  assert.equal(state.ready, true);
});

test("a remote removal during a read cannot restore the removed playlist", async () => {
  const { setDisk } = setup();
  const old = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [old], playbackByWorld: {} });
  installInClient(old);
  const held = holdFirstIndexRead();
  const loading = reloadGlobalPlaylists();
  await held.started;
  setDisk({ revision: 1, folders: [], playlists: [], playbackByWorld: {} });
  onSocket({ sender: "other-gm", type: "remove", payload: { id: "global" } });
  held.release();
  await loading;

  assert.equal(held.reads(), 2);
  assert.equal(state.playlists.has("global"), false);
  assert.equal(state.revision, 1);
});

test("a remote update during a read cannot be replaced by an older playlist", async () => {
  const { setDisk } = setup();
  const old = { _id: "global", name: "Old", folder: null, sounds: [] };
  const updated = { ...old, name: "Updated" };
  setDisk({ revision: 0, folders: [], playlists: [old], playbackByWorld: {} });
  installInClient(old);
  const held = holdFirstIndexRead();
  const loading = reloadGlobalPlaylists();
  await held.started;
  setDisk({ revision: 1, folders: [], playlists: [updated], playbackByWorld: {} });
  onSocket({ sender: "other-gm", type: "upsert", payload: updated });
  held.release();
  await loading;

  assert.equal(held.reads(), 2);
  assert.equal(state.playlists.get("global")?.toObject().name, "Updated");
  assert.equal(state.revision, 1);
});

test("an obsolete read failure yields to a newer reload request", async () => {
  const { setDisk } = setup();
  state.ready = false;
  const held = holdFirstIndexRead({ failFirst: true });
  const first = reloadGlobalPlaylists();
  await held.started;
  setDisk({
    revision: 1,
    folders: [],
    playlists: [{ _id: "latest", name: "Latest", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  reloadGlobalPlaylists();
  held.release();
  await first;

  assert.equal(held.reads(), 2);
  assert.equal(state.playlists.get("latest")?.toObject().name, "Latest");
  assert.equal(state.ready, true);
});

test("a reload cannot replace a newer local revision with older disk data", async () => {
  const { setDisk } = setup();
  const current = { _id: "global", name: "Current", folder: null, sounds: [] };
  installInClient(current);
  state.revision = 2;
  setDisk({
    revision: 1,
    folders: [],
    playlists: [{ ...current, name: "Older" }],
    playbackByWorld: {},
  });

  await reloadGlobalPlaylists();

  assert.equal(state.revision, 2);
  assert.equal(state.playlists.get("global")?.toObject().name, "Current");
});

test("global sound, playlist, and folder sorting write to global storage instead of the world database", async () => {
  const { files, setDisk } = setup();
  let worldSoundUpdates = 0;
  foundry.documents.PlaylistSound = class {
    static updateDocuments() {
      worldSoundUpdates += 1;
      throw new Error("World database update must not run");
    }

    update() {}
  };
  foundry.utils.mergeObject = (target, changes) => Object.assign(target, changes);
  patchDocumentMethods();
  const folderData = { _id: "global-folder", type: "Playlist", folder: null, sort: 1000 };
  const data = {
    _id: "global",
    name: "Global",
    folder: folderData._id,
    sort: 1000,
    sounds: [
      { _id: "first", sort: 1000 },
      { _id: "second", sort: 2000 },
    ],
  };
  setDisk({ revision: 0, folders: [folderData], playlists: [data], playbackByWorld: {} });
  installFolder(folderData);
  const playlist = new foundry.documents.Playlist(data);
  game.playlists.set(playlist.id, playlist);
  state.playlists.set(playlist.id, playlist);
  let stops = 0;
  let playbackOrderUpdates = 0;
  const playingSound = playlist.sounds.get("second");
  playingSound.sound = { stop: () => stops++ };
  playlist._onUpdateDescendantDocuments = () => playbackOrderUpdates++;

  await foundry.documents.PlaylistSound.updateDocuments([{ _id: "second", sort: 500 }], { parent: playlist });
  assert.equal(state.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("second"), playingSound);
  assert.equal(stops, 0);
  assert.equal(playbackOrderUpdates, 1);
  assert.equal(playlist.toObject().sounds[1].sort, 500);
  await foundry.documents.Playlist.updateDocuments([{ _id: "global", sort: 500 }]);
  await foundry.documents.Folder.updateDocuments([{ _id: "global-folder", sort: 500 }]);

  const saved = files.get("rn-global-playlists/playlists/global.json");
  assert.equal(saved.sounds[1].sort, 500);
  assert.equal(saved.sort, 500);
  assert.equal(files.get("rn-global-playlists/index.json").folders[0].sort, 500);
  assert.equal(worldSoundUpdates, 0);

  const remoteOrder = playlist.toObject();
  remoteOrder.sounds[1].sort = 250;
  onSocket({ sender: "other-gm", type: "upsert", payload: remoteOrder });
  assert.equal(state.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("second"), playingSound);
  assert.equal(playingSound.sort, 250);
  assert.equal(stops, 0);
  assert.equal(playbackOrderUpdates, 2);
});

test("dropping within a global folder delegates positioning to Foundry", async () => {
  setup();
  const folder = new foundry.documents.Folder({ _id: "global-folder", type: "Playlist", folder: null });
  game.folders.set(folder.id, folder);
  state.folders.set(folder.id, folder);
  for (const id of ["first", "second"]) {
    const playlist = new foundry.documents.Playlist({ _id: id, folder: folder.id, sounds: [] });
    game.playlists.set(id, playlist);
    state.playlists.set(id, playlist);
  }
  foundry.applications.ux = {
    TextEditor: { implementation: { getDragEventData: () => ({ type: "Playlist", uuid: "first" }) } },
  };
  foundry.utils.fromUuid = async () => game.playlists.get("first");
  const target = {
    dataset: { entryId: "second" },
    matches: () => false,
    closest: () => target,
  };
  const event = { target };
  let delegated = false;

  await handleDrop(
    {},
    () => {
      delegated = true;
    },
    event,
  );

  assert.equal(delegated, true);
});
