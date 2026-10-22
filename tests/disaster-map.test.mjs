import assert from "node:assert/strict";
import { test } from "node:test";
import { filterMapEvents, mapEvents, eventColor, eventDetails, eventSymbol, overviewPosition } from "../app/disaster-map.ts";

const quake = { id: "q", magnitude: 4.5, depthKm: 12, place: "Cook Strait", distanceKm: 35 };
const flood = { id: "f", kind: "flood", title: "Flooding in Fiji", alertLevel: "orange", distanceKm: null };
const events = mapEvents([quake], [flood]);

test("normalizes earthquakes and disasters while preserving hazard-specific facts", () => {
  assert.equal(events[0].kind, "earthquake");
  assert.equal(events[1].place, flood.title);
  assert.equal(eventSymbol(events[0]), "4.5");
  assert.equal(eventSymbol(events[1]), "FL");
  assert.equal(eventDetails(events[1]), "Distance unavailable · orange alert");
  assert(!eventDetails(events[1]).includes("depth"));
  assert.equal(mapEvents([quake], [], false)[0].distanceKm, null, "Missing GPS must never appear as zero kilometres away.");
});
test("earthquake magnitude filtering never removes flood reports", () => {
  assert.deepEqual(filterMapEvents(events, ["earthquake", "flood"], 5).map(e => e.id), ["f"]);
  assert.deepEqual(filterMapEvents(events, ["earthquake"], 0).map(e => e.id), ["q"]);
  assert.deepEqual(filterMapEvents(events, [], 0), []);
});
test("hazards and earthquake magnitude tiers have distinct symbols and colors", () => {
  assert.equal(eventColor({ kind: "earthquake", magnitude: 6 }), "#ef4444");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 5 }), "#f97316");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 4 }), "#eab308");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 3 }), "#06b6d4");
  const kinds = ["flood", "storm", "wildfire", "volcano", "drought"];
  assert.equal(new Set(kinds.map(kind => eventColor({ kind }))).size, 5);
  assert.equal(new Set(kinds.map(kind => eventSymbol({ kind }))).size, 5);
});
test("coordinate overview uses actual hemispheres and date-line boundaries", () => {
  assert.deepEqual(overviewPosition(90, 180), { cx: 220, cy: -110 });
  assert.deepEqual(overviewPosition(-90, -180), { cx: -220, cy: 110 });
  assert.deepEqual(overviewPosition(0, 0), { cx: 0, cy: -0 });
  assert(overviewPosition(-41, 175).cy > 0);
});
