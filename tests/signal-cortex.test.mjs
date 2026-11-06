import test from "node:test";
import assert from "node:assert/strict";
import { getDomainBadgeClass, formatCortexDigest } from "../app/signal-cortex.ts";

test("getDomainBadgeClass maps intelligence domains to badges correctly", () => {
  const straits = getDomainBadgeClass("Chokepoints & Straits");
  assert.equal(straits.label, "🌊 STRAITS");
  assert.equal(straits.badgeClass, "domain-chokepoint");

  const tariffs = getDomainBadgeClass("Tariff & Arbitrage");
  assert.equal(tariffs.label, "📊 TARIFFS");
  assert.equal(tariffs.badgeClass, "domain-tariff");

  const cyber = getDomainBadgeClass("Cyber Incident");
  assert.equal(cyber.label, "⚡ CYBER");
  assert.equal(cyber.badgeClass, "domain-cyber");

  const news = getDomainBadgeClass("News Stream");
  assert.equal(news.label, "🗞️ WIRE");
  assert.equal(news.badgeClass, "domain-news");
});

test("formatCortexDigest compiles structured intelligence synthesis", () => {
  const mockResponse = {
    query: "TSMC packaging tariffs",
    synthesizedAnswer: "Signal Cortex synthesized 2 strategic matches for TSMC packaging tariffs.",
    confidence: 0.94,
    crossDomainHits: [
      {
        id: "hit-1",
        title: "Advanced Microelectronics Tariff Matrix",
        domain: "Tariff & Arbitrage",
        snippet: "Blended effective tariff: 18.5%. Nearshore assembly in Monterrey.",
        relevanceScore: 0.96,
        targetSuiteId: "tariff-matrix",
      },
    ],
    suggestedQueries: ["Detailed breakdown of TSMC"],
    executedAt: new Date().toISOString(),
  };

  const memo = formatCortexDigest("TSMC packaging tariffs", mockResponse);
  assert.ok(memo.includes("SIGNAL CORTEX INTELLIGENCE SYNTHESIS"));
  assert.ok(memo.includes('Query: "TSMC packaging tariffs"'));
  assert.ok(memo.includes("Confidence Score: 94%"));
  assert.ok(memo.includes("Advanced Microelectronics Tariff Matrix"));
  assert.ok(memo.includes("Target Suite: tariff-matrix"));
});
