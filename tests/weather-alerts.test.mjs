import assert from "node:assert/strict";
import test from "node:test";

function getAlertSeverityClass(level) {
  return level.toLowerCase().includes("warning") ? "severe" : "watch";
}

function filterDismissedAlerts(alerts, dismissedIds) {
  return alerts.filter((alert) => !dismissedIds.has(alert.id));
}

test("getAlertSeverityClass correctly flags warning vs watch levels", () => {
  assert.equal(getAlertSeverityClass("Severe Weather Warning"), "severe");
  assert.equal(getAlertSeverityClass("Gale Warning"), "severe");
  assert.equal(getAlertSeverityClass("Flash Flood Warning"), "severe");
  assert.equal(getAlertSeverityClass("Severe Thunderstorm Watch"), "watch");
  assert.equal(getAlertSeverityClass("Flood Watch"), "watch");
  assert.equal(getAlertSeverityClass("Advisory"), "watch");
});

test("filterDismissedAlerts removes dismissed alerts", () => {
  const alerts = [
    { id: "a1", headline: "Alert 1", level: "Warning" },
    { id: "a2", headline: "Alert 2", level: "Watch" },
    { id: "a3", headline: "Alert 3", level: "Warning" },
  ];
  const dismissed = new Set(["a2"]);
  const active = filterDismissedAlerts(alerts, dismissed);
  assert.equal(active.length, 2);
  assert.equal(active[0].id, "a1");
  assert.equal(active[1].id, "a3");
});
