import assert from "node:assert/strict";
import test from "node:test";
import { restrictedPlaylist } from "../scripts/ui/player-privacy.mjs";

test("playlist privacy depends on Observer access, not role playlist permission", () => {
  const user = { isGM: false, hasPermission: () => false };
  globalThis.game = { user, settings: { get: () => true } };
  const playlist = { testUserPermission: () => true };
  game.playlists = new Map([["playlist", playlist]]);
  assert.equal(restrictedPlaylist(playlist), false);
  assert.equal(restrictedPlaylist({ id: "playlist" }), false);
  playlist.testUserPermission = () => false;
  assert.equal(restrictedPlaylist(playlist), true);
  assert.equal(restrictedPlaylist({ id: "playlist" }), true);
  playlist.testUserPermission = () => true;
  playlist.testUserPermission = () => true;
  assert.equal(restrictedPlaylist(playlist), false);
  playlist.testUserPermission = () => false;
  user.isGM = true;
  assert.equal(restrictedPlaylist(playlist), false);
  user.isGM = false;
  game.settings.get = () => false;
  assert.equal(restrictedPlaylist(playlist), false);
});
