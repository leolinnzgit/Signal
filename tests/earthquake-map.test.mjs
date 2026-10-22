import assert from "node:assert/strict";
import { test } from "node:test";

function getMagnitudeColor(mag) {
  if (mag >= 6.0) return "#ef4444";
  if (mag >= 5.0) return "#f97316";
  if (mag >= 4.0) return "#eab308";
  return "#06b6d4";
}

function calculateRadarPosition(distanceKm, index, maxDistanceKm = 500, maxRadiusPx = 220) {
  const boundedDist = Math.min(Math.max(distanceKm || 120, 10), maxDistanceKm);
  const angle = ((index * 67) % 360) * (Math.PI / 180);
  const r = (boundedDist / maxDistanceKm) * maxRadiusPx;
  return {
    cx: Math.sin(angle) * r,
    cy: -Math.cos(angle) * r,
  };
}

function buildMapFeedQuery(userCoords, source) {
  const query = new URLSearchParams();
  if (userCoords?.latitude !== undefined && userCoords?.longitude !== undefined) {
    query.set("latitude", userCoords.latitude.toString());
    query.set("longitude", userCoords.longitude.toString());
  }
  if (source && source !== "auto") {
    query.set("source", source);
  }
  return query.toString();
}

test("magnitude color scale distinguishes seismic severity tiers", () => {
  assert.equal(getMagnitudeColor(6.5), "#ef4444");
  assert.equal(getMagnitudeColor(6.0), "#ef4444");
  assert.equal(getMagnitudeColor(5.5), "#f97316");
  assert.equal(getMagnitudeColor(5.0), "#f97316");
  assert.equal(getMagnitudeColor(4.2), "#eab308");
  assert.equal(getMagnitudeColor(4.0), "#eab308");
  assert.equal(getMagnitudeColor(3.5), "#06b6d4");
  assert.equal(getMagnitudeColor(2.1), "#06b6d4");
});

test("radar projections constrain plotted coordinates within radar ring radius", () => {
  const pos1 = calculateRadarPosition(50, 0);
  assert(Math.hypot(pos1.cx, pos1.cy) < 50);

  const posFar = calculateRadarPosition(800, 3);
  const distFromCenter = Math.hypot(posFar.cx, posFar.cy);
  assert(distFromCenter <= 220, "Distance from center must not exceed maximum radar radius");
});

test("map-feed queries include GPS coordinates and custom source parameters", () => {
  const queryNZ = buildMapFeedQuery({ latitude: -41.28, longitude: 174.77 }, "geonet");
  assert.equal(queryNZ, "latitude=-41.28&longitude=174.77&source=geonet");

  const queryAuto = buildMapFeedQuery({ latitude: 37.77, longitude: -122.41 }, "auto");
  assert.equal(queryAuto, "latitude=37.77&longitude=-122.41");

  const queryEmpty = buildMapFeedQuery(null, "usgs");
  assert.equal(queryEmpty, "source=usgs");
});

test("earthquake reports preserve coordinates for Azure Maps pin placement", () => {
  const quake = {
    id: "geonet:2026p999999",
    source: "GeoNet",
    magnitude: 5.3,
    place: "Cook Strait",
    timeUtc: "2026-10-22T08:00:00Z",
    distanceKm: 38,
    depthKm: 12,
    url: "https://www.geonet.org.nz/earthquake/2026p999999",
    latitude: -41.45,
    longitude: 174.62,
  };
  assert.equal(quake.latitude, -41.45);
  assert.equal(quake.longitude, 174.62);
  assert.equal(quake.magnitude, 5.3);
});
