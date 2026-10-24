import { storedData } from "../audio/playback-state.mjs";
import { DIRECTORY, error, publish, state } from "../core/context.mjs";

// The index tracks membership; revision advances even when only playlist or playback data changes.
const INDEX = `${DIRECTORY}/index.json`;
const REVISION = `${DIRECTORY}/revision.json`;
const PLAYLISTS = `${DIRECTORY}/playlists`;
const PLAYBACK = `${DIRECTORY}/playback`;
const README = `RN Playlist Companion Data

This folder stores global playlists and their sound data, global folders, and playback state for each world. AUDIO FILES ARE NOT STORED HERE.
By default, this folder is hidden from users in Foundry VTT's File Browser.

Do not delete or manually modify the contents of this folder. Doing so may result in data loss or prevent the module from working correctly.


Данные модуля RN Playlist Companion

Здесь хранятся данные глобальных плейлистов и их звуков, глобальные папки и состояние воспроизведения для каждого мира. АУДИОФАЙЛЫ ЗДЕСЬ НЕ ХРАНЯТСЯ.
Папка по умолчанию скрыта для пользователей в обозревателе файлов FoundryVTT.

Не удаляйте и не изменяйте содержимое этой папки вручную. Это может привести к потере данных или нарушить работу модуля.
`;
const BATCH_SIZE = 12;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const playlistPath = (id) => `${PLAYLISTS}/${id}.json`;
const playbackPath = (world) => `${PLAYBACK}/${world}.json`;

async function fetchJson(path, { optional = false } = {}) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (optional && response.status === 404) return null;
  if (!response.ok) throw error("ReadHTTP", { status: response.status });
  return response.json();
}

function validateIndex(index) {
  if (
    index?.schema !== 2 ||
    !Number.isInteger(index.revision) ||
    !Array.isArray(index.playlists) ||
    !Array.isArray(index.folders) ||
    !Array.isArray(index.worlds) ||
    new Set(index.playlists).size !== index.playlists.length ||
    !index.playlists.every((id) => typeof id === "string" && SAFE_ID.test(id)) ||
    !index.worlds.every((id) => typeof id === "string" && SAFE_ID.test(id)) ||
    !index.folders.every((folder) => typeof folder?._id === "string" && SAFE_ID.test(folder._id))
  ) {
    throw error("UnsupportedFile");
  }
  return index;
}

async function readIndex({ optional = false } = {}) {
  const data = await fetchJson(INDEX, { optional });
  return data ? validateIndex(data) : null;
}

async function readRevision() {
  const data = await fetchJson(REVISION);
  if (data?.schema !== 1 || !Number.isInteger(data.revision)) throw error("UnsupportedFile");
  return data.revision;
}

async function mapBatches(items, action) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    result.push(...(await Promise.all(items.slice(offset, offset + BATCH_SIZE).map(action))));
  }
  return result;
}

async function readPlaylist(id) {
  const data = await fetchJson(playlistPath(id));
  if (data?._id !== id || !Array.isArray(data.sounds)) throw error("UnsupportedFile");
  return data;
}

async function readPlayback(world, { required = false } = {}) {
  const data = await fetchJson(playbackPath(world), { optional: !required });
  if (data === null) return {};
  if (data?.schema !== 1 || data.world !== world || typeof data.playlists !== "object" || !data.playlists) {
    throw error("UnsupportedFile");
  }
  return data.playlists;
}

async function createDirectory(path) {
  try {
    await foundry.applications.apps.FilePicker.createDirectory("data", path);
    return true;
  } catch (cause) {
    const listing = await foundry.applications.apps.FilePicker.browse("data", path);
    if (!listing?.target) throw cause;
    return false;
  }
}

export async function ensureDirectory() {
  const created = await createDirectory(DIRECTORY);
  if (created) {
    const privacy = await foundry.applications.apps.FilePicker.configurePath("data", DIRECTORY, { private: true });
    if (privacy?.private !== true) throw error("PrivateFailed", { directory: DIRECTORY });
    const file = new File([README], "readme.txt", { type: "text/plain" });
    const result = await foundry.applications.apps.FilePicker.upload("data", DIRECTORY, file, {}, { notify: false });
    if (result?.path !== `${DIRECTORY}/readme.txt`) {
      throw error("UploadFailed", { path: `${DIRECTORY}/readme.txt`, result: result?.path ?? "—" });
    }
  }
  await createDirectory(PLAYLISTS);
  await createDirectory(PLAYBACK);
}

async function uploadJson(path, data) {
  const separator = path.lastIndexOf("/");
  const directory = path.slice(0, separator);
  const file = new File([JSON.stringify(data, null, 2)], path.slice(separator + 1), { type: "application/json" });
  const result = await foundry.applications.apps.FilePicker.upload("data", directory, file, {}, { notify: false });
  if (result?.path !== path) throw error("UploadFailed", { path, result: result?.path ?? "—" });
}

async function createEmptyStore() {
  const index = { schema: 2, revision: 0, folders: [], playlists: [], worlds: [] };
  await ensureDirectory();
  await uploadJson(REVISION, { schema: 1, revision: 0 });
  await uploadJson(INDEX, index);
  publish("reload");
  return index;
}

export async function readStore({ create = false } = {}) {
  let index = await readIndex({ optional: true });
  if (!index) {
    if ((await fetchJson(REVISION, { optional: true })) !== null) throw error("MissingIndex");
    if (create && game.user.isGM) index = await createEmptyStore();
    else throw error("StorageUnavailable");
  }
  const playlists = await mapBatches(index.playlists, readPlaylist);
  const revision = await readRevision();
  if (index.revision > revision) throw error("UnsupportedFile");
  const playbackByWorld = {
    [game.world.id]: await readPlayback(game.world.id, { required: index.worlds.includes(game.world.id) }),
  };
  const folderIds = new Set(index.folders.map((folder) => folder._id));
  if (
    index.folders.some((folder) => folder.folder && !folderIds.has(folder.folder)) ||
    playlists.some((playlist) => playlist.folder && !folderIds.has(playlist.folder))
  ) {
    throw error("MixedFolders");
  }
  return { ...index, revision, playlists, playbackByWorld };
}

export function serialize() {
  return [...state.playlists.values()].map((playlist) => storedData(playlist.toObject()));
}

export function serializeFolders() {
  return [...state.folders.values()].map((folder) => folder.toObject());
}

export function enqueue(task) {
  const result = state.queue.then(task);
  state.queue = result.catch(() => {});
  return result;
}

export async function persist(candidate, playbackByWorld = null, folders = null) {
  if (!game.user.isGM) throw error("GMOnlyEdit");
  return enqueue(async () => {
    if (state.stale) throw error("Stale");
    const disk = await readIndex();
    const revision = await readRevision();
    if (revision !== state.revision) throw error("RevisionMismatch");
    const nextFolders = folders ?? serializeFolders();
    const folderIds = new Set(nextFolders.map((folder) => folder._id));
    if (
      nextFolders.some((folder) => folder.folder && !folderIds.has(folder.folder)) ||
      candidate.some((playlist) => playlist.folder && !folderIds.has(playlist.folder))
    ) {
      throw error("MixedFolders");
    }
    const current = new Map(serialize().map((playlist) => [playlist._id, playlist]));
    const next = new Map(candidate.map((playlist) => [playlist._id, playlist]));
    if (next.size !== candidate.length) throw error("DuplicateID");
    const changed = candidate.filter(
      (playlist) => JSON.stringify(current.get(playlist._id)) !== JSON.stringify(playlist),
    );
    const currentWorld = state.playbackByWorld[game.world.id] ?? {};
    const nextWorld = playbackByWorld?.[game.world.id] ?? currentWorld;
    const playbackChanged = JSON.stringify(currentWorld) !== JSON.stringify(nextWorld);
    const removedIds = disk.playlists.filter((id) => !next.has(id));
    const otherWorlds = disk.worlds.filter((world) => world !== game.world.id);
    const changedWorlds = [];
    if (removedIds.length) {
      for (const world of otherWorlds) {
        const old = await readPlayback(world, { required: true });
        const updated = { ...old };
        for (const id of removedIds) delete updated[id];
        if (JSON.stringify(old) !== JSON.stringify(updated)) changedWorlds.push({ world, old, updated });
      }
    }
    const indexChanged =
      JSON.stringify(disk.folders) !== JSON.stringify(nextFolders) ||
      JSON.stringify(disk.playlists) !== JSON.stringify(candidate.map((playlist) => playlist._id)) ||
      (playbackChanged && !disk.worlds.includes(game.world.id));
    const index = {
      schema: 2,
      revision: indexChanged ? revision + 1 : disk.revision,
      folders: nextFolders,
      playlists: candidate.map((playlist) => playlist._id),
      worlds: [...new Set([...disk.worlds, ...(playbackChanged ? [game.world.id] : [])])],
    };
    validateIndex(index);
    const written = [];
    let playbackWritten = false;
    const otherPlaybackWritten = [];
    let indexWritten = false;
    try {
      for (const playlist of changed) {
        await uploadJson(playlistPath(playlist._id), playlist);
        written.push(playlist._id);
      }
      if (playbackChanged) {
        await uploadJson(playbackPath(game.world.id), { schema: 1, world: game.world.id, playlists: nextWorld });
        playbackWritten = true;
      }
      for (const { world, updated } of changedWorlds) {
        await uploadJson(playbackPath(world), { schema: 1, world, playlists: updated });
        otherPlaybackWritten.push(world);
      }
      // The index is authoritative. Removed playlists may leave an orphan file; FilePicker has no public delete API.
      if ((await readRevision()) !== revision) throw error("RevisionMismatch");
      if (indexChanged) {
        await uploadJson(INDEX, index);
        indexWritten = true;
      }
      await uploadJson(REVISION, { schema: 1, revision: revision + 1 });
    } catch (cause) {
      try {
        for (const id of written) {
          const old = current.get(id);
          if (old) await uploadJson(playlistPath(id), old);
        }
        if (playbackWritten) {
          await uploadJson(playbackPath(game.world.id), {
            schema: 1,
            world: game.world.id,
            playlists: currentWorld,
          });
        }
        for (const { world, old } of changedWorlds.filter(({ world }) => otherPlaybackWritten.includes(world))) {
          await uploadJson(playbackPath(world), { schema: 1, world, playlists: old });
        }
        if (indexWritten) await uploadJson(INDEX, disk);
      } catch (rollbackCause) {
        state.stale = true;
        console.error("Global playlist storage rollback failed", rollbackCause);
      }
      throw cause;
    }
    state.revision = revision + 1;
    state.playbackByWorld = { ...state.playbackByWorld, [game.world.id]: nextWorld };
    publish("revision", { revision: state.revision });
    return { ...index, revision: state.revision, playlists: candidate, playbackByWorld: state.playbackByWorld };
  });
}
