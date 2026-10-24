import { state } from "../core/context.mjs";
import { invalidateGlobalReload, reloadGlobalPlaylists } from "../library/global-library.mjs";
import { installInClient, removeFromClient } from "./client-collection.mjs";

export function onSocket(message) {
  if (message?.sender === game.user.id) return;
  if (["upsert", "remove", "revision"].includes(message?.type)) invalidateGlobalReload();
  if (message.type === "upsert") installInClient(message.payload);
  if (message.type === "remove") removeFromClient(message.payload.id);
  if (message.type === "reload") reloadGlobalPlaylists().catch(console.error);
  if (message.type === "revision" && message.payload.revision > state.revision) state.stale = true;
}
