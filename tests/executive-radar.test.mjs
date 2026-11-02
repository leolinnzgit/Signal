import test from "node:test";
import assert from "node:assert/strict";
import {
  scanExecutiveRadar,
  synthesizeRadarLocally,
} from "../app/executive-radar.ts";

test("synthesizeRadarLocally detects story velocity burst and market anomaly", () => {
  const articles = [
    {
      title: "Major Retail Banking Consolidation Announced",
      source: "RNZ News",
      url: "https://rnz.co.nz/story/bank-merge",
      publishedAt: new Date().toISOString(),
    },
    {
      title: "Regulatory Probe into Banking Merger Terms",
      source: "NZ Herald",
      url: "https://nzherald.co.nz/story/comcom-probe",
      publishedAt: new Date().toISOString(),
    },
  ];

  const markets = [
    { symbol: "NZ50", name: "NZX 50", price: 12450.5, changePercent: -1.8 },
  ];

  const result = synthesizeRadarLocally(articles, markets, 45);

  assert.equal(result.active, true);
  assert.ok(result.anomalyCount >= 2);

  const velAnomaly = result.anomalies.find((a) => a.anomalyType === "velocity_spike");
  assert.ok(velAnomaly);
  assert.equal(velAnomaly.severity, "High");
  assert.ok(velAnomaly.summary.includes("Coordinated multi-publisher"));

  const mktAnomaly = result.anomalies.find((a) => a.anomalyType === "market_divergence");
  assert.ok(mktAnomaly);
  assert.equal(mktAnomaly.relatedSymbol, "NZ50");
  assert.equal(mktAnomaly.severity, "Critical"); // since abs(changePercent) >= 1.5
});

test("scanExecutiveRadar calls server endpoint and returns anomaly payload", async () => {
  const mockArticles = [
    { title: "Grid Transition Plan Passed", source: "RNZ News", url: "https://rnz.co.nz/grid" },
  ];

  const mockFetcher = async (url, opts) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/radar/scan") {
      return {
        ok: true,
        json: async () => ({
          active: true,
          anomalies: [
            {
              id: "server-radar-1",
              topic: "Energy Grid Transition",
              anomalyType: "velocity_spike",
              severity: "High",
              velocityScore: 3.2,
              publisherCount: 4,
              timeWindowMinutes: 45,
              headline: "Grid Transition Plan Passed",
              summary: "4 publishers reported in 45m.",
              sources: ["RNZ News", "NZ Herald"],
              detectedAt: new Date().toISOString(),
            },
          ],
          scannedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await scanExecutiveRadar(mockArticles, [], 45, undefined, mockFetcher);

  assert.equal(res.active, true);
  assert.equal(res.anomalyCount, 1);
  assert.equal(res.anomalies[0].id, "server-radar-1");
  assert.equal(res.anomalies[0].topic, "Energy Grid Transition");
});

test("scanExecutiveRadar safely falls back to local synthesis when server fails", async () => {
  const mockArticles = [
    { title: "Story A", source: "Source 1", url: "https://example.com/1" },
    { title: "Story B", source: "Source 2", url: "https://example.com/2" },
  ];

  const failingFetcher = async () => ({ ok: false });

  const res = await scanExecutiveRadar(mockArticles, [], 45, undefined, failingFetcher);

  assert.equal(res.active, true);
  assert.ok(res.anomalyCount >= 1);
  assert.ok(res.anomalies[0].id.startsWith("local-radar-"));
});
