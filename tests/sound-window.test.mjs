import assert from "node:assert/strict";
import test from "node:test";
import { rangesForViewport } from "../scripts/ui/sound-window.mjs";

test("multiple short playlists share the visible row budget", () => {
  const lists = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    total: 80,
    top: index * 1760,
    bottom: (index + 1) * 1760,
  }));
  const ranges = rangesForViewport(lists, 3000, 4100);
  const mounted = [...ranges.values()].reduce((sum, range) => sum + range.end - range.start, 0);
  assert.ok(mounted > 0);
  assert.ok(mounted <= 60);
  assert.equal(ranges.get("0").end, 0);
  assert.equal(ranges.get("9").end, 0);
  assert.ok(ranges.get("1").end > ranges.get("1").start);
  assert.ok(ranges.get("2").end > ranges.get("2").start);
});

test("a scrollbar jump selects the destination without visiting intermediate playlists", () => {
  const lists = Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    total: 80,
    top: index * 1760,
    bottom: (index + 1) * 1760,
  }));
  const ranges = rangesForViewport(lists, 16000, 17000);
  for (let index = 0; index < 9; index += 1) assert.deepEqual(ranges.get(String(index)), { start: 0, end: 0 });
  assert.ok(ranges.get("9").end > ranges.get("9").start);
});

test("a tall viewport uses measured row height and can exceed the configured minimum", () => {
  const ranges = rangesForViewport([{ id: "long", total: 200, top: 0, bottom: 4000, rowHeight: 20 }], 0, 1800, 60);
  assert.ok(ranges.get("long").end >= 90);
});
