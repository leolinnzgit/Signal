import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchMarketSentimentMatrix,
  synthesizeMarketSentimentLocally,
  fetchWatchMarketGlance,
} from "../app/market-sentiment.ts";

test("synthesizeMarketSentimentLocally returns categorized benchmark assets and headlines", () => {
  const headlines = [
    "Reserve Bank holds OCR at 4.25% amid balanced inflation trajectory",
    "Auckland Airport international passenger numbers surge past pre-pandemic levels",
  ];

  const matrix = synthesizeMarketSentimentLocally(
    [{ topic: "NZ Equities", symbol: "NZ50" }],
    headlines,
  );

  assert.equal(matrix.configured, true);
  assert.ok(Array.isArray(matrix.assets));
  assert.ok(matrix.assets.length >= 6);

  const nz50 = matrix.assets.find((a) => a.symbol === "NZ50");
  assert.ok(nz50, "NZ50 asset must be present");
  assert.equal(nz50.sector, "NZ Equities");
  assert.equal(nz50.sentimentTone, "bullish");
  assert.equal(nz50.attributions[0].title, headlines[0]);

  const sectors = new Set(matrix.assets.map((a) => a.sector));
  assert.ok(sectors.has("NZ Equities"));
  assert.ok(sectors.has("Global Tech"));
  assert.ok(sectors.has("Commodities"));
  assert.ok(sectors.has("FX & Rates"));
});

test("fetchMarketSentimentMatrix uses fetcher and returns server response", async () => {
  const mockFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return {
        ok: true,
        json: async () => ({ token: "fake-csrf-token" }),
      };
    }

    assert.equal(url, "/api/market/matrix");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-XSRF-TOKEN"], "fake-csrf-token");
    const body = JSON.parse(init.body);
    assert.equal(body.headlines[0], "Tech rally lifts global indices");

    return {
      ok: true,
      json: async () => ({
        configured: true,
        macroHeadline: "Risk-on sentiment lifts NZX and tech valuations",
        assets: [
          {
            symbol: "NZ50",
            name: "NZX 50 Gross Index",
            sector: "NZ Equities",
            price: 12500,
            changePercent: 1.2,
            sentimentTone: "bullish",
            attributions: [
              {
                title: "Tech rally lifts global indices",
                url: "https://example.com/story",
                source: "RNZ",
                impactType: "bullish",
              },
            ],
          },
        ],
      }),
    };
  };

  const res = await fetchMarketSentimentMatrix(
    [{ topic: "NZX 50", symbol: "NZ50" }],
    ["Tech rally lifts global indices"],
    undefined,
    undefined,
    mockFetcher,
  );

  assert.equal(res.configured, true);
  assert.equal(res.macroHeadline, "Risk-on sentiment lifts NZX and tech valuations");
  assert.equal(res.assets.length, 1);
  assert.equal(res.assets[0].symbol, "NZ50");
  assert.equal(res.assets[0].attributions[0].source, "RNZ");
});

test("fetchMarketSentimentMatrix falls back to synthesized assets if endpoint fails", async () => {
  const failingFetcher = async () => {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: "Server error" }),
    };
  };

  const res = await fetchMarketSentimentMatrix(
    [],
    ["Fallback headline test"],
    undefined,
    undefined,
    failingFetcher,
  );

  assert.equal(res.configured, true);
  assert.ok(res.assets.length > 0);
  assert.equal(res.assets[0].attributions[0].title, "Fallback headline test");
});

test("fetchWatchMarketGlance fetches watch market snapshot from endpoint", async () => {
  const mockFetcher = async (url) => {
    assert.equal(url, "/api/watch/market");
    return {
      ok: true,
      json: async () => ({
        configured: true,
        macroHeadline: "Risk-on sentiment lifts NZX and global indices.",
        assets: [
          { symbol: "NZ50", name: "NZX 50", price: 12500, changePercent: 1.1, sentimentTone: "bullish" },
        ],
        updatedAt: "2026-11-02T12:00:00Z",
      }),
    };
  };

  const res = await fetchWatchMarketGlance(undefined, mockFetcher);
  assert.equal(res.configured, true);
  assert.equal(res.macroHeadline, "Risk-on sentiment lifts NZX and global indices.");
  assert.equal(res.assets.length, 1);
  assert.equal(res.assets[0].symbol, "NZ50");
});
