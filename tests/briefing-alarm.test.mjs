import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function createWorker() {
  const handlers = {};
  const notifications = [];
  const postedMessages = [];
  let badgeChanges = 0;
  const clients = {
    matchAll: async () => [{
      url: "https://signal.example.com/",
      postMessage: (msg) => { postedMessages.push(msg); },
      focus: async () => {},
    }],
    openWindow: async (url) => ({ url, focus: async () => {} }),
  };
  const self = {
    location: { origin: "https://signal.example.com" },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    navigator: { setAppBadge() { badgeChanges++; }, clearAppBadge() { badgeChanges++; } },
    registration: {
      showNotification(title, options) {
        notifications.push({ title, ...options });
        return Promise.resolve();
      },
    },
    clients,
  };
  vm.runInNewContext(readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8"), { self, URL });

  return {
    notifications,
    postedMessages,
    get badgeChanges() { return badgeChanges; },
    async push(payload) {
      let pending;
      handlers.push({ data: { json: () => payload }, waitUntil: promise => { pending = promise; } });
      await pending;
    },
    async click(notification, action) {
      let pending;
      handlers.notificationclick({
        action,
        notification: {
          ...notification,
          close: () => {},
        },
        waitUntil: promise => { pending = promise; },
      });
      await pending;
    },
  };
}

test("briefing push notifications attach alarm actions (play, snooze, carMode) and preserve badge", async () => {
  const w = createWorker();
  await w.push({
    title: "Executive Daily Briefing",
    body: "Good morning! Markets and lead stories are ready.",
    tag: "signal-briefing-wake-up",
    url: "/?briefing=1",
    badgeCount: 0,
  });

  assert.equal(w.notifications.length, 1);
  const n = w.notifications[0];
  assert.equal(n.tag, "signal-briefing-wake-up");
  assert.equal(n.data.isBriefing, true);
  assert.ok(Array.isArray(n.actions) && n.actions.length === 3);
  assert.equal(n.actions[0].action, "play");
  assert.equal(n.actions[1].action, "snooze");
  assert.equal(n.actions[2].action, "carMode");
  assert.equal(w.badgeChanges, 0); // Briefing pushes preserve the news badge
});

test("notificationclick on snooze broadcasts 10m snooze and shows acknowledgement", async () => {
  const w = createWorker();
  await w.push({
    title: "Executive Daily Briefing",
    tag: "signal-briefing-wake-up",
    url: "/?briefing=1",
    badgeCount: 0,
  });

  const original = w.notifications[0];
  await w.click(original, "snooze");

  // Broadcasts snooze event to open clients
  assert.ok(w.postedMessages.some(msg => msg.type === "signal:briefing-snooze" && msg.minutes === 10));
  // Shows snooze confirmation notification
  const snoozeNotification = w.notifications.find(n => n.tag === "signal-briefing-snoozed");
  assert.ok(snoozeNotification);
  assert.match(snoozeNotification.title, /Snoozed/i);
});
