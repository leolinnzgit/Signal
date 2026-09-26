import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../app/app-badge.ts", import.meta.url),
  "utf8",
);
const serviceWorker = await readFile(
  new URL("../public/service-worker.js", import.meta.url),
  "utf8",
);
const notificationBadge = await readFile(
  new URL("../public/icons/signal-notification-medallion-96.png", import.meta.url),
);
const pushNotificationService = await readFile(
  new URL("../Signal.Server/Services/PushNotificationService.cs", import.meta.url),
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

test("notifies the service worker when clearing a directly supported badge", async () => {
  const calls = [];
  const messages = [];
  const target = {
    async clearAppBadge() {
      calls.push("clear");
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

  assert.equal(await badge.updateInstalledAppBadge(0, target), true);
  assert.deepEqual(calls, ["clear"]);
  assert.deepEqual(messages, [{
    type: badge.APP_BADGE_MESSAGE,
    count: 0,
  }]);
});

test("handles background push notifications and badge updates", () => {
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /setAppBadge/);
  assert.match(serviceWorker, /addEventListener\("notificationclick"/);
  assert.match(serviceWorker, /openWindow/);
  assert.match(serviceWorker, /getNotifications/);
  assert.match(serviceWorker, /notification\.close/);
});

test("uses a dedicated transparent Android notification badge", () => {
  assert.match(serviceWorker, /badge: payload\.badge \|\| "\/icons\/signal-notification-medallion-96\.png"/);
  assert.match(pushNotificationService, /badge = "\/icons\/signal-notification-medallion-96\.png"/);
  assert.equal(notificationBadge.readUInt32BE(16), 96);
  assert.equal(notificationBadge.readUInt32BE(20), 96);
  assert.equal(notificationBadge[25], 6);
});

function workerHarness() {
  const handlers = {};
  const notifications = new Map();
  const badgeCounts = [];
  vm.runInNewContext(serviceWorker, {
    URL,
    self: {
      addEventListener: (name, handler) => { handlers[name] = handler; },
      location: { origin: "https://signal.example" },
      navigator: {
        setAppBadge: async (count) => { badgeCounts.push(count); },
        clearAppBadge: async () => { badgeCounts.push(0); },
      },
      registration: {
        showNotification: async (title, options) => {
          notifications.set(options.tag, {
            title, ...options,
            close: () => notifications.delete(options.tag),
          });
        },
        getNotifications: async () => [...notifications.values()],
      },
    },
  });
  return {
    notifications, badgeCounts,
    async dispatch(name, data) {
      let pending;
      handlers[name]({
        data: name === "push" ? { json: () => data } : data,
        waitUntil: (promise) => { pending = promise; },
      });
      await pending;
    },
  };
}

test("keeps each news headline visible and replaces retries of the same story", async () => {
  const worker = workerHarness();
  for (const id of [1, 2, 1]) {
    await worker.dispatch("push", {
      title: `News headline ${id}`,
      body: "Publisher",
      tag: `signal-new-stories-${id}`,
      badgeCount: 2,
      url: "/#top",
    });
  }
  assert.equal(worker.notifications.size, 2);
  assert.equal(worker.notifications.get("signal-new-stories-1").title, "News headline 1");
  assert.equal(worker.notifications.get("signal-new-stories-2").body, "Publisher");
  assert.equal(worker.notifications.get("signal-new-stories-2").data.url, "/#top");
  assert.deepEqual(worker.badgeCounts, [2, 2, 2]);
});

test("retains legacy summary behavior and clears all news notifications only", async () => {
  const worker = workerHarness();
  await worker.dispatch("push", { title: "Old summary" });
  await worker.dispatch("push", { title: "Latest summary" });
  assert.equal(worker.notifications.size, 1);
  assert.equal(worker.notifications.get("signal-new-stories").title, "Latest summary");
  await worker.dispatch("push", { title: "Headline", tag: "signal-new-stories-3" });
  worker.notifications.set("unrelated", { tag: "unrelated", close() { throw new Error("Closed unrelated notification"); } });
  await worker.dispatch("message", { type: "signal:update-app-badge", count: 0 });
  assert.deepEqual([...worker.notifications.keys()], ["unrelated"]);
  assert.equal(worker.badgeCounts.at(-1), 0);
});
