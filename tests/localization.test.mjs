import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
}

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof entry === "string" ? [[path, entry]] : flatten(entry, path);
  });
}

test("Russian and English provide the same translation keys and interpolation parameters", () => {
  const english = new Map(flatten(readJson("../lang/en.json")));
  const russian = new Map(flatten(readJson("../lang/ru.json")));
  assert.deepEqual([...russian.keys()].sort(), [...english.keys()].sort());
  for (const [key, text] of english) {
    const parameters = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(parameters(russian.get(key)), parameters(text), `Interpolation mismatch: ${key}`);
  }
  const manifest = readJson("../module.json");
  assert.deepEqual(
    manifest.languages.map(({ lang, path }) => [lang, path]),
    [
      ["en", "lang/en.json"],
      ["ru", "lang/ru.json"],
    ],
  );
});
