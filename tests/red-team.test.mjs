import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRedTeamAnalysis,
  synthesizeRedTeamLocally,
} from "../app/red-team.ts";

test("synthesizeRedTeamLocally produces contrarian thesis and vulnerability critique", () => {
  const articles = [
    {
      title: "Commercial Fusion Reactor Pilot Approved for Construction",
      source: "RNZ News",
      url: "https://rnz.co.nz/fusion",
      summary: "Consortium secures environmental fast-track consents for pilot plant.",
    },
  ];

  const analysis = synthesizeRedTeamLocally("Commercial Fusion Pilot", articles);

  assert.equal(analysis.available, true);
  assert.equal(analysis.topic, "Commercial Fusion Pilot");
  assert.ok(analysis.consensusThesis.includes("Consortium secures"));
  assert.ok(analysis.contrarianCounterThesis.includes("discounts structural execution bottlenecks"));
  assert.ok(analysis.blindSpots.length >= 3);
  assert.equal(analysis.blindSpots[0].vulnerability, "Regulatory Compliance & Audit Friction");
  assert.equal(analysis.blindSpots[1].vulnerability, "Capital Reallocation & Cost of Carry");
  assert.ok(analysis.downsideProbability.includes("Elevated"));
  assert.ok(analysis.recommendedAction.length > 0);
});

test("fetchRedTeamAnalysis calls server endpoint and parses red team payload", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/story-cluster/redteam") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          topic: "Cross-Strait Ferry Fleet Replacement",
          consensusThesis: "New ferries will modernize supply line and expand freight capacity by 40%.",
          contrarianCounterThesis: "Delays in berth infrastructure upgrades create stranded asset risks.",
          blindSpots: [
            { vulnerability: "Harbour Infrastructure Readiness", severity: "High", critique: "Berths unready." },
          ],
          downsideProbability: "High (60%–70%)",
          keyInflectionTriggers: ["May 2027 dry-dock handover", "Cabinet funding review"],
          recommendedAction: "Audit port engineering timeline before contract lock-in.",
        }),
      };
    }
    return { ok: false };
  };

  const result = await fetchRedTeamAnalysis("Cross-Strait Ferry Fleet", [], undefined, undefined, mockFetcher);

  assert.equal(result.available, true);
  assert.equal(result.topic, "Cross-Strait Ferry Fleet Replacement");
  assert.ok(result.contrarianCounterThesis.includes("stranded asset risks"));
  assert.equal(result.blindSpots.length, 1);
  assert.equal(result.blindSpots[0].vulnerability, "Harbour Infrastructure Readiness");
  assert.equal(result.keyInflectionTriggers.length, 2);
});

test("fetchRedTeamAnalysis gracefully falls back locally when server fails", async () => {
  const failingFetcher = async () => ({ ok: false });

  const result = await fetchRedTeamAnalysis("Offshore Wind Consents", [], undefined, undefined, failingFetcher);

  assert.equal(result.available, true);
  assert.equal(result.topic, "Offshore Wind Consents");
  assert.ok(result.contrarianCounterThesis.includes("discounts structural execution"));
});
