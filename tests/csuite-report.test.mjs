import test from "node:test";
import assert from "node:assert/strict";
import {
  compileCSuiteReportData,
  formatCSuiteSummaryText,
} from "../app/csuite-report.ts";

test("compileCSuiteReportData builds comprehensive C-Suite report", () => {
  const briefing = {
    edition: "Morning",
    formattedDate: "Monday, November 2, 2026",
    leadStories: [
      {
        title: "Treasury Upgrades Growth Projections on Export Strength",
        source: "RNZ News",
        summary: "Primary sector exports exceed annual guidance, driving fiscal revenue upgrade.",
      },
      {
        title: "Subsea Cable Resilience Redundancy Commissioned",
        source: "NZ Herald",
        summary: "Second trans-Pacific fiber landing station achieves full operational latency.",
      },
    ],
  };

  const marketSentiment = {
    macroHeadline: "Export strength drives currency uptick and benchmark rally",
    assets: [
      { symbol: "NZ50", name: "NZX 50", price: 12450.8, changePercent: 0.65, sector: "NZ Equities" },
      { symbol: "NZDUSD", name: "NZD / USD", price: 0.605, changePercent: 0.35, sector: "Foreign Exchange" },
    ],
  };

  const dossier = {
    topic: "Export Growth & Infrastructure",
    executiveSummary: "Strategic synthesis across primary sectors indicates favorable balance of trade.",
    risks: [
      { category: "Currency Headwind", description: "Rising NZD compresses margins for exporters.", severity: "Elevated" },
    ],
  };

  const report = compileCSuiteReportData(briefing, marketSentiment, dossier);

  assert.equal(report.edition, "Morning");
  assert.equal(report.reportDate, "Monday, November 2, 2026");
  assert.equal(report.dossierTopic, "Export Growth & Infrastructure");
  assert.equal(report.leadArticles.length, 2);
  assert.equal(report.leadArticles[0].title, "Treasury Upgrades Growth Projections on Export Strength");
  assert.equal(report.marketAssets.length, 2);
  assert.equal(report.marketAssets[0].symbol, "NZ50");
  assert.ok(report.strategicRisks.length >= 1);
  assert.equal(report.strategicRisks[0].category, "Currency Headwind");
  assert.ok(report.redTeamContrarianNote);
});

test("compileCSuiteReportData builds robust fallback report when empty", () => {
  const report = compileCSuiteReportData(null, null, null);

  assert.equal(report.edition, "Executive");
  assert.ok(report.leadArticles.length > 0);
  assert.ok(report.marketAssets.length > 0);
  assert.ok(report.strategicRisks.length > 0);
  assert.ok(report.redTeamContrarianNote);
});

test("formatCSuiteSummaryText creates clean clipboard summary", () => {
  const report = compileCSuiteReportData(null, null, null);
  const text = formatCSuiteSummaryText(report);

  assert.ok(text.includes("SIGNAL C-SUITE INTELLIGENCE BRIEFING"));
  assert.ok(text.includes("MACRO HEADLINE:"));
  assert.ok(text.includes("CORE CATALYSTS & BREAKING DEVELOPMENTS:"));
  assert.ok(text.includes("CONTRARIAN RED TEAM CRITIQUE:"));
});
