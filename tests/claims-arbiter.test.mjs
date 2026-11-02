import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchClaimsArbiter,
  synthesizeClaimsArbiterLocally,
  formatClaimsArbiterClipboard,
} from "../app/claims-arbiter.ts";

test("synthesizeClaimsArbiterLocally generates claims consensus matrix", () => {
  const arbiter = synthesizeClaimsArbiterLocally("Interest Rate Forecast Divergence");

  assert.equal(arbiter.available, true);
  assert.equal(arbiter.topic, "Interest Rate Forecast Divergence");
  assert.equal(arbiter.reconciliationStatus, "Conflicting Numbers Detected");
  assert.ok(arbiter.claims.length >= 1);
  assert.ok(arbiter.claims[0].outletsReporting.length >= 2);
  assert.ok(arbiter.establishedFacts.length >= 2);
  assert.ok(arbiter.unverifiedRumors.length >= 1);
  assert.ok(arbiter.spokenArbitrationScript.includes("Interest Rate Forecast Divergence"));
});

test("fetchClaimsArbiter calls server arbitration endpoint and returns parsed claims", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/claims-arbiter/arbitrate") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          topic: "Dairy Export Revenue Projections",
          reconciliationStatus: "Consensus Established",
          claims: [
            {
              subject: "Export Value",
              divergenceType: "Financial Figures",
              outletsReporting: [
                { publisher: "Ministry for Primary Industries", claimedValueOrQuote: "NZ$25.1B", sourceUrl: "https://mpi.govt.nz", credibilityRating: "Primary Official" },
              ],
              consensusConclusion: "MPI projection verified at NZ$25.1B.",
              confidenceScore: 95,
            },
          ],
          establishedFacts: ["MPI SOPI report confirms $25.1B baseline."],
          unverifiedRumors: ["Social media claims of sub-$20B downturn are unfounded."],
          spokenArbitrationScript: "Dairy export claims brief.",
          generatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await fetchClaimsArbiter("Dairy Export Revenue Projections", [], undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.topic, "Dairy Export Revenue Projections");
  assert.equal(res.reconciliationStatus, "Consensus Established");
  assert.equal(res.claims[0].confidenceScore, 95);
});

test("formatClaimsArbiterClipboard formats executive truth memo", () => {
  const arbiter = synthesizeClaimsArbiterLocally("Macro Inflation Prints");
  const text = formatClaimsArbiterClipboard(arbiter);

  assert.ok(text.includes("MULTI-SOURCE CLAIMS ARBITER & FACT VERIFIER"));
  assert.ok(text.includes("ESTABLISHED PRIMARY FACTS:"));
  assert.ok(text.includes("UNVERIFIED RUMORS / MARKET CHATTER:"));
  assert.ok(text.includes("RECONCILED CLAIM COMPARISONS:"));
  assert.ok(text.includes("EXECUTIVE VERDICT AUDIO SCRIPT:"));
});
