import test from "node:test";
import assert from "node:assert/strict";
import {
  projectCoordinatesToSvg,
  getThreatColor,
  formatTransitMemo,
} from "../app/geopolitical-transit.ts";

test("projectCoordinatesToSvg accurately converts geo coordinates to SVG space", () => {
  // Equator, Prime Meridian
  const origin = projectCoordinatesToSvg(0, 0, 800, 400);
  assert.equal(origin.x, 400);
  assert.equal(origin.y, 200);

  // Hormuz ~ (26.56, 56.25)
  const hormuz = projectCoordinatesToSvg(26.5667, 56.25, 800, 400);
  assert.ok(hormuz.x > 400 && hormuz.x < 600, "Hormuz should be east of meridian");
  assert.ok(hormuz.y < 200, "Hormuz should be in northern hemisphere");

  // Clamping extreme poles
  const northPole = projectCoordinatesToSvg(90, 0, 800, 400);
  assert.equal(northPole.y, 0); // clamped to lat 85
});

test("getThreatColor provides distinct visual attributes per posture", () => {
  const critical = getThreatColor("Critical");
  assert.equal(critical.fill, "#ef4444");
  assert.equal(critical.badgeClass, "threat-critical");

  const high = getThreatColor("High");
  assert.equal(high.fill, "#f97316");
  assert.equal(high.badgeClass, "threat-high");

  const elevated = getThreatColor("Elevated");
  assert.equal(elevated.fill, "#eab308");
  assert.equal(elevated.badgeClass, "threat-elevated");

  const normal = getThreatColor("Normal");
  assert.equal(normal.fill, "#10b981");
  assert.equal(normal.badgeClass, "threat-normal");
});

test("formatTransitMemo compiles an executive-ready strategic Markdown memo", () => {
  const mockChokepoint = {
    id: "bab-el-mandeb",
    name: "Bab el-Mandeb & Southern Red Sea",
    region: "Horn of Africa / Red Sea",
    coordinates: [12.5833, 43.3333],
    threatLevel: "Critical",
    dailyTeuVolume: 68000,
    dailyOilBarrelsMbpd: 8.8,
    detourDays: 12.0,
    fuelCostDeltaPercent: 38.5,
    airspaceStatus: "Restricted",
    keyCommodities: ["Manufactured Goods", "Electronics"],
    activeNotams: ["UK CAA NOTAM V0044/26"],
    strategicBrief: "65% container diversion.",
  };

  const mockAssessment = {
    chokepointId: "bab-el-mandeb",
    name: "Bab el-Mandeb & Southern Red Sea",
    riskScore: 88,
    statusDescription: "Critical posture",
    alternativeRoute: "Cape of Good Hope reroute (+12 days)",
    estimatedDailyTradeDisruptionUsd: "$3.8B daily merchandise",
    executiveActionItems: ["Lock in bunker fuel futures.", "Advance delivery windows."],
    correlatedArticles: [],
    assessedAt: new Date().toISOString(),
  };

  const memo = formatTransitMemo(mockChokepoint, mockAssessment);
  assert.ok(memo.includes("SIGNAL GEOPOLITICAL TRANSIT BRIEFING"));
  assert.ok(memo.includes("Bab el-Mandeb"));
  assert.ok(memo.includes("68,000 TEU"));
  assert.ok(memo.includes("+12 days transit penalty"));
  assert.ok(memo.includes("Cape of Good Hope"));
  assert.ok(memo.includes("Lock in bunker fuel futures."));
});
