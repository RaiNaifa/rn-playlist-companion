import { storedData } from "../audio/playback-state.mjs";
import { DIRECTORY, error, publish, state } from "../core/context.mjs";
import { revisionChecksDisabled } from "./revision-control.mjs";

// The index tracks membership.
// Revision advances even when only playlist or playback data changes.
const INDEX = `${DIRECTORY}/index.json`;
const REVISION = `${DIRECTORY}/revision.json`;
const ARCHIVE = `${DIRECTORY}/archive.json`;
const PLAYLISTS = `${DIRECTORY}/playlists`;
const PLAYBACK = `${DIRECTORY}/playback`;
const README = `RN Playlist Companion Data

This folder stores global playlists and their sound data, global folders, and playback state for each world. AUDIO FILES ARE NOT STORED HERE.
By default, this folder is hidden from users in Foundry VTT's File Browser.

Do not manually change active data files. Old playlist files may remain in playlists/ after removal. The archive is stored separately in archive.json. Foundry's File Browser cannot delete individual files.


Данные модуля RN Playlist Companion

Здесь хранятся данные глобальных плейлистов и их звуков, глобальные папки и состояние воспроизведения для каждого мира. АУДИОФАЙЛЫ ЗДЕСЬ НЕ ХРАНЯТСЯ.
Папка по умолчанию скрыта для пользователей в обозревателе файлов FoundryVTT.

Не изменяйте вручную файлы действующих данных. После удаления плейлистов в playlists/ могут оставаться старые файлы. Архив хранится отдельно в archive.json. Файловый менеджер Foundry не умеет удалять отдельные файлы.
`;
const BATCH_SIZE = 12;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const playlistPath = (id) => `${PLAYLISTS}/${game.release?.generation === 13 ? id.toLowerCase() : id}.json`;
const originalPlaylistPath = (id) => `${PLAYLISTS}/${id}.json`;
const playbackPath = (world) => `${PLAYBACK}/${world}.json`;

function lowercaseFilename(path) {
  const separator = path.lastIndexOf("/");
  return `${path.slice(0, separator + 1)}${path.slice(separator + 1).toLowerCase()}`;
}

function sameUploadedPath(expected, actual) {
  if (typeof actual !== "string") return false;
  const expectedSeparator = expected.lastIndexOf("/");
  const actualSeparator = actual.lastIndexOf("/");
  return (
    expected.slice(0, expectedSeparator) === actual.slice(0, actualSeparator) &&
    expected.slice(expectedSeparator + 1).toLowerCase() === actual.slice(actualSeparator + 1).toLowerCase()
  );
}

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
    (index.archive !== undefined && index.archive !== true) ||
    new Set(index.playlists).size !== index.playlists.length ||
    new Set(index.folders.map((folder) => folder?._id)).size !== index.folders.length ||
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

function notifyRecreated(path) {
  ui.notifications.warn(game.i18n.format("RNPLAYCOMP.Notifications.RecreatedFile", { path }));
  publish("reload");
}

async function readRevision(index = null) {
  let data = await fetchJson(REVISION, { optional: true });
  if (data === null && game.user.isGM) {
    const revision = index?.revision ?? (await readIndex())?.revision;
    data = { schema: 1, revision };
    await uploadJson(REVISION, data);
    notifyRecreated(REVISION);
  }
  if (data === null) throw error("ReadHTTP", { status: 404 });
  if (data?.schema !== 1 || !Number.isInteger(data.revision)) throw error("UnsupportedFile");
  return data.revision;
}

export async function readArchive() {
  const data = await fetchJson(ARCHIVE, { optional: true });
  if (data === null) {
    if ((await readIndex({ optional: true }))?.archive) throw error("MissingArchive");
    return { schema: 1, entries: [] };
  }
  if (
    data?.schema !== 1 ||
    !Array.isArray(data.entries) ||
    new Set(data.entries.map((entry) => entry.archiveId)).size !== data.entries.length ||
    !data.entries.every(
      (entry) =>
        typeof entry.archiveId === "string" &&
        typeof entry.batchId === "string" &&
        ["playlist", "folder"].includes(entry.type) &&
        ["deleted", "moved-to-local", "replaced"].includes(entry.reason) &&
        typeof entry.id === "string" &&
        entry.data?._id === entry.id,
    )
  ) {
    throw error("UnsupportedFile");
  }
  return data;
}

async function mapBatches(items, action) {
  const result = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    result.push(...(await Promise.all(items.slice(offset, offset + BATCH_SIZE).map(action))));
  }
  return result;
}

async function readPlaylist(id, onRecreated = null) {
  let data = await fetchJson(playlistPath(id), { optional: true });
  if (data === null && originalPlaylistPath(id) !== playlistPath(id)) {
    data = await fetchJson(originalPlaylistPath(id), { optional: true });
  }
  const lowercasePath = lowercaseFilename(originalPlaylistPath(id));
  if (data === null && lowercasePath !== playlistPath(id)) {
    data = await fetchJson(lowercasePath, { optional: true });
  }
  if (data === null && game.user.isGM) {
    await createDirectory(PLAYLISTS);
    data = { _id: id, name: game.i18n.format("RNPLAYCOMP.Archive.RecreatedPlaylistName", { id }), sounds: [] };
    await uploadJson(playlistPath(id), data);
    notifyRecreated(playlistPath(id));
    onRecreated?.(id);
  }
  if (data === null) throw error("MissingPlaylist", { id });
  if (data?._id !== id || !Array.isArray(data.sounds)) throw error("UnsupportedFile");
  if (data.ownership?.__$OPERATOR$__ === "ForcedReplacement") {
    data.ownership = data.ownership.value;
  }
  return data;
}

export async function missingIndexedPlaylists() {
  const index = await readIndex({ optional: true });
  if (!index) {
    return { missingIndex: true, ids: [] };
  }
  const missing = await mapBatches(index.playlists, async (id) => {
    if ((await fetchJson(playlistPath(id), { optional: true })) !== null) return null;
    if (originalPlaylistPath(id) !== playlistPath(id)) {
      if ((await fetchJson(originalPlaylistPath(id), { optional: true })) !== null) return null;
    }
    const lowercasePath = lowercaseFilename(originalPlaylistPath(id));
    if (lowercasePath !== playlistPath(id)) {
      if ((await fetchJson(lowercasePath, { optional: true })) !== null) return null;
    }
    return id;
  });
  return { missingIndex: false, ids: missing.filter(Boolean) };
}

async function readPlayback(world, { required = false } = {}) {
  let data = await fetchJson(playbackPath(world), { optional: true });
  const lowercasePath = lowercaseFilename(playbackPath(world));
  if (data === null && lowercasePath !== playbackPath(world)) {
    data = await fetchJson(lowercasePath, { optional: true });
  }
  if (data === null && required && game.user.isGM) {
    await createDirectory(PLAYBACK);
    data = { schema: 1, world, playlists: {} };
    await uploadJson(playbackPath(world), data);
    notifyRecreated(playbackPath(world));
  }
  if (data === null && required) throw error("ReadHTTP", { status: 404 });
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
  if (!sameUploadedPath(path, result?.path)) {
    throw error("UploadFailed", { path, result: result?.path ?? "—" });
  }
}

async function createEmptyStore() {
  const index = { schema: 2, revision: 0, folders: [], playlists: [], worlds: [] };
  await ensureDirectory();
  await uploadJson(REVISION, { schema: 1, revision: 0 });
  await uploadJson(INDEX, index);
  publish("reload");
  return index;
}

async function listedIds(directory) {
  await createDirectory(directory);
  const listing = await foundry.applications.apps.FilePicker.browse("data", directory);
  return [
    ...new Set(
      (listing.files ?? [])
        .map((file) => {
          const path = String(file).replace(/^https?:\/\/[^/]+\//, "");
          const match = path.match(new RegExp(`(?:^|/)${directory}/([a-zA-Z0-9_-]+)\\.json$`));
          return match?.[1] ?? null;
        })
        .filter(Boolean),
    ),
  ];
}

async function rebuildIndex() {
  // Without the index, every playlist file is treated as active. Folder membership cannot be recovered.
  const playlistIds = [
    ...new Set(
      await mapBatches(await listedIds(PLAYLISTS), async (fileId) => {
        const data = await fetchJson(`${PLAYLISTS}/${fileId}.json`);
        if (!data?._id || !Array.isArray(data.sounds)) throw error("UnsupportedFile");
        return data._id;
      }),
    ),
  ];
  const worlds = await listedIds(PLAYBACK);
  const revisionData = await fetchJson(REVISION, { optional: true });
  if (revisionData && (revisionData.schema !== 1 || !Number.isInteger(revisionData.revision))) {
    throw error("UnsupportedFile");
  }
  for (const id of playlistIds) {
    const playlist = await readPlaylist(id);
    if (playlist.folder) await uploadJson(playlistPath(id), { ...playlist, folder: null });
  }
  const archive = await fetchJson(ARCHIVE, { optional: true });
  if (archive === null) {
    await uploadJson(ARCHIVE, { schema: 1, entries: [] });
    notifyRecreated(ARCHIVE);
  }
  const index = {
    schema: 2,
    revision: revisionData?.revision ?? 0,
    folders: [],
    playlists: playlistIds,
    worlds,
    archive: true,
  };
  if (!revisionData) await uploadJson(REVISION, { schema: 1, revision: index.revision });
  await uploadJson(INDEX, index);
  ui.notifications.warn(game.i18n.format("RNPLAYCOMP.Notifications.RebuiltIndex", { count: playlistIds.length }));
  publish("reload");
  return index;
}

export async function readStore() {
  let index = await readIndex({ optional: true });
  if (!index) {
    let directoryExists = false;
    try {
      directoryExists = Boolean((await foundry.applications.apps.FilePicker.browse("data", DIRECTORY))?.target);
    } catch {
      // A missing directory is expected before the first initialization.
    }
    if (game.user.isGM) index = directoryExists ? await rebuildIndex() : await createEmptyStore();
    else throw error("StorageUnavailable");
  }
  const recreatedPlaylists = new Set();
  const playlists = await mapBatches(index.playlists, (id) =>
    readPlaylist(id, (missingId) => recreatedPlaylists.add(missingId)),
  );
  let revision = await readRevision(index);
  if (index.revision > revision) throw error("UnsupportedFile");
  if (game.user.isGM && index.archive && (await fetchJson(ARCHIVE, { optional: true })) === null) {
    await uploadJson(ARCHIVE, { schema: 1, entries: [] });
    ui.notifications.warn(game.i18n.localize("RNPLAYCOMP.Notifications.LostArchive"));
  }
  let currentPlayback = await readPlayback(game.world.id, { required: index.worlds.includes(game.world.id) });
  const playlistsById = new Map(playlists.map((playlist) => [playlist._id, playlist]));
  const cleanPlayback = (playback) => {
    let changed = false;
    for (const [playlistId, saved] of Object.entries(playback)) {
      const playlist = playlistsById.get(playlistId);
      if (!playlist) {
        delete playback[playlistId];
        changed = true;
        continue;
      }
      const soundIds = new Set(playlist.sounds.map((sound) => sound._id));
      let soundsCleaned = false;
      for (const soundId of Object.keys(saved.sounds ?? {})) {
        if (soundIds.has(soundId)) continue;
        delete saved.sounds[soundId];
        soundsCleaned = true;
        changed = true;
      }
      if (soundsCleaned) saved.playing = Object.values(saved.sounds ?? {}).some((sound) => sound.playing);
    }
    return changed;
  };
  const playbackCleaned = cleanPlayback(currentPlayback);
  if (playbackCleaned && game.user.isGM) {
    const cleaned = await enqueue(async () => {
      const skipRevision = revisionChecksDisabled();
      if (!skipRevision && (await readRevision(index)) !== revision) throw error("GlobalDataChanged");
      const latest = await readPlayback(game.world.id, { required: true });
      const previous = foundry.utils.deepClone(latest);
      let committed = false;
      if (cleanPlayback(latest)) {
        if (!skipRevision && (await readRevision(index)) !== revision) throw error("GlobalDataChanged");
        try {
          await uploadJson(playbackPath(game.world.id), {
            schema: 1,
            world: game.world.id,
            playlists: latest,
          });
          if (!skipRevision) await uploadJson(REVISION, { schema: 1, revision: revision + 1 });
          committed = true;
        } catch (cause) {
          await uploadJson(playbackPath(game.world.id), {
            schema: 1,
            world: game.world.id,
            playlists: previous,
          }).catch(console.error);
          throw cause;
        }
      }
      return { playback: latest, revision: !skipRevision && committed ? revision + 1 : revision };
    });
    currentPlayback = cleaned.playback;
    revision = cleaned.revision;
  }
  const playbackByWorld = { [game.world.id]: currentPlayback };
  if (recreatedPlaylists.size) {
    // A recreated playlist has no sounds, so stale playback in any world must not start it again.
    for (const world of index.worlds) {
      const playback = world === game.world.id ? playbackByWorld[world] : await readPlayback(world, { required: true });
      if (![...recreatedPlaylists].some((id) => Object.hasOwn(playback, id))) continue;
      for (const id of recreatedPlaylists) delete playback[id];
      await uploadJson(playbackPath(world), { schema: 1, world, playlists: playback });
    }
  }
  const folderIds = new Set(index.folders.map((folder) => folder._id));
  if (
    index.folders.some((folder) => folder.folder && !folderIds.has(folder.folder)) ||
    playlists.some((playlist) => playlist.folder && !folderIds.has(playlist.folder))
  ) {
    throw error("MixedFolders");
  }
  return { ...index, revision, playlists, playbackByWorld, indexData: index };
}

export function serialize() {
  const byId = new Map([
    ...[...state.playlists.values()].map((playlist) => [playlist.id, storedData(playlist.toObject())]),
    ...[...state.blockedPlaylists.values()].map((playlist) => [playlist._id, storedData(playlist)]),
  ]);
  const order = [...new Set([...state.playlistOrder, ...byId.keys()])];
  return order.map((id) => byId.get(id)).filter(Boolean);
}

export function serializeFolders() {
  const byId = new Map([
    ...[...state.folders.values()].map((folder) => [folder.id, folder.toObject()]),
    ...[...state.blockedFolders.values()].map((folder) => [folder._id, folder]),
  ]);
  const order = [...new Set([...state.folderOrder, ...byId.keys()])];
  return order.map((id) => byId.get(id)).filter(Boolean);
}

export function enqueue(task) {
  const result = state.queue.then(task);
  state.queue = result.catch(() => {});
  return result;
}

function checkPlaylistPermissions(candidate, playbackByWorld, folders, archiveChange) {
  if (game.user.isGM) return;
  if (!game.user.hasPermission("PLAYLIST_CREATE")) throw error("PlaylistPermissionDenied");
  if (folders && JSON.stringify(folders) !== JSON.stringify(serializeFolders())) {
    throw error("PlaylistPermissionDenied");
  }
  const current = new Map(serialize().map((playlist) => [playlist._id, playlist]));
  const next = new Map(candidate.map((playlist) => [playlist._id, playlist]));
  const affected = new Set();
  for (const id of new Set([...current.keys(), ...next.keys()])) {
    if (JSON.stringify(current.get(id)) !== JSON.stringify(next.get(id))) affected.add(id);
  }
  const oldPlayback = state.playbackByWorld[game.world.id] ?? {};
  const newPlayback = playbackByWorld?.[game.world.id] ?? oldPlayback;
  for (const id of new Set([...Object.keys(oldPlayback), ...Object.keys(newPlayback)])) {
    if (JSON.stringify(oldPlayback[id]) !== JSON.stringify(newPlayback[id])) affected.add(id);
  }
  if (archiveChange && ![...affected].some((id) => current.has(id) && !next.has(id))) {
    throw error("PlaylistPermissionDenied");
  }
  for (const id of affected) {
    const playlist = state.playlists.get(id);
    if (!playlist) {
      if (current.has(id) || !foundry.documents.Playlist.canUserCreate(game.user)) {
        throw error("PlaylistPermissionDenied");
      }
      continue;
    }
    if (!playlist.canUserModify(game.user, next.has(id) ? "update" : "delete")) {
      throw error("PlaylistPermissionDenied");
    }
    if (next.has(id) && JSON.stringify(current.get(id)?.ownership) !== JSON.stringify(next.get(id)?.ownership)) {
      throw error("PlaylistPermissionDenied");
    }
  }
  if (!game.user.hasPermission("FILES_UPLOAD")) throw error("GlobalFileUploadPermissionDenied");
}

export async function persist(
  candidate,
  playbackByWorld = null,
  folders = null,
  archiveChange = null,
  { announceRevision = true } = {},
) {
  checkPlaylistPermissions(candidate, playbackByWorld, folders, archiveChange);
  return enqueue(async () => {
    if (state.stale) throw error("GlobalDataChanged");
    const skipRevision = revisionChecksDisabled();
    const cached =
      !folders &&
      !archiveChange &&
      state.indexCache?.revision === state.revision &&
      JSON.stringify(candidate.map((playlist) => playlist._id)) === JSON.stringify(state.indexCache.index.playlists)
        ? state.indexCache
        : null;
    const [disk, revision] = await Promise.all([
      cached ? cached.index : readIndex(),
      skipRevision ? state.revision : readRevision(),
    ]);
    if ((!skipRevision && revision !== state.revision) || (cached && state.indexCache !== cached)) {
      throw error("GlobalDataChanged");
    }
    const oldArchive = archiveChange ? await readArchive() : null;
    const nextArchive = archiveChange
      ? {
          schema: 1,
          entries: [
            ...oldArchive.entries
              .filter((entry) => !archiveChange.remove?.includes(entry.archiveId))
              .map((entry) => ({ ...entry, ...(archiveChange.mark?.[entry.archiveId] ?? {}) })),
            ...(archiveChange.add ?? []),
          ],
        }
      : null;
    const nextFolders = folders ?? serializeFolders();
    const folderIds = new Set(nextFolders.map((folder) => folder._id));
    if (folderIds.size !== nextFolders.length) throw error("DuplicateID");
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
    const resetPlaybackIds = archiveChange?.resetPlaybackIds ?? [];
    const nextWorld = { ...(playbackByWorld?.[game.world.id] ?? currentWorld) };
    for (const id of resetPlaybackIds) delete nextWorld[id];
    const playbackChanged = JSON.stringify(currentWorld) !== JSON.stringify(nextWorld);
    const otherWorlds = disk.worlds.filter((world) => world !== game.world.id);
    const changedWorlds = [];
    if (resetPlaybackIds.length) {
      for (const world of otherWorlds) {
        const old = await readPlayback(world, { required: true });
        const updated = { ...old };
        for (const id of resetPlaybackIds) delete updated[id];
        if (JSON.stringify(old) !== JSON.stringify(updated)) changedWorlds.push({ world, old, updated });
      }
    }
    const indexChanged =
      JSON.stringify(disk.folders) !== JSON.stringify(nextFolders) ||
      JSON.stringify(disk.playlists) !== JSON.stringify(candidate.map((playlist) => playlist._id)) ||
      (playbackChanged && !disk.worlds.includes(game.world.id)) ||
      (Boolean(nextArchive) && !disk.archive);
    const index = {
      schema: 2,
      revision: indexChanged && !skipRevision ? revision + 1 : disk.revision,
      folders: nextFolders,
      playlists: candidate.map((playlist) => playlist._id),
      worlds: [...new Set([...disk.worlds, ...(playbackChanged ? [game.world.id] : [])])],
      ...(nextArchive || disk.archive ? { archive: true } : {}),
    };
    validateIndex(index);
    const written = [];
    let archiveWritten = false;
    let playbackWritten = false;
    const otherPlaybackWritten = [];
    let indexWritten = false;
    // Write dependent files first and the revision last, so other clients reload only after the set is complete.
    try {
      if (nextArchive && JSON.stringify(nextArchive) !== JSON.stringify(oldArchive)) {
        await uploadJson(ARCHIVE, nextArchive);
        archiveWritten = true;
      }
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
      // The index is authoritative. Removed playlists may leave an orphan file. FilePicker has no public delete API.
      if (!skipRevision && (await readRevision()) !== revision) throw error("GlobalDataChanged");
      if (indexChanged) {
        await uploadJson(INDEX, index);
        indexWritten = true;
      }
      if (!skipRevision) await uploadJson(REVISION, { schema: 1, revision: revision + 1 });
    } catch (cause) {
      state.indexCache = null;
      try {
        if (archiveWritten) await uploadJson(ARCHIVE, oldArchive);
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
        // A failed rollback leaves disk state uncertain. Reject further writes until a reload repairs it.
        state.stale = true;
        console.error("Global playlist storage rollback failed", rollbackCause);
      }
      throw cause;
    }
    state.revision = skipRevision ? revision : revision + 1;
    state.indexCache = { revision: state.revision, index };
    state.playlistOrder = candidate.map((playlist) => playlist._id);
    state.folderOrder = nextFolders.map((folder) => folder._id);
    state.playbackByWorld = { ...state.playbackByWorld, [game.world.id]: nextWorld };
    if (announceRevision && !skipRevision) publish("revision", { revision: state.revision });
    return {
      ...index,
      revision: state.revision,
      revisionChecksDisabled: skipRevision,
      playlists: candidate,
      playbackByWorld: state.playbackByWorld,
    };
  });
}
