import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TRIPWIRE_PRESETS,
  buildTripwireDeepLink,
  deleteTripwireRule,
  evaluateTripwires,
  evaluateTripwiresLocally,
  fetchTripwiresState,
  formatTripwiresDigest,
  saveTripwireRule,
} from "../app/executive-tripwires.ts";

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

test("buildTripwireDeepLink constructs suite and optional focus query parameters", () => {
  assert.equal(buildTripwireDeepLink("sovereign-risk", "egypt"), "/?suite=sovereign-risk&focus=egypt");
  assert.equal(buildTripwireDeepLink("radar"), "/?suite=radar");
});

test("evaluateTripwiresLocally honors word boundaries and extracts matching keywords", () => {
  const hits = evaluateTripwiresLocally(
    [
      {
        title: "Egypt central bank faces Suez transit squeeze",
        url: "https://example.com/egypt",
        source: "Reuters",
      },
      {
        title: "Sailing competition enters final lap",
        url: "https://example.com/sail",
        source: "Sports",
      },
    ],
    [
      {
        ...DEFAULT_TRIPWIRE_PRESETS[0],
        id: "tw-ai-check",
        name: "AI Guard",
        keywords: ["ai"],
        targetSuiteId: "pre-mortem",
      },
      {
        ...DEFAULT_TRIPWIRE_PRESETS[1],
        id: "tw-eg",
        name: "Egypt Sovereign Monitor",
        keywords: ["egypt", "suez"],
        targetSuiteId: "sovereign-risk",
        targetEntityId: "egypt",
      },
    ],
  );

  assert.equal(hits.length, 1);
  assert.equal(hits[0].tripwireId, "tw-eg");
  assert.equal(hits[0].deepLinkUrl, "/?suite=sovereign-risk&focus=egypt");
  assert.deepEqual(hits[0].matchedKeywords, ["egypt", "suez"]);
});

test("guest localStorage CRUD persists and removes tripwires cleanly", async () => {
  const storage = createMemoryStorage();
  const fakeUnauthFetch = async () =>
    new Response(
      JSON.stringify({ authenticated: false, tripwires: [], presets: DEFAULT_TRIPWIRE_PRESETS }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  const saved = await saveTripwireRule(
    {
      name: "Section 301 Watch",
      keywords: ["section 301", "tariff"],
      targetSuiteId: "tariff-matrix",
      targetEntityId: "semiconductors",
      severity: "Critical",
    },
    false,
    fakeUnauthFetch,
    storage,
  );
  assert.equal(saved.deepLinkUrl, "/?suite=tariff-matrix&focus=semiconductors");

  const loaded = await fetchTripwiresState(fakeUnauthFetch, storage);
  assert.equal(loaded.authenticated, false);
  assert.equal(loaded.tripwires.length, 1);
  assert.equal(loaded.tripwires[0].name, "Section 301 Watch");

  await deleteTripwireRule(saved.id, false, fakeUnauthFetch, storage);
  const afterDelete = await fetchTripwiresState(fakeUnauthFetch, storage);
  assert.equal(afterDelete.tripwires.length, 0);
});

test("evaluateTripwires uses server API response and falls back cleanly on error", async () => {
  const failingFetch = async () => {
    throw new Error("Network offline");
  };
  const evalRes = await evaluateTripwires(
    [{ title: "Red Sea vessels reroute around Cape of Good Hope", url: "https://example.com/1", source: "FT" }],
    DEFAULT_TRIPWIRE_PRESETS,
    failingFetch,
  );
  assert.equal(evalRes.matches.length, 1);
  assert.equal(evalRes.matches[0].targetSuiteId, "geopolitical-transit");

  const digest = formatTripwiresDigest(DEFAULT_TRIPWIRE_PRESETS, evalRes.matches);
  assert.ok(digest.includes("Red Sea & Hormuz Transit Disruption"));
});
