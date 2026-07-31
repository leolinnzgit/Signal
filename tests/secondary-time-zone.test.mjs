import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/secondary-time-zone.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const timeZones = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("normalizes a supported secondary timezone", () => {
  assert.deepEqual(timeZones.normalizeSecondaryTimeZone({
    name: "  Taipei,   Taiwan ",
    timeZone: "Asia/Taipei",
  }), {
    name: "Taipei, Taiwan",
    timeZone: "Asia/Taipei",
  });
});

test("rejects missing or unsupported secondary timezones", () => {
  assert.equal(timeZones.normalizeSecondaryTimeZone(null), null);
  assert.equal(timeZones.normalizeSecondaryTimeZone({
    name: "Somewhere",
    timeZone: "Mars/Olympus_Mons",
  }), null);
});
