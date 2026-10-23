import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDisasterSettings, normalizeDisasterNotification, disasterAnnouncement, appendDisasterAlerts, previewDisaster } from "../app/disaster-alerts.ts";

test("existing earthquake settings migrate to all disaster types without changing distance, magnitude, voice or device", () => {
  const deviceId = "6f41d018-8a45-4d81-a4fb-881d0aa12ac1";
  const settings = normalizeDisasterSettings({ enabled: true, voice: false, radiusKm: 500, minimumMagnitude: 5, deviceId }, "new");
  assert.equal(settings.deviceId, deviceId);
  assert.equal(settings.hazardKinds.length, 6);
  assert.equal(settings.radiusKm, 500);
  assert.equal(settings.minimumMagnitude, 5);
  assert.equal(settings.voice, false);
  assert.equal(settings.enabled, true);
  assert.deepEqual(normalizeDisasterSettings({ hazardKinds: ["flood"], minimumAlertLevel: "red" }, deviceId).hazardKinds, ["flood"]);
  assert.equal(normalizeDisasterSettings({ hazardKinds: [], radiusKm: -5 }, deviceId).radiusKm, 300);
});
test("disaster narration distinguishes alert levels from earthquake magnitude and depth", () => {
  const flood = { ...previewDisaster("flood"), source: "GDACS" };
  const text = disasterAnnouncement(flood);
  assert.match(text, /Flood reported by GDACS/);
  assert.match(text, /orange alert/);
  assert(!/magnitude|depth/i.test(text));
  assert.match(disasterAnnouncement(previewDisaster("earthquake")), /Magnitude 5.2/);
  for (const kind of ["flood", "storm", "wildfire", "volcano", "drought"]) assert(!disasterAnnouncement(previewDisaster(kind)).includes("undefined"));
});
test("queued reports survive repeated polls and deduplicate by disaster episode and level", () => {
  const flood = { ...previewDisaster("flood"), notificationKey: "gdacs:FL:1:episode1:orange" };
  const fire = previewDisaster("wildfire");
  let queue = appendDisasterAlerts([], [flood, fire, flood], new Set(), ["flood", "wildfire"]);
  assert.equal(queue.length, 2);
  queue = appendDisasterAlerts(queue, [flood, fire], new Set([flood.notificationKey]), ["flood", "wildfire"]);
  assert.equal(queue.length, 2, "An already visible report stays in the queue until dismissed.");
  queue = appendDisasterAlerts(queue.slice(1), [flood, fire], new Set([flood.notificationKey]), ["flood", "wildfire"]);
  assert.equal(queue.length, 1, "Dismissed reports must not reappear.");
  const escalated = { ...flood, notificationKey: "gdacs:FL:1:episode1:red", alertLevel: "red" };
  assert.equal(appendDisasterAlerts(queue, [escalated], new Set([flood.notificationKey]), ["flood", "wildfire"]).length, 2);
  assert.deepEqual(appendDisasterAlerts(queue, [flood], new Set(), ["earthquake"]), []);
});
test("legacy earthquake event identifiers still deduplicate", () => {
  const legacy = { ...previewDisaster("earthquake"), id: "geonet:123", notificationKey: undefined, kind: undefined };
  const normalized = normalizeDisasterNotification(legacy);
  assert.equal(normalized.notificationKey, "geonet:123");
  assert.equal(normalized.kind, "earthquake");
  assert.deepEqual(appendDisasterAlerts([], [normalized], new Set(["geonet:123"]), ["earthquake"]), []);
});
