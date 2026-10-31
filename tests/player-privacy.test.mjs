import assert from "node:assert/strict";
import test from "node:test";
import { filterRestrictedTree, restrictedPlaylist } from "../scripts/ui/player-privacy.mjs";

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

test("players do not see empty playlist folders after restricted entries are removed", () => {
  globalThis.game = {
    user: { isGM: false },
    settings: { get: () => true },
    playlists: new Map([["restricted", { testUserPermission: () => false }]]),
  };
  const root = {
    folder: null,
    entries: [],
    children: [
      { folder: { id: "empty" }, entries: [], children: [] },
      { folder: { id: "hidden" }, entries: [{ id: "restricted" }], children: [] },
    ],
  };
  assert.deepEqual(filterRestrictedTree(root).children, []);
  game.user.isGM = true;
  assert.equal(filterRestrictedTree(root).children.length, 2);
});
