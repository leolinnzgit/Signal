import test from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_WATCH_CURRENCIES,
  PRODUCT_WATCH_FREQUENCIES,
  PRODUCT_WATCH_MODEL,
  PRODUCT_WATCH_PRESETS,
  checkProductWatchPriceNow,
  computeNextCheckIso,
  deleteProductWatchItem,
  fetchProductWatchState,
  formatProductPrice,
  formatProductWatchMarkdown,
  getFrequencyLabel,
  loadLocalProductWatches,
  normalizeWatchCurrency,
  normalizeWatchFrequency,
  priceVerdictBadgeMeta,
  saveProductWatchItem,
} from "../app/product-watch.ts";

test("PRODUCT_WATCH_FREQUENCIES defines daily, weekly, monthly, and sub-daily schedules", () => {
  const ids = PRODUCT_WATCH_FREQUENCIES.map((f) => f.id);
  assert.deepEqual(ids, ["6h", "12h", "daily", "weekly", "fortnightly", "monthly", "manual"]);
  assert.equal(PRODUCT_WATCH_MODEL, "gpt-6.1-sol");
  assert.ok(PRODUCT_WATCH_CURRENCIES.includes("NZD"));
  assert.ok(PRODUCT_WATCH_PRESETS.length >= 4);
});

test("normalizeWatchFrequency and computeNextCheckIso handle daily, weekly, monthly, and manual schedules", () => {
  assert.equal(normalizeWatchFrequency("DAILY"), "daily");
  assert.equal(normalizeWatchFrequency("weekly"), "weekly");
  assert.equal(normalizeWatchFrequency("biweekly"), "fortnightly");
  assert.equal(normalizeWatchFrequency("monthly"), "monthly");
  assert.equal(normalizeWatchFrequency("6h"), "6h");
  assert.equal(normalizeWatchFrequency("12h"), "12h");
  assert.equal(normalizeWatchFrequency("manual"), "manual");
  assert.equal(normalizeWatchFrequency("unknown-value"), "daily");

  assert.equal(getFrequencyLabel("weekly"), "Weekly");
  assert.equal(getFrequencyLabel("monthly"), "Monthly");

  const base = new Date("2026-11-17T00:00:00.000Z");
  assert.equal(computeNextCheckIso("daily", base), "2026-11-18T00:00:00.000Z");
  assert.equal(computeNextCheckIso("weekly", base), "2026-11-24T00:00:00.000Z");
  assert.equal(computeNextCheckIso("monthly", base), "2026-12-17T00:00:00.000Z");
  assert.equal(computeNextCheckIso("manual", base), null);
});

test("formatProductPrice and priceVerdictBadgeMeta format currencies and verdicts cleanly", () => {
  assert.equal(formatProductPrice(499, "NZD"), "NZD $499.00");
  assert.equal(formatProductPrice(1599.5, "usd"), "USD $1,599.50");
  assert.equal(formatProductPrice(null, "NZD"), "Not checked yet");
  assert.equal(normalizeWatchCurrency("aud"), "AUD");
  assert.equal(normalizeWatchCurrency("invalid"), "NZD");

  assert.equal(priceVerdictBadgeMeta("great-deal").toneClass, "verdict-great");
  assert.equal(priceVerdictBadgeMeta("good-price").toneClass, "verdict-good");
  assert.equal(priceVerdictBadgeMeta("fair-price").toneClass, "verdict-fair");
  assert.equal(priceVerdictBadgeMeta("wait").toneClass, "verdict-wait");
});

test("saveProductWatchItem, checkProductWatchPriceNow, and deleteProductWatchItem integrate with CSRF API and guest storage", async () => {
  const storageMap = new Map();
  const mockStorage = {
    getItem: (k) => storageMap.get(k) ?? null,
    setItem: (k, v) => storageMap.set(k, v),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
    key: () => null,
    length: 0,
  };

  // 1. Guest mode persistence
  const guestSaved = await saveProductWatchItem(
    {
      modelOrSku: "WH-1000XM5",
      productName: "Sony WH-1000XM5",
      frequency: "weekly",
      currency: "NZD",
      targetPrice: 450,
    },
    false,
    undefined,
    mockStorage,
  );
  assert.equal(guestSaved.modelOrSku, "WH-1000XM5");
  assert.equal(guestSaved.frequency, "weekly");
  assert.equal(guestSaved.frequencyLabel, "Weekly");
  assert.equal(loadLocalProductWatches(mockStorage).length, 1);

  await deleteProductWatchItem(guestSaved.id, false, undefined, mockStorage);
  assert.equal(loadLocalProductWatches(mockStorage).length, 0);

  // 2. Authenticated API mode with CSRF token and gpt-6.1-sol price check
  const calls = [];
  const mockFetch = async (input, init = {}) => {
    calls.push({ input, init });
    if (input === "/api/auth/csrf") {
      return new Response(JSON.stringify({ token: "csrf-pw-123" }), { status: 200 });
    }
    if (input === "/api/product-watch" && (!init.method || init.method === "GET")) {
      return new Response(
        JSON.stringify({
          authenticated: true,
          aiAvailable: true,
          model: "gpt-6.1-sol",
          frequencies: PRODUCT_WATCH_FREQUENCIES,
          currencies: PRODUCT_WATCH_CURRENCIES,
          items: [],
        }),
        { status: 200 },
      );
    }
    if (input === "/api/product-watch" && init.method === "POST") {
      assert.equal(init.headers["X-XSRF-TOKEN"], "csrf-pw-123");
      const body = JSON.parse(init.body);
      assert.equal(body.modelOrSku, "OLED65C4PSA");
      assert.equal(body.frequency, "monthly");
      return new Response(
        JSON.stringify({
          id: "pw-server-1",
          productName: body.productName,
          modelOrSku: body.modelOrSku,
          frequency: "monthly",
          frequencyLabel: "Monthly",
          currency: "NZD",
          targetPrice: 2999,
          enabled: true,
          notifyOnPriceDrop: true,
          bestPrice: null,
          regularPrice: null,
          lowestPriceEver: null,
          previousBestPrice: null,
          savingsAmount: null,
          savingsPercent: null,
          isTargetMet: false,
          isPriceDrop: false,
          bestRetailer: "",
          bestOfferUrl: "",
          priceVerdict: "",
          summary: "",
          buyingTip: "",
          offers: [],
          priceHistory: [],
          modelUsed: "gpt-6.1-sol",
          checkCount: 0,
          lastCheckedAtUtc: null,
          nextCheckAtUtc: "2026-12-17T00:00:00Z",
          lastError: "",
          createdAtUtc: "2026-11-17T00:00:00Z",
          updatedAtUtc: "2026-11-17T00:00:00Z",
        }),
        { status: 200 },
      );
    }
    if (input === "/api/product-watch/pw-server-1/check" && init.method === "POST") {
      assert.equal(init.headers["X-XSRF-TOKEN"], "csrf-pw-123");
      return new Response(
        JSON.stringify({
          id: "pw-server-1",
          productName: "LG C4 65\" 4K OLED Evo TV",
          modelOrSku: "OLED65C4PSA",
          frequency: "monthly",
          frequencyLabel: "Monthly",
          currency: "NZD",
          targetPrice: 2999,
          enabled: true,
          notifyOnPriceDrop: true,
          bestPrice: 2888,
          regularPrice: 3699,
          lowestPriceEver: 2888,
          previousBestPrice: null,
          savingsAmount: 811,
          savingsPercent: 21.9,
          isTargetMet: true,
          isPriceDrop: false,
          bestRetailer: "PB Tech",
          bestOfferUrl: "https://example.com/lg-c4",
          priceVerdict: "great-deal",
          summary: "PB Tech has the lowest current NZD price at $2,888.",
          buyingTip: "Ask Noel Leeming or JB Hi-Fi for a price match.",
          offers: [
            {
              retailer: "PB Tech",
              price: 2888,
              currency: "NZD",
              availability: "Deal",
              note: "Promotional sale price",
              url: "https://example.com/lg-c4",
            },
          ],
          priceHistory: [
            {
              checkedAtUtc: "2026-11-17T00:01:00Z",
              bestPrice: 2888,
              retailer: "PB Tech",
              currency: "NZD",
            },
          ],
          modelUsed: "gpt-6.1-sol-2026-09-29",
          checkCount: 1,
          lastCheckedAtUtc: "2026-11-17T00:01:00Z",
          nextCheckAtUtc: "2026-12-17T00:01:00Z",
          lastError: "",
          createdAtUtc: "2026-11-17T00:00:00Z",
          updatedAtUtc: "2026-11-17T00:01:00Z",
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected request: ${input}`);
  };

  const state = await fetchProductWatchState(mockFetch, mockStorage);
  assert.equal(state.authenticated, true);
  assert.equal(state.model, "gpt-6.1-sol");

  const created = await saveProductWatchItem(
    {
      modelOrSku: "OLED65C4PSA",
      productName: "LG C4 65\" OLED",
      frequency: "monthly",
      currency: "NZD",
      targetPrice: 2999,
    },
    true,
    mockFetch,
    mockStorage,
  );
  assert.equal(created.id, "pw-server-1");
  assert.equal(created.frequency, "monthly");

  const checked = await checkProductWatchPriceNow(created.id, true, mockFetch);
  assert.equal(checked.bestPrice, 2888);
  assert.equal(checked.bestRetailer, "PB Tech");
  assert.equal(checked.isTargetMet, true);
  assert.equal(checked.modelUsed, "gpt-6.1-sol-2026-09-29");

  const md = formatProductWatchMarkdown([checked]);
  assert.match(md, /# Signal Product Watch — Best Price Report/);
  assert.match(md, /OLED65C4PSA/);
  assert.match(md, /NZD \$2,888\.00 at \*\*PB Tech\*\*/);
});
