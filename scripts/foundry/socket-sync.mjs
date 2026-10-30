import { playbackData } from "../audio/playback-state.mjs";
import { reportError, state } from "../core/context.mjs";
import { applyChanges, invalidateGlobalReload, reloadGlobalPlaylists } from "../library/global-library.mjs";
import { installInClient, removeFromClient } from "./client-collection.mjs";

export function onSocket(message) {
  if (message?.sender === game.user.id) return;
  if (["patch", "upsert", "remove", "revision", "reload"].includes(message?.type)) state.indexCache = null;
  if (["patch", "upsert", "remove", "revision"].includes(message?.type)) invalidateGlobalReload();
  if (["patch", "upsert", "remove"].includes(message.type)) {
    const revision = message.revision;
    if (Number.isInteger(revision)) {
      if (revision <= state.revision) return;
      if (state.stale || revision !== state.revision + 1) {
        state.stale = true;
        reloadGlobalPlaylists().catch(reportError);
        return;
      }
    }
    if (message.type === "patch") {
      const current = state.playlists.get(message.payload.id);
      if (!current) {
        reloadGlobalPlaylists().catch(reportError);
        return;
      }
      const updated = applyChanges(current.toObject(), message.payload.changes);
      if (!installInClient(updated)) {
        reloadGlobalPlaylists().catch(reportError);
        return;
      }
      state.playbackByWorld[game.world.id] ??= {};
      const previous = state.playbackByWorld[game.world.id][message.payload.id];
      state.playbackByWorld[game.world.id][message.payload.id] = playbackData(
        updated,
        message.payload.randomHistory ?? previous?.randomHistory,
      );
    } else if (message.type === "upsert") {
      if (!installInClient(message.payload)) {
        reloadGlobalPlaylists().catch(reportError);
        return;
      }
      const id = message.payload._id;
      if (!state.playlistOrder.includes(id)) state.playlistOrder.push(id);
      state.playbackByWorld[game.world.id] ??= {};
      const previous = state.playbackByWorld[game.world.id][id];
      state.playbackByWorld[game.world.id][id] = playbackData(message.payload, previous?.randomHistory);
    } else {
      const id = message.payload.id;
      removeFromClient(id);
      state.blockedPlaylists.delete(id);
      state.playlistOrder = state.playlistOrder.filter((entry) => entry !== id);
      delete state.playbackByWorld[game.world.id]?.[id];
    }
    if (Number.isInteger(revision)) state.revision = revision;
  }
  if (message.type === "reload") reloadGlobalPlaylists().catch(reportError);
  if (message.type === "revision" && message.payload.revision > state.revision) {
    state.stale = true;
    reloadGlobalPlaylists().catch(reportError);
  }
}
