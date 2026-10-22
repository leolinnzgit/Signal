import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function worker() {
  const handlers = {};
  const notifications = [];
  let badgeChanges = 0;
  const self = {
    location: { origin: "https://signal.example.com" },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    navigator: { setAppBadge() { badgeChanges++; }, clearAppBadge() { badgeChanges++; } },
    registration: { showNotification(title, options) { notifications.push({ title, ...options }); return Promise.resolve(); } },
  };
  vm.runInNewContext(readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8"), { self, URL });
  return { notifications, get badgeChanges() { return badgeChanges; }, async push(payload) {
    let pending;
    handlers.push({ data: { json: () => payload }, waitUntil: promise => { pending = promise; } });
    await pending;
  } };
}

test("earthquake pushes retain an event-specific tag and preserve the news badge", async () => {
  const w = worker();
  await w.push({ title: "Earthquake: magnitude 4.8", body: "Near Wellington", tag: "signal-earthquake-geonet:test", url: "/#earthquake-alerts", badgeCount: 0 });
  assert.equal(w.notifications[0].tag, "signal-earthquake-geonet:test");
  assert.equal(w.notifications[0].data.url, "/#earthquake-alerts");
  assert.equal(w.badgeChanges, 0);
});

test("news notifications still update the badge and foreign click URLs remain local", async () => {
  const w = worker();
  await w.push({ title: "New story", tag: "signal-new-stories-123", url: "https://foreign.example/test", badgeCount: 3 });
  assert.equal(w.notifications[0].tag, "signal-new-stories-123");
  assert.equal(w.notifications[0].data.url, "/");
  assert.equal(w.badgeChanges, 1);
});
