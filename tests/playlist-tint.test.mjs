import assert from "node:assert/strict";
import test from "node:test";
import { refreshPlaylistTint, tintBackground } from "../scripts/ui/playlist-tint.mjs";

test("playlist tint converts a hex color to a translucent background", () => {
  assert.equal(tintBackground("#ff3c00"), "rgba(255, 60, 0, 0.25)");
  assert.equal(tintBackground("#2A1313"), "rgba(42, 19, 19, 0.25)");
  assert.equal(tintBackground(""), "");
  assert.equal(tintBackground("red"), "");
});

test("saved tint updates the existing playlist row immediately", () => {
  const row = { dataset: { entryId: "playlist-1" }, style: { backgroundColor: "" } };
  const other = { dataset: { entryId: "playlist-2" }, style: { backgroundColor: "other" } };
  const element = { querySelectorAll: () => [row, other] };
  const playlist = { id: "playlist-1", flags: { "rn-playlist-companion": { tint: "#ff3c00" } } };
  refreshPlaylistTint(playlist, [element]);
  assert.equal(row.style.backgroundColor, "rgba(255, 60, 0, 0.25)");
  assert.equal(other.style.backgroundColor, "other");
  playlist.flags["rn-playlist-companion"].tint = "";
  refreshPlaylistTint(playlist, [element]);
  assert.equal(row.style.backgroundColor, "");
});
