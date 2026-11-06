import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTIVE_SUITES,
  filterExecutiveSuites,
  getCategoryCounts,
  getRecentSuites,
  recordRecentSuite,
} from "../app/executive-command-center.ts";

test("EXECUTIVE_SUITES registry contains exactly 23 distinct tools with valid fields", () => {
  assert.equal(EXECUTIVE_SUITES.length, 23, "Should contain exactly 23 executive suites");
  
  const ids = new Set();
  for (const suite of EXECUTIVE_SUITES) {
    assert.ok(suite.id, "Suite must have an id");
    assert.ok(!ids.has(suite.id), `Suite id ${suite.id} must be unique`);
    ids.add(suite.id);
    assert.ok(suite.title, `Suite ${suite.id} must have a title`);
    assert.ok(suite.subtitle, `Suite ${suite.id} must have a subtitle`);
    assert.ok(suite.icon, `Suite ${suite.id} must have an icon`);
    assert.ok(["risk", "strategy", "workflow"].includes(suite.category), `Invalid category ${suite.category}`);
    assert.ok(Array.isArray(suite.keywords) && suite.keywords.length > 0, `Keywords required for ${suite.id}`);
  }
});

test("getCategoryCounts accurately partitions the 23 suites into 7 risk, 8 strategy, 8 workflow", () => {
  const counts = getCategoryCounts(EXECUTIVE_SUITES);
  assert.equal(counts.all, 23);
  assert.equal(counts.risk, 7);
  assert.equal(counts.strategy, 8);
  assert.equal(counts.workflow, 8);
});

test("filterExecutiveSuites filters accurately by category", () => {
  const riskSuites = filterExecutiveSuites(EXECUTIVE_SUITES, "", "risk");
  assert.equal(riskSuites.length, 7);
  assert.ok(riskSuites.every((s) => s.category === "risk"));

  const strategySuites = filterExecutiveSuites(EXECUTIVE_SUITES, "", "strategy");
  assert.equal(strategySuites.length, 8);
  assert.ok(strategySuites.every((s) => s.category === "strategy"));

  const workflowSuites = filterExecutiveSuites(EXECUTIVE_SUITES, "", "workflow");
  assert.equal(workflowSuites.length, 8);
  assert.ok(workflowSuites.every((s) => s.category === "workflow"));

  const allSuites = filterExecutiveSuites(EXECUTIVE_SUITES, "", "all");
  assert.equal(allSuites.length, 23);
});

test("filterExecutiveSuites matches queries across titles, subtitles, categories and keywords", () => {
  // Title match
  const radarMatches = filterExecutiveSuites(EXECUTIVE_SUITES, "radar");
  // "Executive Radar", "Cyber Threat Radar", "Sanctions & Tariffs Radar", "Regulatory Horizon" (contains radar in subtitle/keywords), "Competitor Radar & M&A"
  assert.ok(radarMatches.length >= 4);

  // Keyword match
  const ofacMatches = filterExecutiveSuites(EXECUTIVE_SUITES, "ofac");
  assert.equal(ofacMatches.length, 1);
  assert.equal(ofacMatches[0].id, "sanctions-radar");

  // Subtitle match
  const monteCarloMatches = filterExecutiveSuites(EXECUTIVE_SUITES, "Monte Carlo");
  assert.equal(monteCarloMatches.length, 1);
  assert.equal(monteCarloMatches[0].id, "scenario-simulator");

  // Multi-term / whitespace trimming
  const chokepointsMatches = filterExecutiveSuites(EXECUTIVE_SUITES, "   chokepoints  ");
  assert.equal(chokepointsMatches.length, 2);
  const matchedIds = chokepointsMatches.map((m) => m.id);
  assert.ok(matchedIds.includes("supply-chain"));
  assert.ok(matchedIds.includes("geopolitical-transit"));

  // Non-matching query returns empty array
  const emptyMatches = filterExecutiveSuites(EXECUTIVE_SUITES, "nonexistent-query-xyz");
  assert.equal(emptyMatches.length, 0);
});

test("recordRecentSuite and getRecentSuites safely persists, deduplicates, and bounds recent items", () => {
  const mockStorageMap = new Map();
  const mockStorage = {
    getItem: (key) => mockStorageMap.get(key) || null,
    setItem: (key, val) => mockStorageMap.set(key, val),
  };

  // Initially empty
  assert.deepEqual(getRecentSuites(EXECUTIVE_SUITES, mockStorage), []);

  // Record 1 suite
  recordRecentSuite("radar", mockStorage);
  let recents = getRecentSuites(EXECUTIVE_SUITES, mockStorage);
  assert.equal(recents.length, 1);
  assert.equal(recents[0].id, "radar");

  // Record second suite
  recordRecentSuite("knowledge-graph", mockStorage);
  recents = getRecentSuites(EXECUTIVE_SUITES, mockStorage);
  assert.equal(recents.length, 2);
  assert.equal(recents[0].id, "knowledge-graph");
  assert.equal(recents[1].id, "radar");

  // Re-record "radar" -> should move to top without duplicate
  recordRecentSuite("radar", mockStorage);
  recents = getRecentSuites(EXECUTIVE_SUITES, mockStorage);
  assert.equal(recents.length, 2);
  assert.equal(recents[0].id, "radar");
  assert.equal(recents[1].id, "knowledge-graph");

  // Record more to test MAX_RECENT_SUITES = 4 cap
  recordRecentSuite("sanctions-radar", mockStorage);
  recordRecentSuite("csuite-report", mockStorage);
  recordRecentSuite("horizon-scanner", mockStorage);

  recents = getRecentSuites(EXECUTIVE_SUITES, mockStorage);
  assert.equal(recents.length, 4, "Should be capped at 4 recent items");
  assert.equal(recents[0].id, "horizon-scanner");
  assert.equal(recents[1].id, "csuite-report");
  assert.equal(recents[2].id, "sanctions-radar");
  assert.equal(recents[3].id, "radar");
});

test("getRecentSuites handles corrupted storage safely without throwing", () => {
  const corruptedStorage = {
    getItem: () => "{invalid-json",
    setItem: () => {},
  };
  assert.deepEqual(getRecentSuites(EXECUTIVE_SUITES, corruptedStorage), []);
});
