import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchCompetitorRadar,
  synthesizeCompetitorRadarLocally,
  formatCompetitorRadarClipboard,
} from "../app/competitor-radar.ts";

test("synthesizeCompetitorRadarLocally produces structured peer intelligence", () => {
  const radar = synthesizeCompetitorRadarLocally("Dairy & Agri-Export");

  assert.equal(radar.available, true);
  assert.equal(radar.peerGroup, "Dairy & Agri-Export");
  assert.ok(radar.marketConcentrationHHI > 1000);
  assert.ok(radar.deals.length >= 2);
  assert.equal(radar.deals[0].regulatoryWatchdog, "Commerce Commission & OIO");
  assert.ok(radar.peerMovements.length >= 2);
  assert.ok(radar.spokenAudioScript.includes("Dairy & Agri-Export"));
});

test("fetchCompetitorRadar calls server endpoint and returns response", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/competitor-radar/analyze") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          peerGroup: "Telecom & Tech",
          marketConcentrationHHI: 2650,
          concentrationLabel: "Highly Concentrated",
          deals: [
            {
              dealName: "Fiber Carve-out",
              acquirer: "Investor Group",
              target: "Wholesale Fiber",
              estimatedValue: "NZ$1.2B",
              status: "Due Diligence",
              regulatoryWatchdog: "Commerce Commission",
              antitrustRiskLevel: "Moderate",
              strategicRationale: "Capital recycling",
              sources: ["RNZ"],
            },
          ],
          peerMovements: [
            {
              competitor: "2degrees",
              strategicPillar: "CapEx Expansion",
              headline: "Accelerates regional 5G",
              impactSeverity: "High",
              date: "Today",
              source: "Wire",
            },
          ],
          spokenAudioScript: "Telecom competitor radar brief.",
          generatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await fetchCompetitorRadar("Telecom & Tech", undefined, [], 30, undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.peerGroup, "Telecom & Tech");
  assert.equal(res.marketConcentrationHHI, 2650);
  assert.equal(res.deals.length, 1);
  assert.equal(res.deals[0].dealName, "Fiber Carve-out");
});

test("formatCompetitorRadarClipboard formats executive deal sheet", () => {
  const radar = synthesizeCompetitorRadarLocally("Energy & Renewables");
  const text = formatCompetitorRadarClipboard(radar);

  assert.ok(text.includes("COMPETITIVE INTELLIGENCE RADAR: ENERGY & RENEWABLES"));
  assert.ok(text.includes("M&A DEAL FLOW & REGULATORY CLEARANCE PIPELINE:"));
  assert.ok(text.includes("PEER MOVEMENTS & STRATEGIC PILLARS:"));
  assert.ok(text.includes("EXECUTIVE BRIEF:"));
});
