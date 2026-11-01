import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateMarketAlerts,
  loadMarketPortfolio,
  saveMarketPortfolio,
} from "../app/market-quote.ts";

test("evaluateMarketAlerts detects threshold breach for crypto pairs and equities", () => {
  const items = [
    { symbol: "BTC/USD", displayName: "Bitcoin", alertThresholdPercent: 3.0, alertEnabled: true },
    { symbol: "ETH/USD", displayName: "Ethereum", alertThresholdPercent: 5.0, alertEnabled: true },
    { symbol: "NVDA", displayName: "Nvidia", alertThresholdPercent: 2.0, alertEnabled: true },
    { symbol: "AAPL", displayName: "Apple", alertThresholdPercent: 2.5, alertEnabled: false },
  ];

  const quotes = [
    {
      topic: "Bitcoin",
      symbol: "BTC/USD",
      name: "Bitcoin / US Dollar",
      exchange: "Crypto",
      currency: "USD",
      price: 68500,
      change: 2800,
      percentChange: 4.26, // 4.26% >= 3.0% -> TRIGGERED UP
      quoteTime: "2026-11-01 22:00:00",
      isMarketOpen: true,
      provider: "Twelve Data",
    },
    {
      topic: "Ethereum",
      symbol: "ETH/USD",
      name: "Ethereum / US Dollar",
      exchange: "Crypto",
      currency: "USD",
      price: 2500,
      change: 45,
      percentChange: 1.83, // 1.83% < 5.0% -> NOT TRIGGERED
      quoteTime: "2026-11-01 22:00:00",
      isMarketOpen: true,
      provider: "Twelve Data",
    },
    {
      topic: "Nvidia",
      symbol: "NVDA",
      name: "NVIDIA Corp",
      exchange: "NASDAQ",
      currency: "USD",
      price: 138.5,
      change: -3.8,
      percentChange: -2.67, // |-2.67%| >= 2.0% -> TRIGGERED DOWN
      quoteTime: "2026-11-01 22:00:00",
      isMarketOpen: false,
      provider: "Twelve Data",
    },
    {
      topic: "Apple",
      symbol: "AAPL",
      name: "Apple Inc",
      exchange: "NASDAQ",
      currency: "USD",
      price: 230,
      change: 10,
      percentChange: 4.54, // Alert disabled -> NOT TRIGGERED
      quoteTime: "2026-11-01 22:00:00",
      isMarketOpen: false,
      provider: "Twelve Data",
    },
  ];

  const results = evaluateMarketAlerts(items, quotes);
  assert.equal(results.length, 4);

  // BTC/USD: triggered up
  assert.equal(results[0].symbol, "BTC/USD");
  assert.equal(results[0].isAlertTriggered, true);
  assert.equal(results[0].alertDirection, "up");

  // ETH/USD: not triggered
  assert.equal(results[1].symbol, "ETH/USD");
  assert.equal(results[1].isAlertTriggered, false);

  // NVDA: triggered down
  assert.equal(results[2].symbol, "NVDA");
  assert.equal(results[2].isAlertTriggered, true);
  assert.equal(results[2].alertDirection, "down");

  // AAPL: disabled -> not triggered
  assert.equal(results[3].symbol, "AAPL");
  assert.equal(results[3].isAlertTriggered, false);
});

test("loadMarketPortfolio and saveMarketPortfolio round-trip with CSRF verification", async () => {
  let savedBody = null;
  const mockFetcher = async (url, opts) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "portfolio-test-token" }) };
    }
    if (url === "/api/market/portfolio" && opts?.method === "POST") {
      assert.equal(opts.headers["X-XSRF-TOKEN"], "portfolio-test-token");
      savedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          configured: true,
          items: savedBody.map((item) => ({
            ...item,
            isAlertTriggered: false,
            alertDirection: null,
            quote: null,
          })),
          hasAlerts: false,
        }),
      };
    }
    if (url === "/api/market/portfolio") {
      return {
        ok: true,
        json: async () => ({
          configured: true,
          items: [
            {
              symbol: "SOL/USD",
              displayName: "Solana",
              alertThresholdPercent: 4.0,
              alertEnabled: true,
              isAlertTriggered: true,
              alertDirection: "up",
            },
          ],
          hasAlerts: true,
        }),
      };
    }
    return { ok: false };
  };

  const loaded = await loadMarketPortfolio(undefined, mockFetcher);
  assert.equal(loaded.configured, true);
  assert.equal(loaded.items.length, 1);
  assert.equal(loaded.items[0].symbol, "SOL/USD");
  assert.equal(loaded.hasAlerts, true);

  const saved = await saveMarketPortfolio(
    [{ symbol: "BTC/USD", displayName: "Bitcoin", alertThresholdPercent: 3.0, alertEnabled: true }],
    undefined,
    mockFetcher,
  );
  assert.equal(saved.configured, true);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].symbol, "BTC/USD");
});
