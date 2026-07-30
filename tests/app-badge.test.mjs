import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../app/app-badge.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const badge = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("normalizes installed-app badge counts", () => {
  assert.equal(badge.normalizeAppBadgeCount(Number.NaN), 0);
  assert.equal(badge.normalizeAppBadgeCount(-1), 0);
  assert.equal(badge.normalizeAppBadgeCount(4.8), 4);
  assert.equal(badge.normalizeAppBadgeCount(120), 99);
});

test("sets and clears the app badge through the navigator API", async () => {
  const calls = [];
  const target = {
    async setAppBadge(count) {
      calls.push(["set", count]);
    },
    async clearAppBadge() {
      calls.push(["clear"]);
    },
  };

  assert.equal(await badge.updateInstalledAppBadge(7, target), true);
  assert.equal(await badge.updateInstalledAppBadge(0, target), true);
  assert.deepEqual(calls, [["set", 7], ["clear"]]);
});

test("falls back to the active service worker", async () => {
  const messages = [];
  const target = {
    async setAppBadge() {
      throw new Error("not installed in this browser shell");
    },
    serviceWorker: {
      ready: Promise.resolve({
        active: {
          postMessage(message) {
            messages.push(message);
          },
        },
      }),
    },
  };

  assert.equal(await badge.updateInstalledAppBadge(3, target), true);
  assert.deepEqual(messages, [{
    type: badge.APP_BADGE_MESSAGE,
    count: 3,
  }]);
});
