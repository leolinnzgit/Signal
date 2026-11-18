import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClientStockNewsGraph,
  buildStockNewsChartGeometry,
  enrichArticlesWithMarketQuotes,
  mergeStockNewsGraphData,
} from "../app/stock-news-graph.ts";

const nvdaQuote = {
  topic: "NVIDIA",
  symbol: "NVDA",
  name: "NVIDIA Corp",
  exchange: "NASDAQ",
  currency: "USD",
  price: 142.5,
  change: 3.5,
  percentChange: 2.52,
  quoteTime: "2026-11-17 16:00:00",
  isMarketOpen: true,
  provider: "Twelve Data",
  sparkline: [135.2, 138.0, 140.1, 142.5],
};

test("enrichArticlesWithMarketQuotes attaches live quotes and preserves existing recorded snapshots", () => {
  const existingSnapshot = {
    topic: "NVIDIA",
    symbol: "NVDA",
    name: "NVIDIA Corp",
    exchange: "NASDAQ",
    currency: "USD",
    price: 132.0,
    change: -1.4,
    percentChange: -1.05,
    quoteTime: "2026-11-10 16:00:00",
    isMarketOpen: false,
    recordedAtUtc: "2026-11-10T21:00:00Z",
  };

  const articles = [
    {
      title: "NVIDIA unveils next-gen Blackwell rack architecture",
      url: "https://example.com/nvda-new",
      source: "Reuters",
      publishedAt: "2026-11-17T12:00:00Z",
      topics: ["NVIDIA"],
    },
    {
      title: "Older NVIDIA supply update",
      url: "https://example.com/nvda-old",
      source: "Bloomberg",
      publishedAt: "2026-11-10T21:00:00Z",
      topics: ["NVIDIA"],
      marketQuotes: [existingSnapshot],
    },
    {
      title: "Local botanical garden opens spring greenhouse",
      url: "https://example.com/garden",
      source: "Local Herald",
      publishedAt: "2026-11-17T10:00:00Z",
      topics: ["Gardening"],
    },
  ];

  const enriched = enrichArticlesWithMarketQuotes(articles, [nvdaQuote], "2026-11-17T18:00:00Z");
  assert.equal(enriched[0].marketQuotes?.length, 1);
  assert.equal(enriched[0].marketQuotes?.[0].symbol, "NVDA");
  assert.equal(enriched[0].marketQuotes?.[0].price, 142.5);
  assert.equal(enriched[0].marketQuotes?.[0].recordedAtUtc, "2026-11-17T18:00:00Z");

  // Existing recorded snapshot must NOT be overwritten by the newer live quote.
  assert.equal(enriched[1].marketQuotes?.length, 1);
  assert.equal(enriched[1].marketQuotes?.[0].price, 132.0);
  assert.equal(enriched[1].marketQuotes?.[0].percentChange, -1.05);

  // Unrelated story receives no stock quote.
  assert.equal(enriched[2].marketQuotes, undefined);
});

test("buildClientStockNewsGraph and mergeStockNewsGraphData combine server history with live events", () => {
  const articles = [
    {
      title: "NVIDIA earnings preview",
      url: "https://example.com/nvda-1",
      source: "WSJ",
      publishedAt: "2026-11-14T15:00:00Z",
      topics: ["NVIDIA"],
      marketQuotes: [
        {
          topic: "NVIDIA",
          symbol: "NVDA",
          name: "NVIDIA Corp",
          exchange: "NASDAQ",
          currency: "USD",
          price: 136.4,
          change: 1.2,
          percentChange: 0.89,
          quoteTime: "2026-11-14 15:00:00",
          isMarketOpen: true,
          recordedAtUtc: "2026-11-14T15:05:00Z",
        },
      ],
    },
    {
      title: "NVIDIA raises guidance",
      url: "https://example.com/nvda-2",
      source: "CNBC",
      publishedAt: "2026-11-17T14:00:00Z",
      topics: ["NVIDIA"],
    },
  ];

  const clientGraph = buildClientStockNewsGraph(articles, [nvdaQuote], { symbol: "NVDA" });
  assert.equal(clientGraph.activeSymbol, "NVDA");
  assert.equal(clientGraph.events.length, 2);
  assert.equal(clientGraph.events[0].isRecordedSnapshot, true);
  assert.equal(clientGraph.events[0].price, 136.4);
  assert.equal(clientGraph.events[1].isRecordedSnapshot, false);
  assert.equal(clientGraph.events[1].price, 142.5);

  const serverData = {
    configured: true,
    activeSymbol: "NVDA",
    activeName: "NVIDIA Corp",
    activeExchange: "NASDAQ",
    activeCurrency: "USD",
    activeTopic: "NVIDIA",
    availableSeries: [
      {
        symbol: "NVDA",
        name: "NVIDIA Corp",
        exchange: "NASDAQ",
        currency: "USD",
        topic: "NVIDIA",
        articleCount: 2,
        latestPrice: 142.5,
        latestPercentChange: 2.52,
      },
    ],
    pricePoints: [
      { timestamp: "2026-11-13", price: 134.0, sourceType: "historical-close" },
      { timestamp: "2026-11-14T15:00:00Z", price: 136.4, sourceType: "news-snapshot" },
      { timestamp: "2026-11-16", price: 140.0, sourceType: "historical-close" },
    ],
    events: [
      {
        title: "NVIDIA earnings preview",
        url: "https://example.com/nvda-1",
        source: "WSJ",
        publishedAtUtc: "2026-11-14T15:00:00Z",
        recordedAtUtc: "2026-11-14T15:05:00Z",
        symbol: "NVDA",
        name: "NVIDIA Corp",
        exchange: "NASDAQ",
        currency: "USD",
        price: 136.4,
        change: 1.2,
        percentChange: 0.89,
        quoteTime: "2026-11-14 15:00:00",
        isMarketOpen: true,
        isRecordedSnapshot: true,
        topics: ["NVIDIA"],
      },
    ],
  };

  const merged = mergeStockNewsGraphData(serverData, clientGraph);
  assert.equal(merged.events.length, 2);
  assert.equal(merged.events[0].url, "https://example.com/nvda-1");
  assert.equal(merged.events[1].url, "https://example.com/nvda-2");
  assert.ok(merged.pricePoints.length >= 4);
});

test("buildStockNewsChartGeometry generates valid SVG curve and pins for combined, snapshots, and single-event modes", () => {
  const pricePoints = [
    { timestamp: "2026-11-12", price: 130, sourceType: "historical-close" },
    { timestamp: "2026-11-14T15:00:00Z", price: 136.4, sourceType: "news-snapshot" },
    { timestamp: "2026-11-17T14:00:00Z", price: 142.5, sourceType: "news-snapshot" },
  ];
  const events = [
    {
      title: "Story 1",
      url: "https://example.com/1",
      source: "Reuters",
      publishedAtUtc: "2026-11-14T15:00:00Z",
      recordedAtUtc: "2026-11-14T15:05:00Z",
      symbol: "NVDA",
      name: "NVIDIA Corp",
      exchange: "NASDAQ",
      currency: "USD",
      price: 136.4,
      change: 1.2,
      percentChange: 0.89,
      quoteTime: "2026-11-14",
      isMarketOpen: true,
      isRecordedSnapshot: true,
      topics: ["NVIDIA"],
    },
    {
      title: "Story 2",
      url: "https://example.com/2",
      source: "Bloomberg",
      publishedAtUtc: "2026-11-17T14:00:00Z",
      recordedAtUtc: "2026-11-17T14:05:00Z",
      symbol: "NVDA",
      name: "NVIDIA Corp",
      exchange: "NASDAQ",
      currency: "USD",
      price: 142.5,
      change: -2.1,
      percentChange: -1.45,
      quoteTime: "2026-11-17",
      isMarketOpen: false,
      isRecordedSnapshot: true,
      topics: ["NVIDIA"],
    },
  ];

  const combined = buildStockNewsChartGeometry(pricePoints, events, 760, 280, "combined");
  assert.ok(combined);
  assert.equal(combined.isUp, true);
  assert.ok(combined.linePath.startsWith("M "));
  assert.ok(combined.areaPath.endsWith(" Z"));
  assert.equal(combined.nodes.length, 2);
  assert.equal(combined.nodes[0].isPositive, true);
  assert.equal(combined.nodes[1].isPositive, false);
  assert.ok(combined.nodes[1].x > combined.nodes[0].x);
  assert.ok(combined.nodes[1].y < combined.nodes[0].y);

  const snapshots = buildStockNewsChartGeometry(pricePoints, events, 760, 280, "snapshots");
  assert.ok(snapshots);
  assert.equal(snapshots.curvePoints.length, 2);
  assert.equal(snapshots.nodes.length, 2);

  // Single-event snapshot renders without NaN or division by zero
  const single = buildStockNewsChartGeometry([], [events[0]], 760, 280, "snapshots");
  assert.ok(single);
  assert.equal(single.nodes.length, 1);
  assert.ok(Number.isFinite(single.nodes[0].x));
  assert.ok(Number.isFinite(single.nodes[0].y));
  assert.ok(!single.linePath.includes("NaN"));
});

test("enrichArticlesWithMarketQuotes does not stamp live price onto stale articles without explicit timestamp", () => {
  const stale = {
    title: "NVIDIA older report",
    url: "https://example.com/nvda-stale",
    source: "Reuters",
    publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    topics: ["NVIDIA"],
  };
  const fresh = {
    title: "NVIDIA breaking report",
    url: "https://example.com/nvda-fresh",
    source: "Reuters",
    publishedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    topics: ["NVIDIA"],
  };
  const enriched = enrichArticlesWithMarketQuotes([stale, fresh], [nvdaQuote]);
  assert.equal(enriched[0].marketQuotes, undefined);
  assert.equal(enriched[1].marketQuotes?.length, 1);
});

test("buildStockNewsChartGeometry caps dense catalyst pins to 32 while keeping selectedEventUrl", () => {
  const manyEvents = Array.from({ length: 60 }, (_, idx) => ({
    title: `Story ${idx}`,
    url: `https://example.com/s-${idx}`,
    source: "Wire",
    publishedAtUtc: new Date(Date.UTC(2026, 10, 1 + Math.floor(idx / 3), idx % 24, 0, 0)).toISOString(),
    recordedAtUtc: new Date(Date.UTC(2026, 10, 1 + Math.floor(idx / 3), idx % 24, 0, 0)).toISOString(),
    symbol: "NVDA",
    name: "NVIDIA Corp",
    exchange: "NASDAQ",
    currency: "USD",
    price: 150 + idx * 0.25,
    change: 0.5,
    percentChange: idx === 17 ? 0 : 0.3,
    quoteTime: "2026-11-10",
    isMarketOpen: true,
    isRecordedSnapshot: true,
    topics: ["NVIDIA"],
  }));

  const geom = buildStockNewsChartGeometry([], manyEvents, 760, 280, "combined", "https://example.com/s-17");
  assert.ok(geom);
  assert.equal(geom.nodes.length, 32);
  assert.ok(geom.nodes.some((n) => n.event.url === "https://example.com/s-17"));
});

test("extended-hours pricing propagates through article enrichment and stock-news graph", () => {
  const extendedQuote = {
    ...nvdaQuote,
    isMarketOpen: false,
    extendedPrice: 149.8,
    extendedChange: 7.3,
    extendedPercentChange: 5.12,
    extendedQuoteTime: "2026-11-17 19:59 ET",
    extendedSession: "after-hours",
  };

  const enriched = enrichArticlesWithMarketQuotes(
    [
      {
        title: "NVIDIA surges after hours on guidance",
        url: "https://example.com/nvda-ah",
        source: "Reuters",
        publishedAt: "2026-11-18T00:50:00Z",
        topics: ["NVIDIA"],
      },
    ],
    [extendedQuote],
    "2026-11-18T00:55:00Z",
  );

  assert.equal(enriched[0].marketQuotes?.[0].extendedPrice, 149.8);
  assert.equal(enriched[0].marketQuotes?.[0].extendedSession, "after-hours");

  const graph = buildClientStockNewsGraph(enriched, [extendedQuote], { symbol: "NVDA" });
  assert.equal(graph.availableSeries[0].extendedPrice, 149.8);
  assert.equal(graph.availableSeries[0].extendedPercentChange, 5.12);
  assert.equal(graph.events[0].extendedPrice, 149.8);
});
