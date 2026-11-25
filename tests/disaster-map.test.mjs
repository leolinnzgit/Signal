import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterMapEvents,
  filterAnyMapEvents,
  mapEvents,
  newsToMapEvents,
  groupMapPins,
  eventColor,
  eventDetails,
  eventSymbol,
  overviewPosition,
  buildAzureWeatherTileUrl,
  formatRadarOffsetLabel,
} from "../app/disaster-map.ts";

const quake = { id: "q", magnitude: 4.5, depthKm: 12, place: "Cook Strait", distanceKm: 35 };
const flood = { id: "f", kind: "flood", title: "Flooding in Fiji", alertLevel: "orange", distanceKm: null };
const events = mapEvents([quake], [flood]);

const newsItems = newsToMapEvents([
  {
    id: "news:1",
    kind: "news",
    title: "Port upgrades approved in Auckland",
    locationName: "Auckland, New Zealand",
    source: "RNZ",
    summary: "Work starts next month.",
    url: "https://example.com/auckland-port",
    topics: ["Infrastructure", "New Zealand"],
    publishedAtUtc: "2026-11-24T05:00:00Z",
    latitude: -36.8485,
    longitude: 174.7633,
    distanceKm: 12,
  },
  {
    id: "news:2",
    kind: "news",
    title: "Tech hub expands in central Auckland",
    locationName: "Auckland, New Zealand",
    source: "Stuff",
    summary: "New office campus announced.",
    url: "https://example.com/auckland-tech",
    topics: ["Technology"],
    publishedAtUtc: "2026-11-24T04:00:00Z",
    latitude: -36.85,
    longitude: 174.76,
    distanceKm: 13,
  },
  {
    id: "news:3",
    kind: "news",
    title: "Trade talks conclude in Tokyo",
    locationName: "Tokyo, Japan",
    source: "Reuters",
    summary: "Ministers signed a framework agreement.",
    url: "https://example.com/tokyo-trade",
    topics: ["Economy"],
    publishedAtUtc: "2026-11-24T03:00:00Z",
    latitude: 35.6762,
    longitude: 139.6503,
    distanceKm: 8800,
  },
]);

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
test("hazards, news, and earthquake magnitude tiers have distinct symbols and colors", () => {
  assert.equal(eventColor({ kind: "earthquake", magnitude: 6 }), "#ef4444");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 5 }), "#f97316");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 4 }), "#eab308");
  assert.equal(eventColor({ kind: "earthquake", magnitude: 3 }), "#06b6d4");
  assert.equal(eventColor({ kind: "news" }), "#10b981");
  assert.equal(eventSymbol({ kind: "news" }), "NW");
  const kinds = ["news", "flood", "storm", "wildfire", "volcano", "drought", "weather"];
  assert.equal(new Set(kinds.map(kind => eventColor({ kind }))).size, 7);
  assert.equal(new Set(kinds.map(kind => eventSymbol({ kind }))).size, 7);
});
test("coordinate overview uses actual hemispheres and date-line boundaries", () => {
  assert.deepEqual(overviewPosition(90, 180), { cx: 220, cy: -110 });
  assert.deepEqual(overviewPosition(-90, -180), { cx: -220, cy: 110 });
  assert.deepEqual(overviewPosition(0, 0), { cx: 0, cy: -0 });
  assert(overviewPosition(-41, 175).cy > 0);
});
test("news map events filter cleanly by layer, magnitude, and topic", () => {
  const combined = [...newsItems, ...events];
  const magFiltered = filterAnyMapEvents(combined, ["news", "earthquake", "flood"], 5);
  assert.deepEqual(magFiltered.map(e => e.id), ["news:1", "news:2", "news:3", "f"]);

  const techOnly = filterAnyMapEvents(combined, ["news"], 0, "Technology");
  assert.deepEqual(techOnly.map(e => e.id), ["news:2"]);

  assert.equal(eventDetails(newsItems[0]), "Auckland, New Zealand · 12 km away");
  const noGpsNews = newsToMapEvents([
    {
      id: "news:4",
      kind: "news",
      title: "Test",
      locationName: "Paris, France",
      source: "AFP",
      summary: "",
      url: "https://example.com/paris",
      topics: [],
      publishedAtUtc: "2026-11-24T00:00:00Z",
      latitude: 48.8566,
      longitude: 2.3522,
      distanceKm: 500,
    },
  ], false);
  assert.equal(eventDetails(noGpsNews[0]), "Paris, France");
});
test("groupMapPins clusters co-located news stories while keeping disasters ungrouped", () => {
  const combined = [
    ...newsItems,
    { ...events[0], latitude: -41, longitude: 175 },
    { ...events[1], latitude: -18, longitude: 178 },
  ];
  const groups = groupMapPins(combined);
  assert.equal(groups.length, 4);
  const aucklandGroup = groups.find(g => g.kind === "news" && g.items.length === 2);
  assert(aucklandGroup, "Expected two Auckland stories to group into one pin.");
  assert.equal(aucklandGroup.label, "2");
  const tokyoGroup = groups.find(g => g.kind === "news" && g.items.length === 1);
  assert(tokyoGroup);
  assert.equal(tokyoGroup.label, "NW");
});

test("buildAzureWeatherTileUrl builds live and 5-minute rounded timestamped weather tile URLs", () => {
  const fixed = new Date("2026-11-25T19:07:20.000Z");
  const liveRadar = buildAzureWeatherTileUrl("radar", 0, fixed);
  assert.equal(
    liveRadar,
    "https://{azMapsDomain}/map/tile?api-version=2024-04-01&tilesetId=microsoft.weather.radar.main&zoom={z}&x={x}&y={y}&tileSize=256",
  );

  const futureRadar = buildAzureWeatherTileUrl("radar", 30, fixed);
  assert.ok(futureRadar.includes("tilesetId=microsoft.weather.radar.main"));
  assert.ok(futureRadar.includes("timeStamp=2026-11-25T19%3A35%3A00Z"), `Expected 5-min rounded UTC timestamp, got ${futureRadar}`);

  const clampedPastInfrared = buildAzureWeatherTileUrl("infrared", 45, fixed);
  assert.equal(
    clampedPastInfrared,
    "https://{azMapsDomain}/map/tile?api-version=2024-04-01&tilesetId=microsoft.weather.infrared.main&zoom={z}&x={x}&y={y}&tileSize=256",
    "Infrared clouds are historical/live only and clamp positive offsets to 0.",
  );

  const pastInfrared = buildAzureWeatherTileUrl("infrared", -30, fixed);
  assert.ok(pastInfrared.includes("timeStamp=2026-11-25T18%3A35%3A00Z"));

  assert.equal(formatRadarOffsetLabel(0), "Now");
  assert.equal(formatRadarOffsetLabel(15), "+15m");
  assert.equal(formatRadarOffsetLabel(-60), "-60m");
});
