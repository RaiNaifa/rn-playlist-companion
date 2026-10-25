import { storedData } from "../audio/playback-state.mjs";
import { stopPreviewForPlayback } from "../audio/preview.mjs";
import { error, isGlobal, isGlobalFolder, publish, reportError, state, t } from "../core/context.mjs";
import { archiveEntries } from "../library/archive.mjs";
import {
  applyChanges,
  createGlobalSounds,
  deleteGlobalSounds,
  folderBranch,
  hasBlockedBranch,
  removeGlobal,
  updateGlobal,
} from "../library/global-library.mjs";
import { persist, serialize, serializeFolders } from "../storage/global-store.mjs";
import { installFolder, installInClient, removeFolder, removeFromClient } from "./client-collection.mjs";

function reportRejection(promise) {
  // Report failures while returning the original promise to the caller.
  promise.catch(reportError);
  return promise;
}

export function patchDocumentMethods() {
  const Playlist = foundry.documents.Playlist;
  const PlaylistSound = foundry.documents.PlaylistSound;
  const Folder = foundry.documents.Folder;
  const original = {
    playlistCreate: Playlist.create,
    playlistCreateDocuments: Playlist.createDocuments,
    playlistUpdateDocuments: Playlist.updateDocuments,
    playlistUpdate: Playlist.prototype.update,
    playlistDelete: Playlist.prototype.delete,
    folderCreate: Folder.create,
    folderCreateDocuments: Folder.createDocuments,
    folderUpdateDocuments: Folder.updateDocuments,
    folderUpdate: Folder.prototype.update,
    folderDelete: Folder.prototype.delete,
    createEmbedded: Playlist.prototype.createEmbeddedDocuments,
    updateEmbedded: Playlist.prototype.updateEmbeddedDocuments,
    deleteEmbedded: Playlist.prototype.deleteEmbeddedDocuments,
    soundCreate: PlaylistSound.create,
    soundUpdateDocuments: PlaylistSound.updateDocuments,
    soundUpdate: PlaylistSound.prototype.update,
    soundDelete: PlaylistSound.prototype.delete,
  };

  Playlist.create = async function (data = {}, options = {}) {
    if (!isGlobalFolder(game.folders.get(data.folder))) return original.playlistCreate.call(this, data, options);
    try {
      if (!game.user.isGM) throw error("GMOnlyCreatePlaylist");
      const item = { ...data, _id: data._id ?? foundry.utils.randomID() };
      await persist([...serialize(), storedData(item)]);
      installInClient(item);
      publish("reload");
      return state.playlists.get(item._id);
    } catch (cause) {
      throw reportError(cause);
    }
  };
  Playlist.createDocuments = async function (data = [], options = {}) {
    if (!data.some((item) => isGlobalFolder(game.folders.get(item.folder)))) {
      return original.playlistCreateDocuments.call(this, data, options);
    }
    const created = [];
    for (const item of data) {
      if (isGlobalFolder(game.folders.get(item.folder))) created.push(await Playlist.create(item, options));
      else created.push(...(await original.playlistCreateDocuments.call(this, [item], options)));
    }
    return created;
  };
  Playlist.updateDocuments = async function (changes = [], options = {}) {
    if (
      !changes.some(
        (change) =>
          isGlobal(game.playlists.get(change._id)) ||
          (change.folder && isGlobalFolder(game.folders.get(change.folder))),
      )
    ) {
      return original.playlistUpdateDocuments.call(this, changes, options);
    }
    const updated = [];
    for (const change of changes) {
      const playlist = game.playlists.get(change._id);
      if (!playlist) continue;
      if (isGlobal(playlist) || (change.folder && isGlobalFolder(game.folders.get(change.folder)))) {
        updated.push(await playlist.update(change, options));
      } else updated.push(...(await original.playlistUpdateDocuments.call(this, [change], options)));
    }
    return updated;
  };
  Playlist.prototype.update = function (data = {}, options = {}) {
    stopPreviewForPlayback(this.id, data.sounds);
    if (data.folder && isGlobalFolder(game.folders.get(data.folder)) && !isGlobal(this)) {
      throw reportError(error("DirectPlaylistToGlobal"));
    }
    if (isGlobal(this) && data.folder && !isGlobalFolder(game.folders.get(data.folder))) {
      throw reportError(error("DirectPlaylistToLocal"));
    }
    if (!isGlobal(this)) return original.playlistUpdate.call(this, data, options);
    return reportRejection(updateGlobal(this, data, options));
  };
  Playlist.prototype.delete = function (options = {}) {
    if (!isGlobal(this)) return original.playlistDelete.call(this, options);
    return reportRejection(removeGlobal(this.id));
  };
  Playlist.prototype.createEmbeddedDocuments = function (name, data = [], options = {}) {
    if (!isGlobal(this) || name !== "PlaylistSound") {
      return original.createEmbedded.call(this, name, data, options);
    }
    return reportRejection(createGlobalSounds(this, data));
  };
  Playlist.prototype.updateEmbeddedDocuments = function (name, changes = [], options = {}) {
    if (!isGlobal(this) || name !== "PlaylistSound") {
      return original.updateEmbedded.call(this, name, changes, options);
    }
    return reportRejection(
      updateGlobal(this, { sounds: changes }, options).then((p) => changes.map((c) => p.sounds.get(c._id))),
    );
  };
  Playlist.prototype.deleteEmbeddedDocuments = function (name, ids = [], options = {}) {
    if (!isGlobal(this) || name !== "PlaylistSound") {
      return original.deleteEmbedded.call(this, name, ids, options);
    }
    return reportRejection(deleteGlobalSounds(this, ids));
  };
  PlaylistSound.create = function (data = {}, options = {}) {
    if (!isGlobal(options.parent)) return original.soundCreate.call(this, data, options);
    return reportRejection(createGlobalSounds(options.parent, [data]).then((created) => created[0]));
  };
  PlaylistSound.updateDocuments = function (changes = [], options = {}) {
    if (!isGlobal(options.parent)) return original.soundUpdateDocuments.call(this, changes, options);
    return reportRejection(
      updateGlobal(options.parent, { sounds: changes }, options).then((playlist) =>
        changes.map((change) => playlist.sounds.get(change._id)),
      ),
    );
  };
  PlaylistSound.prototype.update = function (data = {}, options = {}) {
    if (data.playing === true) stopPreviewForPlayback(this.parent?.id, [{ _id: this.id, playing: true }]);
    if (!isGlobal(this)) return original.soundUpdate.call(this, data, options);
    return reportRejection(
      updateGlobal(this.parent, { sounds: [{ ...data, _id: this.id }] }, options).then((p) => p.sounds.get(this.id)),
    );
  };
  PlaylistSound.prototype.delete = function (options = {}) {
    if (!isGlobal(this)) return original.soundDelete.call(this, options);
    return reportRejection(deleteGlobalSounds(this.parent, [this.id]).then((deleted) => deleted[0]));
  };

  Folder.create = async function (data = {}, options = {}) {
    if (data.type !== "Playlist" || !isGlobalFolder(game.folders.get(data.folder))) {
      return original.folderCreate.call(this, data, options);
    }
    try {
      if (!game.user.isGM) throw error("GMOnlyCreateFolder");
      const item = { ...data, _id: data._id ?? foundry.utils.randomID() };
      await persist(serialize(), null, [...serializeFolders(), item]);
      installFolder(item);
      publish("reload");
      return state.folders.get(item._id);
    } catch (cause) {
      throw reportError(cause);
    }
  };
  Folder.createDocuments = async function (data = [], options = {}) {
    if (!data.some((item) => item.type === "Playlist" && isGlobalFolder(game.folders.get(item.folder)))) {
      return original.folderCreateDocuments.call(this, data, options);
    }
    const created = [];
    for (const item of data) {
      if (item.type === "Playlist" && isGlobalFolder(game.folders.get(item.folder))) {
        created.push(await Folder.create(item, options));
      } else created.push(...(await original.folderCreateDocuments.call(this, [item], options)));
    }
    return created;
  };
  Folder.updateDocuments = async function (changes = [], options = {}) {
    if (
      !changes.some(
        (change) =>
          isGlobalFolder(game.folders.get(change._id)) ||
          (change.folder && isGlobalFolder(game.folders.get(change.folder))),
      )
    ) {
      return original.folderUpdateDocuments.call(this, changes, options);
    }
    const updated = [];
    for (const change of changes) {
      const folder = game.folders.get(change._id);
      if (!folder) continue;
      if (isGlobalFolder(folder) || (change.folder && isGlobalFolder(game.folders.get(change.folder)))) {
        updated.push(await folder.update(change, options));
      } else updated.push(...(await original.folderUpdateDocuments.call(this, [change], options)));
    }
    return updated;
  };
  Folder.prototype.update = async function (data = {}, options = {}) {
    if (this.type !== "Playlist") return original.folderUpdate.call(this, data, options);
    if (!isGlobalFolder(this)) {
      if (data.folder && isGlobalFolder(game.folders.get(data.folder))) {
        throw reportError(error("DirectFolderToGlobal"));
      }
      return original.folderUpdate.call(this, data, options);
    }
    try {
      if (data.folder && !isGlobalFolder(game.folders.get(data.folder))) {
        throw error("DirectFolderToLocal");
      }
      const next = applyChanges(this.toObject(), data);
      await persist(
        serialize(),
        null,
        serializeFolders().map((f) => (f._id === this.id ? next : f)),
      );
      installFolder(next);
      publish("reload");
      return state.folders.get(this.id);
    } catch (cause) {
      throw reportError(cause);
    }
  };
  Folder.prototype.delete = async function (options = {}) {
    if (!isGlobalFolder(this)) return original.folderDelete.call(this, options);
    try {
      if (hasBlockedBranch(this.id)) throw error("UnresolvedConflict");
      const branch = folderBranch(this.id, true);
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: t("UI.DeleteGlobalFolder") },
        content: `<p class="rn-confirm-message">${foundry.utils.escapeHTML(
          t("UI.DeleteGlobalFolderConfirm", {
            name: this.name,
            folders: branch.folders.length,
            playlists: branch.playlists.length,
          }),
        )}</p>`,
        yes: { label: t("UI.DeleteEverywhere") },
      });
      if (!confirmed) return null;
      const folderIds = new Set(branch.folders.map((f) => f.id));
      const playlistIds = new Set(branch.playlists.map((p) => p.id));
      const playback = foundry.utils.deepClone(state.playbackByWorld);
      for (const world of Object.values(playback)) for (const id of playlistIds) delete world[id];
      await persist(
        serialize().filter((p) => !playlistIds.has(p._id)),
        playback,
        serializeFolders().filter((f) => !folderIds.has(f._id)),
        {
          add: archiveEntries({
            playlists: branch.playlists.map((item) => item.toObject()),
            folders: branch.folders.map((item) => item.toObject()),
            reason: "deleted",
          }),
        },
      );
      for (const id of playlistIds) removeFromClient(id);
      for (const id of folderIds) removeFolder(id);
      publish("reload");
      return this;
    } catch (cause) {
      throw reportError(cause);
    }
  };
}
