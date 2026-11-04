import assert from "node:assert/strict";
import test from "node:test";
import { folderPlaylists, launchFolder, playlistActivity } from "../scripts/ui/folder-launcher.mjs";

const folders = [
  { id: "root", type: "Playlist", _source: { folder: null } },
  { id: "child", type: "Playlist", _source: { folder: "root" } },
  { id: "other", type: "Playlist", _source: { folder: null } },
];

function playlist(id, folder, { playing = false, paused = false } = {}) {
  const sound = { id: `${id}-sound`, playing, pausedTime: paused ? 12 : null };
  const calls = [];
  return {
    id,
    _source: { folder },
    sounds: [sound],
    playing,
    isOwner: true,
    calls,
    async playAll() {
      calls.push("play");
      this.playing = true;
      sound.playing = true;
      sound.pausedTime = null;
    },
    async stopAll() {
      calls.push("stop");
      this.playing = false;
      sound.playing = false;
    },
    async update(changes) {
      calls.push("clear pause");
      Object.assign(sound, changes.sounds[0]);
    },
  };
}

test("folder launcher includes descendant playlists regardless of child launcher flags", () => {
  const entries = [playlist("direct", "root"), playlist("nested", "child"), playlist("outside", "other")];
  assert.deepEqual(
    folderPlaylists("root", folders, entries).map((entry) => entry.id),
    ["direct", "nested"],
  );
});

test("play skips already playing playlists and resumes paused playlists", async () => {
  const active = playlist("active", "root", { playing: true });
  const paused = playlist("paused", "child", { paused: true });
  await launchFolder("root", "play", { folders, playlists: [active, paused] });
  assert.deepEqual(active.calls, []);
  assert.deepEqual(paused.calls, ["play"]);
  assert.equal(playlistActivity(paused).paused, false);
});

test("stop includes manually started playlists and clears pause positions", async () => {
  const active = playlist("active", "root", { playing: true });
  const paused = playlist("paused", "child", { paused: true });
  const stopped = playlist("stopped", "child");
  await launchFolder("root", "stop", { folders, playlists: [active, paused, stopped] });
  assert.deepEqual(active.calls, ["stop"]);
  assert.deepEqual(paused.calls, ["stop", "clear pause"]);
  assert.deepEqual(stopped.calls, []);
});
