import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { storedData } from "../scripts/audio/playback-state.mjs";
import { error, reportError, state } from "../scripts/core/context.mjs";
import { installFolder, installInClient, removeFromClient } from "../scripts/foundry/client-collection.mjs";
import { patchDocumentMethods } from "../scripts/foundry/document-bridge.mjs";
import { onSocket } from "../scripts/foundry/socket-sync.mjs";
import { forgetArchiveEntry, restoreArchived, restorePlan } from "../scripts/library/archive.mjs";
import { resolveLocalConflict } from "../scripts/library/conflicts.mjs";
import {
  applyChanges,
  moveBranchToGlobal,
  moveBranchToLocal,
  onGlobalDataApplied,
  reloadGlobalPlaylists,
  removeGlobal,
  updateGlobal,
} from "../scripts/library/global-library.mjs";
import { filterHiddenTree, isHidden, setHidden } from "../scripts/library/visibility.mjs";
import { persist, readArchive, readStore, serialize } from "../scripts/storage/global-store.mjs";
import { addMoveMenu, handleDrop } from "../scripts/ui/playlist-sidebar.mjs";

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

function setup({
  uploadFails = false,
  directoryExists = true,
  generation = 14,
  lowercaseUploads = generation === 13,
} = {}) {
  let generatedIds = 0;
  const files = new Map([
    ["rn-global-playlists/index.json", { schema: 2, revision: 0, folders: [], playlists: [], worlds: [] }],
    ["rn-global-playlists/revision.json", { schema: 1, revision: 0 }],
  ]);
  const directories = new Set(
    directoryExists ? ["rn-global-playlists", "rn-global-playlists/playlists", "rn-global-playlists/playback"] : [],
  );
  const events = [];
  const socketMessages = [];
  const hiddenByWorld = new Map();
  const folders = new Collection();
  const playlists = new Collection();

  globalThis.ui = { notifications: { error() {}, warn() {} } };
  globalThis.game = {
    release: { generation },
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
    socket: {
      emit: (_channel, message) => {
        events.push(message.type);
        socketMessages.push(message);
      },
    },
  };
  globalThis.foundry = {
    utils: { deepClone: structuredClone, randomID: () => `generated${++generatedIds}` },
    applications: {
      apps: {
        FilePicker: {
          createDirectory: async (_source, directory) => {
            if (directories.has(directory)) throw new Error("Directory already exists");
            directories.add(directory);
          },
          configurePath: async () => ({ private: true }),
          browse: async (_source, directory) => {
            if (!directories.has(directory)) throw new Error("Directory does not exist");
            return { target: directory, files: [...files.keys()] };
          },
          upload: async (_source, directory, file) => {
            const path = lowercaseUploads ? `${directory}/${file.name}`.toLowerCase() : `${directory}/${file.name}`;
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
        static canUserCreate(user) {
          return user.hasPermission("PLAYLIST_CREATE");
        }

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

        canUserModify(user) {
          return user.isGM || this._source.ownership?.[user.id] === 3;
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
  state.blockedFolders = new Map();
  state.blockedPlaylists = new Map();
  state.conflicts = [];
  state.playlistOrder = [];
  state.folderOrder = [];
  state.playbackByWorld = {};
  state.revision = 0;
  state.indexCache = null;
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
  return { folders, playlists, events, socketMessages, files, getDisk, setDisk };
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
    update: async (changes) => {
      Object.assign(source, changes);
      events.push(`update:${id}`);
    },
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
    update: async (changes) => {
      Object.assign(source, changes);
      events.push(`update:${id}`);
    },
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

test("localized errors notify once when an action reports them", () => {
  setup();
  const notices = [];
  ui.notifications.error = (message) => notices.push(message);
  const previousConsoleError = console.error;
  console.error = () => {};
  try {
    const failure = error("UnsupportedFile");
    assert.deepEqual(notices, []);
    reportError(failure);
    reportError(failure);
    assert.deepEqual(notices, [failure.message]);
  } finally {
    console.error = previousConsoleError;
  }
});

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

test("Foundry 13 keeps mixed-case playlist IDs when uploads lowercase filenames", async () => {
  const { playlists, events, files } = setup({ generation: 13 });
  const local = addLocalPlaylist(playlists, events, "MixedCaseID", null);

  await moveBranchToGlobal(local, null, false);

  assert.equal(files.get("rn-global-playlists/playlists/mixedcaseid.json")._id, "MixedCaseID");
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, ["MixedCaseID"]);
  assert.equal((await readStore()).playlists[0]._id, "MixedCaseID");

  files.delete("rn-global-playlists/index.json");
  assert.deepEqual(
    (await readStore()).playlists.map((playlist) => playlist._id),
    ["MixedCaseID"],
  );
});

test("Foundry 14 accepts upload hooks that lowercase filenames", async () => {
  const { playlists, events, files } = setup({ generation: 14, lowercaseUploads: true });
  const local = addLocalPlaylist(playlists, events, "MixedCaseID", null);

  await moveBranchToGlobal(local, null, false);

  assert.equal(files.get("rn-global-playlists/playlists/mixedcaseid.json")._id, "MixedCaseID");
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, ["MixedCaseID"]);
  assert.equal((await readStore()).playlists[0]._id, "MixedCaseID");
});

test("Foundry 13 context entries use names, HTML icons, conditions and callbacks", () => {
  setup({ generation: 13 });
  const options = [{ name: "SIDEBAR.Delete", icon: '<i class="fa-solid fa-trash"></i>' }];
  addMoveMenu(options, "playlist");
  assert.equal(options[1].name, translation("RNPLAYCOMP.UI.MakeGlobal"));
  assert.equal(options[1].icon, '<i class="fa-solid fa-globe"></i>');
  assert.equal(typeof options[1].condition, "function");
  assert.equal(typeof options[1].callback, "function");
  assert.equal(options[1].label, undefined);
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

  await assert.rejects(persist([{ _id: "ours", name: "Ours", sounds: [] }]), /changed in another client/);

  assert.deepEqual(
    getDisk().playlists.map((playlist) => playlist._id),
    ["someone-else"],
  );
  assert.equal(state.revision, 0);
  assert.deepEqual(events, []);
});

test("the initial index and revision reads run together", async () => {
  setup();
  const held = holdFirstIndexRead();
  const originalFetch = globalThis.fetch;
  let revisionReads = 0;
  globalThis.fetch = (url, options) => {
    if (String(url).split("?")[0] === "rn-global-playlists/revision.json") revisionReads++;
    return originalFetch(url, options);
  };
  const saving = persist([]);
  await held.started;
  assert.equal(revisionReads, 1);
  held.release();
  await saving;
});

test("a routine edit reuses the current index and checks the disk revision", async () => {
  const { setDisk } = setup();
  const playlist = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [playlist], playbackByWorld: {} });
  await reloadGlobalPlaylists();
  foundry.utils.mergeObject = Object.assign;
  const originalFetch = globalThis.fetch;
  const reads = [];
  globalThis.fetch = (url, options) => {
    reads.push(String(url).split("?")[0]);
    return originalFetch(url, options);
  };
  await updateGlobal(game.playlists.get("global"), { name: "Updated" });
  assert.equal(reads.filter((path) => path.endsWith("/index.json")).length, 0);
  assert.equal(reads.filter((path) => path.endsWith("/revision.json")).length, 2);
});

test("revision checks can be disabled and restored without reloading the world", async () => {
  const { events, files, setDisk, socketMessages } = setup();
  const playlist = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({
    revision: 0,
    folders: [],
    playlists: [playlist],
    playbackByWorld: { "world-a": { global: { playing: false, sounds: {} } } },
  });
  let disabled = true;
  game.settings.get = (_module, key) => (key === "disableRevisionChecks" ? disabled : { folders: [], playlists: [] });
  await reloadGlobalPlaylists();
  foundry.utils.mergeObject = Object.assign;

  await updateGlobal(game.playlists.get("global"), { name: "Fast" });
  assert.equal(files.get("rn-global-playlists/revision.json").revision, 0);
  assert.equal(events.filter((event) => event.endsWith("revision.json")).length, 0);
  assert.equal(socketMessages.at(-1).type, "patch");
  assert.equal("revision" in socketMessages.at(-1), false);

  disabled = false;
  await updateGlobal(game.playlists.get("global"), { name: "Checked" });
  assert.equal(files.get("rn-global-playlists/revision.json").revision, 1);
  assert.equal(socketMessages.at(-1).revision, 1);
});

test("a remote edit invalidates the cached index before the next save", async () => {
  const { setDisk } = setup();
  const playlist = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [playlist], playbackByWorld: {} });
  await reloadGlobalPlaylists();
  const changed = { ...playlist, name: "Remote" };
  setDisk({ revision: 1, folders: [], playlists: [changed], playbackByWorld: {} });
  onSocket({ sender: "other-gm", type: "upsert", revision: 1, payload: changed });
  const originalFetch = globalThis.fetch;
  let indexReads = 0;
  globalThis.fetch = (url, options) => {
    if (String(url).split("?")[0] === "rn-global-playlists/index.json") indexReads++;
    return originalFetch(url, options);
  };
  await persist(serialize());
  assert.equal(indexReads, 1);
});

for (const generation of [13, 14]) {
  test(`a playlist owner with world permission can save a global Sound in Foundry ${generation}`, async () => {
    const { events, getDisk, setDisk } = setup({ generation });
    const item = {
      _id: "owned",
      name: "Owned",
      ownership: { default: 0, player: 3 },
      sounds: [{ _id: "sound", path: "audio/example.ogg", volume: 0.5 }],
    };
    setDisk({ revision: 0, folders: [], playlists: [storedData(item)], playbackByWorld: {} });
    installInClient(item);
    game.user = {
      id: "player",
      isGM: false,
      hasPermission: (permission) => ["PLAYLIST_CREATE", "FILES_UPLOAD"].includes(permission),
    };

    await persist([storedData({ ...item, sounds: [{ ...item.sounds[0], volume: 0.7 }] })]);

    assert.equal(getDisk().playlists[0].sounds[0].volume, 0.7);
    assert.ok(events.includes("upload:rn-global-playlists/playlists/owned.json"));
  });

  test(`a playlist owner can start a global Sound in Foundry ${generation}`, async () => {
    const { getDisk, setDisk } = setup({ generation });
    const item = {
      _id: "owned",
      name: "Owned",
      ownership: { default: 0, player: 3 },
      sounds: [{ _id: "sound", path: "audio/example.ogg" }],
    };
    setDisk({ revision: 0, folders: [], playlists: [storedData(item)], playbackByWorld: {} });
    installInClient(item);
    game.user = {
      id: "player",
      isGM: false,
      hasPermission: (permission) => ["PLAYLIST_CREATE", "FILES_UPLOAD"].includes(permission),
    };

    await persist(serialize(), {
      "world-a": { owned: { playing: true, sounds: { sound: { playing: true, pausedTime: null } } } },
    });

    assert.equal(getDisk().playbackByWorld["world-a"].owned.sounds.sound.playing, true);
  });
}

test("a player without file upload permission gets a clear error before writing", async () => {
  const { events, setDisk } = setup();
  const item = { _id: "owned", name: "Owned", ownership: { default: 0, player: 3 }, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [storedData(item)], playbackByWorld: {} });
  installInClient(item);
  game.user = { id: "player", isGM: false, hasPermission: (permission) => permission === "PLAYLIST_CREATE" };

  await assert.rejects(persist([storedData({ ...item, name: "Changed" })]), /permission to upload files/i);
  assert.ok(!events.some((event) => event.startsWith("upload:")));
});

test("a player cannot save someone else's global playlist or change its ownership", async () => {
  const { events, setDisk } = setup();
  const item = {
    _id: "owned",
    name: "Owned",
    ownership: { default: 0, player: 3 },
    sounds: [{ _id: "sound", path: "audio/example.ogg" }],
  };
  setDisk({ revision: 0, folders: [], playlists: [storedData(item)], playbackByWorld: {} });
  installInClient(item);
  game.user = { id: "other", isGM: false, hasPermission: () => true };
  await assert.rejects(persist([storedData({ ...item, name: "Changed" })]), /playlist management permission/);
  game.user = { id: "player", isGM: false, hasPermission: () => false };
  await assert.rejects(persist([storedData({ ...item, name: "Changed" })]), /playlist management permission/);
  game.user = { id: "player", isGM: false, hasPermission: () => true };
  await assert.rejects(
    persist([storedData({ ...item, ownership: { ...item.ownership, other: 3 } })]),
    /playlist management permission/,
  );
  assert.ok(!events.some((event) => event.startsWith("upload:")));
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
  assert.equal(files.has("rn-global-playlists/archive.json"), false);
});

test("a fresh GM world initializes an empty split store", async () => {
  const { files } = setup({ directoryExists: false });
  files.delete("rn-global-playlists/index.json");
  files.delete("rn-global-playlists/revision.json");

  const data = await readStore();

  assert.deepEqual(data.playlists, []);
  assert.deepEqual(data.folders, []);
  assert.equal(files.get("rn-global-playlists/index.json").schema, 2);
  assert.deepEqual(files.get("rn-global-playlists/revision.json"), { schema: 1, revision: 0 });
});

test("missing index reconnects every playlist file and moves it to the root", async () => {
  const { files } = setup();
  files.set("rn-global-playlists/playlists/kept.json", {
    _id: "kept",
    name: "Kept",
    folder: "lost-folder",
    sounds: [],
  });
  files.set("rn-global-playlists/playlists/old.json", { _id: "old", name: "Old", folder: null, sounds: [] });
  files.delete("rn-global-playlists/index.json");

  const data = await readStore();
  assert.deepEqual(
    data.playlists.map((playlist) => playlist._id),
    ["kept", "old"],
  );
  assert.equal(data.playlists[0].folder, null);
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, ["kept", "old"]);
});

test("missing index and revision are recreated around remaining playlist files", async () => {
  const { files } = setup();
  files.delete("rn-global-playlists/index.json");
  files.delete("rn-global-playlists/revision.json");
  files.set("rn-global-playlists/playlists/retained.json", { _id: "retained", sounds: [] });

  const data = await readStore();
  assert.deepEqual(
    data.playlists.map((playlist) => playlist._id),
    ["retained"],
  );
  assert.equal(files.has("rn-global-playlists/playlists/retained.json"), true);
  assert.deepEqual(files.get("rn-global-playlists/revision.json"), { schema: 1, revision: 0 });
});

test("a missing revision file is recreated from the existing index", async () => {
  const { files, setDisk } = setup();
  setDisk({ revision: 4, folders: [], playlists: [], playbackByWorld: {} });
  files.delete("rn-global-playlists/revision.json");

  const data = await readStore();

  assert.equal(data.revision, 4);
  assert.deepEqual(files.get("rn-global-playlists/revision.json"), { schema: 1, revision: 4 });
});

test("a missing indexed playlist gets a new empty file with the same ID", async () => {
  const { setDisk, files } = setup();
  setDisk({
    revision: 1,
    folders: [],
    playlists: [{ _id: "global", name: "Global", folder: null, sounds: [] }],
    playbackByWorld: { "world-a": { global: { playing: true, sounds: { old: { playing: true } } } } },
  });
  files.delete("rn-global-playlists/playlists/global.json");

  const data = await readStore();
  assert.equal(data.playlists[0]._id, "global");
  assert.deepEqual(data.playlists[0].sounds, []);
  assert.deepEqual(data.playbackByWorld["world-a"], {});
  assert.equal(files.get("rn-global-playlists/playlists/global.json").name, "Recovered playlist global");
});

test("a missing indexed world playback file is recreated empty", async () => {
  const { setDisk, files } = setup();
  setDisk({ revision: 1, folders: [], playlists: [], playbackByWorld: { "world-a": {} } });
  files.delete("rn-global-playlists/playback/world-a.json");

  const data = await readStore();
  assert.deepEqual(data.playbackByWorld["world-a"], {});
  assert.deepEqual(files.get("rn-global-playlists/playback/world-a.json"), {
    schema: 1,
    world: "world-a",
    playlists: {},
  });
});

test("missing playlists, playback, revision and archive recover together", async () => {
  const { setDisk, files } = setup();
  setDisk({
    revision: 3,
    folders: [],
    playlists: [
      { _id: "lost-a", name: "A", sounds: [] },
      { _id: "lost-b", name: "B", sounds: [] },
    ],
    playbackByWorld: {
      "world-a": { "lost-a": { playing: true } },
      "world-b": { "lost-b": { playing: true } },
    },
  });
  files.get("rn-global-playlists/index.json").archive = true;
  for (const path of [
    "revision.json",
    "archive.json",
    "playlists/lost-a.json",
    "playlists/lost-b.json",
    "playback/world-a.json",
    "playback/world-b.json",
  ])
    files.delete(`rn-global-playlists/${path}`);

  const data = await readStore();

  assert.deepEqual(
    data.playlists.map((playlist) => playlist._id),
    ["lost-a", "lost-b"],
  );
  assert.ok(data.playlists.every((playlist) => playlist.sounds.length === 0));
  assert.equal(data.revision, 3);
  assert.deepEqual(data.playbackByWorld["world-a"], {});
  assert.deepEqual(files.get("rn-global-playlists/playback/world-b.json").playlists, {});
  assert.deepEqual(files.get("rn-global-playlists/archive.json"), { schema: 1, entries: [] });
});

test("recreating a playlist clears its stale playback in another world", async () => {
  const { setDisk, files } = setup();
  setDisk({
    revision: 2,
    folders: [],
    playlists: [{ _id: "lost", name: "Lost", sounds: [] }],
    playbackByWorld: {
      "world-a": { lost: { playing: true } },
      "world-b": { lost: { playing: true } },
    },
  });
  files.delete("rn-global-playlists/playlists/lost.json");
  files.delete("rn-global-playlists/playback/world-a.json");

  await readStore();

  assert.deepEqual(files.get("rn-global-playlists/playback/world-a.json").playlists, {});
  assert.deepEqual(files.get("rn-global-playlists/playback/world-b.json").playlists, {});
});

test("missing index rebuilds references when revision and archive are also absent", async () => {
  const { files } = setup();
  files.set("rn-global-playlists/playlists/remaining.json", {
    _id: "remaining",
    name: "Remaining",
    folder: "missing-folder",
    sounds: [],
  });
  files.set("rn-global-playlists/playback/world-a.json", {
    schema: 1,
    world: "world-a",
    playlists: { remaining: { playing: true } },
  });
  for (const path of ["index.json", "revision.json", "archive.json"]) {
    files.delete(`rn-global-playlists/${path}`);
  }

  const data = await readStore();

  assert.deepEqual(
    data.playlists.map((playlist) => playlist._id),
    ["remaining"],
  );
  assert.equal(data.playlists[0].folder, null);
  assert.deepEqual(files.get("rn-global-playlists/index.json").worlds, ["world-a"]);
  assert.deepEqual(data.playbackByWorld["world-a"], { remaining: { playing: true } });
  assert.deepEqual(files.get("rn-global-playlists/revision.json"), { schema: 1, revision: 0 });
  assert.deepEqual(files.get("rn-global-playlists/archive.json"), { schema: 1, entries: [] });
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

test("removing a playlist leaves other worlds for lazy playback cleanup", async () => {
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

  assert.deepEqual(files.get("rn-global-playlists/playback/world-b.json").playlists, {
    global: { playing: true, sounds: {} },
  });
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, []);
  assert.ok(!events.includes("upload:rn-global-playlists/playback/world-b.json"));
});

test("loading a world removes missing playlists and Sounds from its playback file", async () => {
  const { events, files, setDisk } = setup();
  const playlist = {
    _id: "global",
    name: "Global",
    folder: null,
    sounds: [{ _id: "present", name: "Present" }],
  };
  setDisk({
    revision: 0,
    folders: [],
    playlists: [playlist],
    playbackByWorld: {
      "world-a": {
        global: {
          playing: true,
          sounds: {
            present: { playing: false, pausedTime: null },
            missing: { playing: true, pausedTime: 2 },
          },
        },
        removed: { playing: true, sounds: {} },
      },
    },
  });

  const loaded = await readStore();

  assert.deepEqual(loaded.playbackByWorld["world-a"], {
    global: {
      playing: false,
      sounds: { present: { playing: false, pausedTime: null } },
    },
  });
  assert.deepEqual(files.get("rn-global-playlists/playback/world-a.json").playlists, loaded.playbackByWorld["world-a"]);
  assert.ok(events.includes("upload:rn-global-playlists/playback/world-a.json"));
});

test("deleting a global playlist archives its last data before removing it from the active index", async () => {
  const { files, playlists, socketMessages, setDisk } = setup();
  const item = {
    _id: "global",
    name: "Tavern",
    folder: null,
    sounds: [{ _id: "fire", name: "Fire", path: "audio/fire.ogg", playing: true }],
  };
  setDisk({ revision: 0, folders: [], playlists: [item], playbackByWorld: {} });
  const document = new foundry.documents.Playlist(item);
  playlists.set(item._id, document);
  state.playlists.set(item._id, document);

  await removeGlobal(item._id);
  assert.deepEqual(
    socketMessages.map((message) => message.type),
    ["remove"],
  );
  assert.equal(socketMessages[0].revision, 1);

  const archive = await readArchive();
  assert.equal(archive.entries.length, 1);
  assert.equal(archive.entries[0].type, "playlist");
  assert.equal(archive.entries[0].reason, "deleted");
  assert.equal(archive.entries[0].data.sounds[0].name, "Fire");
  assert.equal(archive.entries[0].data.sounds[0].playing, false);
  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, []);
  assert.equal(files.get("rn-global-playlists/index.json").archive, true);
  files.delete("rn-global-playlists/archive.json");
  await assert.rejects(readArchive(), /archive.json is missing/);
});

test("a GM starts a new empty archive after its file disappears, without changing active playlists", async () => {
  const { files, events, setDisk } = setup();
  const playlist = { _id: "global", name: "Tavern", folder: null, sounds: [] };
  setDisk({ revision: 3, folders: [], playlists: [playlist], playbackByWorld: {} });
  files.get("rn-global-playlists/index.json").archive = true;
  const warnings = [];
  ui.notifications.warn = (message) => warnings.push(message);

  const loaded = await readStore();
  assert.deepEqual(loaded.playlists, [playlist]);
  assert.deepEqual(files.get("rn-global-playlists/archive.json"), { schema: 1, entries: [] });
  assert.equal(warnings.length, 1);
  await readStore();
  assert.equal(warnings.length, 1);
  assert.equal(events.filter((event) => event === "upload:rn-global-playlists/archive.json").length, 1);
});

test("a failed revision write restores the active index and previous archive contents", async () => {
  const { files, playlists, setDisk } = setup({ uploadFails: "rn-global-playlists/revision.json" });
  const item = { _id: "global", name: "Tavern", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [item], playbackByWorld: {} });
  files.set("rn-global-playlists/archive.json", { schema: 1, entries: [] });
  const document = new foundry.documents.Playlist(item);
  playlists.set(item._id, document);
  state.playlists.set(item._id, document);

  await assert.rejects(removeGlobal(item._id), /Disk write failed/);

  assert.deepEqual(files.get("rn-global-playlists/index.json").playlists, ["global"]);
  assert.deepEqual(files.get("rn-global-playlists/archive.json").entries, []);
  assert.equal(state.playlists.get("global"), document);
});

test("removing an archived folder removes the saved branch from the one archive file", async () => {
  const { files } = setup();
  files.set("rn-global-playlists/archive.json", {
    schema: 1,
    entries: [
      {
        archiveId: "folder-entry",
        batchId: "batch",
        type: "folder",
        id: "folder",
        name: "Folder",
        reason: "deleted",
        data: { _id: "folder", folder: null, type: "Playlist" },
      },
      {
        archiveId: "playlist-entry",
        batchId: "batch",
        type: "playlist",
        id: "playlist",
        name: "Playlist",
        reason: "deleted",
        data: { _id: "playlist", folder: "folder", sounds: [] },
      },
    ],
  });

  await forgetArchiveEntry("folder-entry");

  assert.deepEqual((await readArchive()).entries, []);
});

test("restoring an older playlist separately keeps both versions and the archive snapshot", async () => {
  const { files, playlists, setDisk } = setup();
  const current = { _id: "global", name: "New", folder: null, sounds: [{ _id: "new", name: "New sound" }] };
  const archived = { _id: "global", name: "Old", folder: null, sounds: [{ _id: "old", name: "Old sound" }] };
  setDisk({ revision: 0, folders: [], playlists: [current], playbackByWorld: {} });
  const document = new foundry.documents.Playlist(current);
  playlists.set(current._id, document);
  state.playlists.set(current._id, document);
  files.set("rn-global-playlists/archive.json", {
    schema: 1,
    entries: [
      {
        archiveId: "snapshot",
        batchId: "batch",
        type: "playlist",
        id: "global",
        name: "Old",
        reason: "deleted",
        world: null,
        archivedAt: "2026-10-24T18:30:00Z",
        data: archived,
      },
    ],
  });

  const scene = {
    _source: { playlist: "global", playlistSound: "old" },
    async update(changes) {
      Object.assign(this._source, changes);
    },
  };
  game.scenes.push(scene);

  const plan = await restoreArchived("snapshot", "separate", { relinkScenes: true });

  assert.notEqual(plan.playlists[0]._id, "global");
  assert.equal(state.playlists.get("global").toObject().name, "New");
  assert.equal(state.playlists.get(plan.playlists[0]._id).toObject().name, "Old");
  assert.equal(scene._source.playlist, plan.playlists[0]._id);
  assert.equal((await readArchive()).entries[0].restoredAs, plan.playlists[0]._id);
});

test("a failed scene relink does not undo other scene links or the restored playlist", async () => {
  const { files, playlists, setDisk } = setup();
  const current = { _id: "global", name: "Current", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [current], playbackByWorld: {} });
  const document = new foundry.documents.Playlist(current);
  playlists.set(current._id, document);
  state.playlists.set(current._id, document);
  files.set("rn-global-playlists/archive.json", {
    schema: 1,
    entries: [
      {
        archiveId: "snapshot",
        batchId: "batch",
        type: "playlist",
        id: "global",
        name: "Old",
        reason: "deleted",
        world: null,
        archivedAt: "2026-10-24T18:30:00Z",
        data: { _id: "global", name: "Old", folder: null, sounds: [] },
      },
    ],
  });
  foundry.utils.escapeHTML = (text) => String(text);
  let result;
  foundry.applications.api = {
    DialogV2: {
      prompt: async (options) => {
        result = options;
      },
    },
  };
  const successful = {
    id: "scene-a",
    name: "Tavern",
    _source: { playlist: "global" },
    async update(changes) {
      Object.assign(this._source, changes);
    },
  };
  const failing = {
    id: "scene-b",
    name: "Forest",
    _source: { playlist: "global" },
    async update() {
      throw new Error("Update failed");
    },
  };
  game.scenes.push(successful, failing);

  const plan = await restoreArchived("snapshot", "separate", { relinkScenes: true });

  assert.equal(successful._source.playlist, plan.playlists[0]._id);
  assert.equal(failing._source.playlist, "global");
  assert.ok(state.playlists.has(plan.playlists[0]._id));
  assert.match(result.content, /Forest.*scene-b/);
});

test("replacing a current global playlist saves that version in the same archive", async () => {
  const { files, playlists, setDisk } = setup();
  const current = { _id: "global", name: "New", folder: null, sounds: [] };
  const archived = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [current], playbackByWorld: {} });
  const document = new foundry.documents.Playlist(current);
  playlists.set(current._id, document);
  state.playlists.set(current._id, document);
  files.set("rn-global-playlists/archive.json", {
    schema: 1,
    entries: [
      {
        archiveId: "snapshot",
        batchId: "batch",
        type: "playlist",
        id: "global",
        name: "Old",
        reason: "deleted",
        world: null,
        archivedAt: "2026-10-24T18:30:00Z",
        data: archived,
      },
    ],
  });

  await restoreArchived("snapshot", "replace");

  assert.equal(state.playlists.get("global").toObject().name, "Old");
  const entries = (await readArchive()).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.reason === "replaced").data.name, "New");
  assert.equal(entries.find((entry) => entry.archiveId === "snapshot").data.name, "Old");
});

test("folder restoration remaps occupied IDs and keeps every parent link within the branch", () => {
  setup();
  const entries = [
    { archiveId: "root", batchId: "batch", type: "folder", id: "folder", data: { _id: "folder", folder: null } },
    { archiveId: "child", batchId: "batch", type: "folder", id: "child", data: { _id: "child", folder: "folder" } },
    {
      archiveId: "list",
      batchId: "batch",
      type: "playlist",
      id: "list",
      data: { _id: "list", folder: "child", sounds: [] },
    },
  ];
  const plan = restorePlan(entries[0], entries, {
    mode: "separate",
    playlists: [],
    folders: [],
    localPlaylistIds: ["list"],
    localFolderIds: ["folder"],
  });

  assert.notEqual(plan.folders[0]._id, "folder");
  assert.notEqual(plan.playlists[0]._id, "list");
  assert.equal(plan.folders[1].folder, plan.folders[0]._id);
  assert.equal(plan.playlists[0].folder, plan.folders[1]._id);
});

test("restoring an archived folder installs its nested branch and retains its snapshot", async () => {
  const { files, getDisk } = setup();
  files.set("rn-global-playlists/archive.json", {
    schema: 1,
    entries: [
      {
        archiveId: "root",
        batchId: "batch",
        type: "folder",
        id: "root",
        name: "Root",
        reason: "deleted",
        data: { _id: "root", name: "Root", type: "Playlist", folder: null },
      },
      {
        archiveId: "child",
        batchId: "batch",
        type: "folder",
        id: "child",
        name: "Child",
        reason: "deleted",
        data: { _id: "child", name: "Child", type: "Playlist", folder: "root" },
      },
      {
        archiveId: "list",
        batchId: "batch",
        type: "playlist",
        id: "list",
        name: "Music",
        reason: "deleted",
        data: { _id: "list", name: "Music", folder: "child", sounds: [] },
      },
    ],
  });

  await restoreArchived("root", "separate");

  assert.deepEqual(
    getDisk().folders.map((item) => [item._id, item.folder]),
    [
      ["root", null],
      ["child", "root"],
    ],
  );
  assert.equal(getDisk().playlists[0].folder, "child");
  assert.equal(game.playlists.get("list").toObject().name, "Music");
  assert.equal((await readArchive()).entries.length, 3);
});

test("a local playlist ID collision preserves both copies and another world's data", async () => {
  const { files, playlists, setDisk, getDisk } = setup();
  const local = new foundry.documents.Playlist({ _id: "same", name: "Local", folder: null, sounds: [] });
  playlists.set(local.id, local);
  setDisk({
    revision: 0,
    folders: [],
    playlists: [{ _id: "same", name: "Global", folder: null, sounds: [] }],
    playbackByWorld: { "world-b": { same: { playing: true, sounds: {} } } },
  });
  const otherWorldBefore = structuredClone(files.get("rn-global-playlists/playback/world-b.json"));
  const globalBefore = structuredClone(files.get("rn-global-playlists/playlists/same.json"));

  await reloadGlobalPlaylists();

  assert.equal(playlists.get("same"), local);
  assert.equal(state.blockedPlaylists.get("same").name, "Global");
  assert.equal(state.conflicts.length, 1);
  assert.equal(serialize()[0].name, "Global");
  const scene = {
    _source: { playlist: "same", playlistSound: null },
    async update(changes) {
      Object.assign(this._source, changes);
    },
  };
  game.scenes.push(scene);
  await game.settings.set("rn-playlist-companion", "hiddenLocal", { folders: [], playlists: ["same"] });

  await resolveLocalConflict("playlist", "same");

  assert.equal(playlists.get("same").toObject().name, "Global");
  const localCopy = [...playlists.values()].find((item) => item.toObject().name === "Local");
  assert.ok(localCopy);
  assert.notEqual(localCopy.id, "same");
  assert.equal(scene._source.playlist, localCopy.id);
  assert.deepEqual(game.settings.get("rn-playlist-companion", "hiddenLocal").playlists, [localCopy.id]);
  assert.deepEqual(
    getDisk().playlists.map((item) => item.name),
    ["Global"],
  );
  assert.deepEqual(files.get("rn-global-playlists/playback/world-b.json"), otherWorldBefore);
  assert.deepEqual(files.get("rn-global-playlists/playlists/same.json"), globalBefore);
});

test("explicitly globalizing a conflicting local playlist keeps the existing global and moves the new local ID", async () => {
  const { playlists, setDisk, getDisk } = setup();
  const local = new foundry.documents.Playlist({ _id: "same", name: "Local", folder: null, sounds: [] });
  playlists.set(local.id, local);
  setDisk({
    revision: 0,
    folders: [],
    playlists: [{ _id: "same", name: "Existing global", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  foundry.utils.escapeHTML = (value) => value;
  foundry.applications.api = { DialogV2: { confirm: async () => true } };
  await reloadGlobalPlaylists();

  const moved = await moveBranchToGlobal(local, null, false);

  assert.equal(moved.toObject().name, "Local");
  assert.notEqual(moved.id, "same");
  assert.deepEqual(
    getDisk().playlists.map((item) => item.name),
    ["Existing global", "Local"],
  );
  assert.equal(state.conflicts.length, 0);
});

test("canceling conflict resolution leaves a local-to-global move untouched", async () => {
  const { playlists, setDisk, getDisk } = setup();
  const local = new foundry.documents.Playlist({ _id: "same", name: "Local", folder: null, sounds: [] });
  playlists.set(local.id, local);
  setDisk({
    revision: 0,
    folders: [],
    playlists: [{ _id: "same", name: "Existing global", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  foundry.utils.escapeHTML = (value) => value;
  foundry.applications.api = { DialogV2: { confirm: async () => false } };
  await reloadGlobalPlaylists();

  assert.equal(await moveBranchToGlobal(local, null, false), null);
  assert.equal(game.playlists.get("same"), local);
  assert.deepEqual(
    getDisk().playlists.map((item) => item.name),
    ["Existing global"],
  );
});

test("the move confirmation happens before an ID conflict can change the local item", async () => {
  const { playlists, setDisk, getDisk } = setup();
  const local = new foundry.documents.Playlist({ _id: "same", name: "Local", folder: null, sounds: [] });
  playlists.set(local.id, local);
  setDisk({
    revision: 0,
    folders: [],
    playlists: [{ _id: "same", name: "Existing global", folder: null, sounds: [] }],
    playbackByWorld: {},
  });
  foundry.utils.escapeHTML = (value) => value;
  let prompts = 0;
  foundry.applications.api = { DialogV2: { confirm: async () => ++prompts === 1 } };
  await reloadGlobalPlaylists();

  assert.equal(await moveBranchToGlobal(local), null);
  assert.equal(prompts, 2);
  assert.equal(game.playlists.get("same"), local);
  assert.deepEqual(
    getDisk().playlists.map((item) => item.name),
    ["Existing global"],
  );
});

test("a local folder ID collision holds back its global branch without losing stored data", async () => {
  const { folders, setDisk, getDisk } = setup();
  const local = new foundry.documents.Folder({ _id: "same", name: "Local folder", type: "Playlist", folder: null });
  folders.set(local.id, local);
  setDisk({
    revision: 0,
    folders: [{ _id: "same", name: "Global folder", type: "Playlist", folder: null }],
    playlists: [{ _id: "child", name: "Global child", folder: "same", sounds: [] }],
    playbackByWorld: {},
  });

  await reloadGlobalPlaylists();

  assert.equal(folders.get("same"), local);
  assert.equal(state.blockedFolders.get("same").name, "Global folder");
  assert.equal(state.blockedPlaylists.get("child").name, "Global child");
  assert.deepEqual(
    serialize().map((item) => item._id),
    ["child"],
  );

  foundry.utils.escapeHTML = (value) => value;
  foundry.applications.api = { DialogV2: { confirm: async () => false } };
  assert.equal(await moveBranchToGlobal(local, null, false), null);
  assert.deepEqual(
    getDisk().folders.map((item) => item.name),
    ["Global folder"],
  );

  await resolveLocalConflict("folder", "same");

  assert.equal(folders.get("same").toObject().name, "Global folder");
  assert.equal(game.playlists.get("child").toObject().name, "Global child");
  assert.ok([...folders.values()].some((item) => item.toObject().name === "Local folder"));
});

test("globalizing a conflicting local folder continues with its new ID and child", async () => {
  const { folders, playlists, events, setDisk, getDisk } = setup();
  const local = addLocalFolder(folders, events, "same");
  addLocalPlaylist(playlists, events, "local-child", "same");
  setDisk({
    revision: 0,
    folders: [{ _id: "same", name: "Existing global", type: "Playlist", folder: null }],
    playlists: [],
    playbackByWorld: {},
  });
  foundry.utils.escapeHTML = (value) => value;
  foundry.applications.api = { DialogV2: { confirm: async () => true } };
  await reloadGlobalPlaylists();

  const moved = await moveBranchToGlobal(local, null, false);

  assert.notEqual(moved.id, "same");
  assert.equal(getDisk().folders.length, 2);
  assert.equal(getDisk().playlists.find((item) => item._id === "local-child").folder, moved.id);
  assert.equal(state.conflicts.length, 0);
});

test("persist refuses duplicate global folder IDs before writing the index", async () => {
  const { events, getDisk } = setup();
  const folder = { _id: "same", name: "Folder", type: "Playlist", folder: null };

  await assert.rejects(persist([], null, [folder, { ...folder, name: "Other" }]), /same ID/);
  assert.deepEqual(getDisk().folders, []);
  assert.deepEqual(events, []);
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
    "upload:rn-global-playlists/archive.json",
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

test("moving a global branch to a local folder archives its original global folder links", async () => {
  const { folders, playlists, events, getDisk } = setup();
  const globalRoot = addLocalFolder(folders, events, "global-root");
  addLocalPlaylist(playlists, events, "global-list", globalRoot.id);
  const global = await moveBranchToGlobal(globalRoot, null, false);
  addLocalFolder(folders, events, "local-target");

  await moveBranchToLocal(global, "local-target", false);

  assert.equal(folders.get("global-root").toObject().folder, "local-target");
  const archive = await readArchive();
  assert.equal(archive.entries.find((item) => item.type === "folder").data.folder, null);
  assert.equal(archive.entries.find((item) => item.type === "playlist").data.folder, "global-root");
  assert.deepEqual(getDisk().playlists, []);
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

test("toggling Repeat on a global Sound preserves the playing audio object", () => {
  setup();
  const data = { _id: "global", sounds: [{ _id: "sound", repeat: false }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  const audio = {
    playing: true,
    currentTime: 42,
    stop() {
      throw new Error("Audio must not restart");
    },
  };
  sound.sound = audio;
  let synchronizations = 0;
  sound.sync = () => synchronizations++;

  installInClient({ ...data, sounds: [{ _id: "sound", repeat: true }] });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("sound"), sound);
  assert.equal(sound.sound, audio);
  assert.equal(audio.currentTime, 42);
  assert.equal(sound.repeat, true);
  assert.equal(synchronizations, 1);
});

test("safe global metadata updates preserve the current audio object", () => {
  setup();
  const data = {
    _id: "global",
    name: "Before",
    mode: 0,
    sorting: "m",
    fade: 100,
    playing: true,
    sounds: [{ _id: "sound", name: "Before", fade: 100, playing: true, flags: {} }],
  };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  const audio = { playing: true, currentTime: 42, stop: () => assert.fail("Safe edit stopped the audio") };
  sound.sound = audio;

  installInClient({
    ...data,
    name: "After",
    mode: 1,
    sorting: "a",
    fade: 200,
    sounds: [
      { _id: "sound", name: "After", fade: 200, playing: true, flags: { "rn-playlist-companion": { threshold: -40 } } },
    ],
  });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("sound"), sound);
  assert.equal(sound.sound, audio);
  assert.equal(playlist.name, "After");
  assert.equal(sound.name, "After");
  assert.equal(sound.flags["rn-playlist-companion"].threshold, -40);
});

test("stopping one edited global Sound does not restart another playing Sound", () => {
  setup();
  const data = {
    _id: "global",
    playing: true,
    sounds: [
      { _id: "edited", name: "Before", playing: true },
      { _id: "other", name: "Other", playing: true },
    ],
  };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const other = playlist.sounds.get("other");
  other.sound = { playing: true, currentTime: 42, stop: () => assert.fail("Other sound was stopped") };

  installInClient({
    ...data,
    sounds: [{ _id: "edited", name: "After", playing: false }, data.sounds[1]],
  });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("other"), other);
  assert.equal(other.sound.currentTime, 42);
  assert.equal(playlist.sounds.get("edited").playing, false);
});

test("changing a global Sound's live volume preserves playback on another client", () => {
  setup();
  const data = { _id: "global", playing: true, sounds: [{ _id: "sound", playing: true, volume: 0.5 }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  const audio = {
    playing: true,
    currentTime: 42,
    stop: () => assert.fail("Volume change must not stop playback"),
  };
  sound.sound = audio;
  let synchronizations = 0;
  sound.sync = () => synchronizations++;

  installInClient({ ...data, sounds: [{ _id: "sound", playing: true, volume: 0.7 }] });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("sound"), sound);
  assert.equal(sound.sound, audio);
  assert.equal(audio.currentTime, 42);
  assert.equal(sound.volume, 0.7);
  assert.equal(synchronizations, 1);
});

test("saving a volume already applied by Foundry's slider does not restart the GM's audio", () => {
  setup();
  const data = { _id: "global", playing: true, sounds: [{ _id: "sound", playing: true, volume: 0.5 }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  const audio = { stop: () => assert.fail("Saving slider volume must not stop playback") };
  sound.sound = audio;
  sound.updateSource({ volume: 0.7 });

  installInClient({ ...data, sounds: [{ _id: "sound", playing: true, volume: 0.7 }] });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(sound.sound, audio);
});

test("pausing a global Sound preserves its document and audio object", () => {
  setup();
  const data = { _id: "global", playing: true, sounds: [{ _id: "sound", playing: true, pausedTime: null }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  const audio = { stop: () => assert.fail("Pausing must not stop or replace the audio object") };
  sound.sound = audio;
  let synchronizations = 0;
  sound.sync = () => synchronizations++;

  installInClient({ ...data, sounds: [{ _id: "sound", playing: false, pausedTime: 12.5 }] });

  assert.equal(game.playlists.get("global"), playlist);
  assert.equal(playlist.sounds.get("sound"), sound);
  assert.equal(sound.sound, audio);
  assert.equal(sound.playing, false);
  assert.equal(sound.pausedTime, 12.5);
  assert.equal(synchronizations, 1);
});

test("a remote playback update waits for the player's audio unlock", async () => {
  setup();
  let unlock;
  game.audio.locked = true;
  game.audio.unlock = new Promise((resolve) => {
    unlock = resolve;
  });
  const data = { _id: "global", playing: false, sounds: [{ _id: "sound", playing: false }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const sound = playlist.sounds.get("sound");
  let synchronizations = 0;
  sound.sync = () => synchronizations++;
  installInClient({ ...data, playing: true, sounds: [{ _id: "sound", playing: true }] });
  assert.equal(synchronizations, 0);
  game.audio.locked = false;
  unlock();
  await game.audio.unlock;
  assert.equal(synchronizations, 1);
  assert.equal(playlist.playing, true);
  assert.equal(sound.playing, true);
});

test("a playing global Sound keeps its Playlist active for sequencing and player visibility", () => {
  setup();
  foundry.utils.mergeObject = (target, source) => Object.assign(target, source);
  const data = { _id: "global", playing: false, sounds: [{ _id: "sound", playing: true }] };
  const updated = applyChanges(data, { sounds: [{ _id: "sound", playing: true }] });
  assert.equal(updated.playing, true);
  installInClient(data);
  assert.equal(game.playlists.get("global").toObject().playing, true);
});

test("global live update derives Playlist.playing after updating its Sounds", () => {
  setup();
  const data = { _id: "global", playing: false, sounds: [{ _id: "sound", playing: false }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  const originalUpdateSource = playlist.updateSource.bind(playlist);
  playlist.updateSource = (changes) => {
    originalUpdateSource(changes);
    playlist.playing = playlist.sounds.some((sound) => sound.playing);
  };
  const sound = playlist.sounds.get("sound");
  sound.playing = false;
  installInClient({ ...data, playing: true, sounds: [{ _id: "sound", playing: true }] });
  assert.equal(sound.playing, true);
  assert.equal(playlist.playing, true);
});

test("global live update repairs a stale derived playing flag even when source already matches", () => {
  setup();
  const data = { _id: "global", playing: true, sounds: [{ _id: "sound", playing: true }] };
  installInClient(data);
  const playlist = game.playlists.get("global");
  playlist.playing = false;
  playlist.sounds.get("sound").playing = true;
  playlist.prepareDerivedData = () => {
    playlist.playing = playlist.sounds.some((sound) => sound.playing);
  };
  playlist.updateSource = () => ({}); // Foundry skips _initialize when the source diff is empty.
  installInClient(data);
  assert.equal(playlist.playing, true);
});

test("a global sequential replay honors Foundry's forceSync option", () => {
  setup();
  const data = { _id: "global", playing: true, sounds: [{ _id: "sound", playing: true }] };
  installInClient(data);
  const sound = game.playlists.get("global").sounds.get("sound");
  let synchronizations = 0;
  sound.sync = () => synchronizations++;
  installInClient(data, { forceSync: true });
  assert.equal(synchronizations, 1);
});

test("reloads arriving during initial loading share one follow-up read", async () => {
  const { setDisk } = setup();
  state.ready = false;
  const held = holdFirstIndexRead();
  const first = reloadGlobalPlaylists();
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

test("a GM reloads after a player changes a global playlist", async () => {
  const { setDisk } = setup();
  const old = { _id: "global", name: "Old", folder: null, sounds: [] };
  setDisk({ revision: 0, folders: [], playlists: [old], playbackByWorld: {} });
  installInClient(old);
  setDisk({ revision: 1, folders: [], playlists: [{ ...old, name: "Updated" }], playbackByWorld: {} });
  const applied = new Promise((resolve) => {
    const unsubscribe = onGlobalDataApplied(() => {
      unsubscribe();
      resolve();
    });
  });

  onSocket({ sender: "player", type: "revision", payload: { revision: 1 } });
  assert.equal(state.stale, true);
  await applied;

  assert.equal(state.stale, false);
  assert.equal(state.revision, 1);
  assert.equal(state.playlists.get("global").toObject().name, "Updated");
  await persist(serialize());
});

test("an ordinary global edit reaches another client without a full store read", async () => {
  const sender = setup();
  const old = { _id: "global", name: "Old", folder: null, sounds: [] };
  sender.setDisk({ revision: 0, folders: [], playlists: [old], playbackByWorld: {} });
  installInClient(old);
  foundry.utils.mergeObject = Object.assign;
  await updateGlobal(game.playlists.get("global"), { name: "Updated" });
  const message = sender.socketMessages.find((entry) => entry.type === "patch");
  assert.equal(message.revision, 1);
  assert.deepEqual(message.payload, {
    id: "global",
    changes: { name: "Updated" },
  });
  assert.equal(
    sender.socketMessages.some((entry) => entry.type === "revision"),
    false,
  );

  const receiver = setup();
  receiver.setDisk({ revision: 1, folders: [], playlists: [{ ...old, name: "Updated" }], playbackByWorld: {} });
  installInClient(old);
  foundry.utils.mergeObject = Object.assign;
  game.user = { id: "other-gm", isGM: true };
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (...args) => {
    reads++;
    return originalFetch(...args);
  };
  onSocket(message);
  assert.equal(reads, 0);
  assert.equal(state.playlists.get("global").toObject().name, "Updated");
  assert.equal(state.revision, 1);
  assert.equal(state.playbackByWorld[game.world.id].global.playing, false);
});

test("socket patches merge independent Sound fields without restoring stale playback", () => {
  setup();
  foundry.utils.mergeObject = Object.assign;
  const playlist = {
    _id: "global",
    name: "Global",
    folder: null,
    sounds: [{ _id: "sound", repeat: false, volume: 0.5, playing: false, pausedTime: null }],
  };
  installInClient(playlist);

  onSocket({
    sender: "first-user",
    type: "patch",
    revision: 1,
    payload: {
      id: "global",
      changes: { sounds: [{ _id: "sound", playing: true }] },
    },
  });
  onSocket({
    sender: "second-user",
    type: "patch",
    revision: 2,
    payload: {
      id: "global",
      changes: { sounds: [{ _id: "sound", repeat: true }] },
    },
  });

  const sound = state.playlists.get("global").sounds.get("sound");
  assert.equal(sound.repeat, true);
  assert.equal(sound.playing, true);
  assert.equal(sound.volume, 0.5);
  assert.equal(state.playbackByWorld[game.world.id].global.playing, true);
});

test("versioned creation and removal update another client without a full store read", () => {
  setup();
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = (...args) => {
    reads++;
    return originalFetch(...args);
  };
  const playlist = { _id: "new", name: "New", folder: null, sounds: [] };
  onSocket({ sender: "other-gm", type: "upsert", revision: 1, payload: playlist });
  assert.equal(state.playlists.has("new"), true);
  assert.deepEqual(state.playlistOrder, ["new"]);
  onSocket({ sender: "other-gm", type: "remove", revision: 2, payload: { id: "new" } });
  assert.equal(state.playlists.has("new"), false);
  assert.deepEqual(state.playlistOrder, []);
  assert.equal(state.revision, 2);
  assert.equal(reads, 0);
});

test("a missed global revision still reloads the store", async () => {
  const { setDisk } = setup();
  const old = { _id: "global", name: "Old", folder: null, sounds: [] };
  const latest = { ...old, name: "Latest" };
  setDisk({ revision: 2, folders: [], playlists: [latest], playbackByWorld: {} });
  installInClient(old);
  const applied = new Promise((resolve) => {
    const unsubscribe = onGlobalDataApplied(() => {
      unsubscribe();
      resolve();
    });
  });
  onSocket({ sender: "other-gm", type: "upsert", revision: 2, payload: latest });
  await applied;
  assert.equal(state.playlists.get("global").name, "Latest");
  assert.equal(state.revision, 2);
  assert.equal(state.stale, false);
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
