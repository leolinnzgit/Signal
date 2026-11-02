import test from "node:test";
import assert from "node:assert/strict";
import {
  compileExecutiveDossier,
  synthesizeDossierLocally,
  formatDossierMarkdown,
} from "../app/executive-dossier.ts";

test("synthesizeDossierLocally produces multi-publisher executive binder", () => {
  const articles = [
    {
      title: "Clean Energy Transmission Upgrades Approved",
      source: "RNZ News",
      url: "https://rnz.co.nz/story/1",
      summary: "Regulators approve $400M grid upgrade for renewable connection.",
    },
    {
      title: "Cost Allocation Concerns from Major Power Users",
      source: "NZ Herald",
      url: "https://nzherald.co.nz/story/2",
      summary: "Industrial manufacturers push back against line fee increases.",
    },
  ];

  const dossier = synthesizeDossierLocally("Clean Energy Transmission", articles);

  assert.equal(dossier.available, true);
  assert.equal(dossier.topic, "Clean Energy Transmission");
  assert.ok(dossier.executiveSummary.includes("2 news organizations"));
  assert.equal(dossier.perspectives.length, 2);
  assert.equal(dossier.perspectives[0].publisher, "RNZ News");
  assert.equal(dossier.perspectives[1].publisher, "NZ Herald");
  assert.ok(dossier.risks.length >= 3);
  assert.ok(dossier.milestones.length >= 3);
  assert.equal(dossier.milestones[0].phase, "Past Context");
  assert.equal(dossier.milestones[1].phase, "Today's Catalyst");
  assert.equal(dossier.milestones[2].phase, "Forward Milestone");
  assert.equal(dossier.citedSources.length, 2);
});

test("formatDossierMarkdown converts dossier object into executive markdown briefing", () => {
  const mockDossier = {
    available: true,
    topic: "AI Sovereignty Framework",
    executiveSummary: "Government outlines localized compute and data sovereignty parameters.",
    perspectives: [
      { publisher: "Tech Wire", framingTone: "Infrastructure", primaryFocus: "Datacenter capital commitments." },
    ],
    risks: [
      { category: "Compliance", description: "Audit verification hurdles.", severity: "Elevated" },
    ],
    milestones: [
      { phase: "Today's Catalyst", dateOrEra: "Q4 2026", headline: "Bill Introduced", summary: "Parliament introduces policy.", source: "Govt Wire", sourceUrl: null },
    ],
    citedSources: ["Tech Wire: 'Datacenter Expansion' (https://example.com/tc)"],
  };

  const md = formatDossierMarkdown(mockDossier);

  assert.ok(md.includes("# Signal Executive Dossier: AI Sovereignty Framework"));
  assert.ok(md.includes("## Executive Summary"));
  assert.ok(md.includes("Government outlines localized compute"));
  assert.ok(md.includes("## Multi-Publisher Perspectives"));
  assert.ok(md.includes("* **Tech Wire** (Infrastructure): Datacenter capital commitments."));
  assert.ok(md.includes("## Strategic & Downstream Risk Matrix"));
  assert.ok(md.includes("* **[ELEVATED] Compliance**: Audit verification hurdles."));
  assert.ok(md.includes("## Story Evolution Timeline"));
  assert.ok(md.includes("## Cited Intelligence Sources"));
});

test("compileExecutiveDossier calls backend endpoint and handles errors gracefully", async () => {
  const mockFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-token-abc" }) };
    }
    assert.equal(url, "/api/story-cluster/dossier");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-XSRF-TOKEN"], "csrf-token-abc");

    return {
      ok: true,
      json: async () => ({
        available: true,
        topic: "Geothermal Investment",
        executiveSummary: "Consortium launches major exploration project in Taupo Volcanic Zone.",
        perspectives: [],
        risks: [],
        milestones: [],
        citedSources: ["Signal Desk: Geothermal (https://signal.internal)"],
      }),
    };
  };

  const res = await compileExecutiveDossier(
    "Geothermal Investment",
    [{ title: "Taupo Drilling", source: "Signal Desk", url: "https://signal.internal" }],
    undefined,
    mockFetcher,
  );

  assert.equal(res.available, true);
  assert.equal(res.topic, "Geothermal Investment");
  assert.ok(res.executiveSummary.includes("Taupo Volcanic Zone"));
});

test("compileExecutiveDossier falls back to local synthesis on network failure", async () => {
  const failingFetcher = async () => {
    throw new Error("Connection refused");
  };

  const res = await compileExecutiveDossier(
    "Maritime Security",
    [{ title: "Patrol Fleet Modernization", source: "Naval Institute", url: "https://example.com/navy" }],
    undefined,
    failingFetcher,
  );

  assert.equal(res.available, true);
  assert.equal(res.topic, "Maritime Security");
  assert.ok(res.executiveSummary.includes("Single-source executive briefing"));
});
