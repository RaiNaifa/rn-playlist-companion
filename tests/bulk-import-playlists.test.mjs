import assert from "node:assert/strict";
import test from "node:test";
import { planPlaylistImport, renderImportTree } from "../scripts/ui/bulk-import-playlists.mjs";

const tree = {
  name: "Music",
  files: ["Music/theme.ogg"],
  children: [
    { name: "Battle", files: ["Music/Battle/one.mp3"], children: [] },
    { name: "Silent", files: [], children: [] },
    {
      name: "Nested",
      files: [],
      children: [{ name: "Calm", files: ["Music/Nested/Calm/two.wav"], children: [] }],
    },
  ],
};

test("imports audio folders as playlists and retains nested folder structure", () => {
  const plan = planPlaylistImport(tree);
  assert.deepEqual(
    plan.folders.map((folder) => folder.key.join("/")),
    ["Music", "Music/Nested"],
  );
  assert.deepEqual(
    plan.playlists.map((playlist) => [playlist.name, playlist.folderKey.join("/")]),
    [
      ["Music", "Music"],
      ["Battle", "Music"],
      ["Calm", "Music/Nested"],
    ],
  );
});

test("empty directories become playlists only when selected", () => {
  const plan = planPlaylistImport(tree, true);
  assert.deepEqual(
    plan.playlists.map((playlist) => playlist.name),
    ["Music", "Battle", "Silent", "Calm"],
  );
  assert.equal(plan.playlists.find((playlist) => playlist.name === "Silent").files.length, 0);
});

test("preview shows nesting and only includes empty playlists when selected", () => {
  globalThis.foundry = { utils: { escapeHTML: (value) => String(value) } };
  globalThis.game = { i18n: { format: (_key, data) => `sounds: ${data.count}` } };
  const normal = renderImportTree(tree);
  const withEmpty = renderImportTree(tree, true);
  assert.match(normal, /Music.*<ul>.*Battle.*Nested.*<ul>.*Calm/s);
  assert.doesNotMatch(normal, /Silent/);
  assert.match(withEmpty, /Silent.*sounds: 0/);
});
