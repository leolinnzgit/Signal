import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchSanctionsRadarStatus,
  formatSanctionsRadarDigest,
  getJurisdictionIcon,
  getSanctionSeverityBadgeClass,
} from "../app/sanctions-radar.ts";

test("fetchSanctionsRadarStatus calls GET /api/sanctions-radar/status when no articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    return {
      ok: true,
      json: async () => ({
        available: true,
        globalEnforcementLevel: "Heightened Enforcement — Strategic Trade Controls",
        compositeRiskIndex: 82,
        policySummary: "Tightened licensing thresholds on semiconductors and critical mineral quotas.",
        activeSanctionsActions: 2,
        exportBansInEffect: 1,
        tariffDisputes: 1,
        designatedEntitiesCount: 140,
        jurisdictions: [
          {
            jurisdiction: "United States (OFAC & BIS)",
            riskLevel: "Critical",
            focusArea: "Advanced AI Compute & EDA Tools",
            enforcementTrend: "Aggressive",
            measuresCount: 3,
            description: "Enforcement of Foreign Direct Product Rules.",
          },
        ],
        measures: [
          {
            id: "meas-bis-semiconductor-rules",
            title: "Sub-14nm Logic & HBM Advanced Export Restrictions",
            regime: "US BIS EAR",
            category: "Export Controls & Dual-Use",
            severity: "Critical",
            impactedSectors: ["Semiconductors & AI Accelerators"],
            exposureAssessment: "Mandatory presumption of denial.",
            complianceDirectives: ["Require end-use certification."],
            source: "Bureau of Industry & Security",
            effectiveDate: "Active Enforcement",
          },
        ],
        directives: [
          {
            urgency: "Immediate (P0)",
            action: "Screen all active customer records against OFAC SDN and BIS Entity Lists.",
            targetDomain: "Watchlist Screening & KYC",
          },
        ],
        spokenAudioScript: "Signal sanctions and trade compliance flash briefing script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const result = await fetchSanctionsRadarStatus({}, mockFetcher);

  assert.equal(calledUrl, "/api/sanctions-radar/status");
  assert.equal(calledMethod, "GET");
  assert.equal(result.available, true);
  assert.equal(result.globalEnforcementLevel, "Heightened Enforcement — Strategic Trade Controls");
  assert.equal(result.compositeRiskIndex, 82);
  assert.equal(result.measures.length, 1);
  assert.equal(result.measures[0].id, "meas-bis-semiconductor-rules");
});

test("fetchSanctionsRadarStatus calls POST /api/sanctions-radar/analyze when articles provided", async () => {
  let calledUrl = "";
  let calledMethod = "";
  let calledBody = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts?.method || "GET";
    calledBody = opts?.body || "";
    return {
      ok: true,
      json: async () => ({
        available: true,
        globalEnforcementLevel: "Severe Sanctions Pressure",
        compositeRiskIndex: 94,
        policySummary: "Active trade embargo in user feed.",
        activeSanctionsActions: 3,
        exportBansInEffect: 2,
        tariffDisputes: 1,
        designatedEntitiesCount: 160,
        jurisdictions: [],
        measures: [],
        directives: [],
        spokenAudioScript: "Custom feed script.",
        generatedAt: new Date().toISOString(),
      }),
    };
  };

  const sampleArticles = [
    {
      title: "New Export Restrictions Target Advanced Semiconductor Lithography",
      source: "Financial Times",
      url: "https://example.com/sanctions",
      summary: "Regulatory agencies expand dual-use restrictions to foreign foundries.",
    },
  ];

  const result = await fetchSanctionsRadarStatus({ articles: sampleArticles }, mockFetcher);

  assert.equal(calledUrl, "/api/sanctions-radar/analyze");
  assert.equal(calledMethod, "POST");
  assert.ok(calledBody.includes("New Export Restrictions"));
  assert.equal(result.compositeRiskIndex, 94);
});

test("fetchSanctionsRadarStatus handles HTTP failure gracefully", async () => {
  const failingFetcher = async () => ({
    ok: false,
    status: 502,
  });

  await assert.rejects(
    async () => {
      await fetchSanctionsRadarStatus({}, failingFetcher);
    },
    /Failed to load sanctions radar status: HTTP 502/
  );
});

test("formatSanctionsRadarDigest generates structured executive trade compliance memo", () => {
  const data = {
    available: true,
    globalEnforcementLevel: "Heightened Enforcement — Strategic Trade Controls",
    compositeRiskIndex: 82,
    policySummary: "Tightened licensing thresholds on semiconductors and critical minerals.",
    activeSanctionsActions: 2,
    exportBansInEffect: 1,
    tariffDisputes: 1,
    designatedEntitiesCount: 140,
    jurisdictions: [
      {
        jurisdiction: "United States (OFAC & BIS)",
        riskLevel: "Critical",
        focusArea: "Advanced AI Compute",
        enforcementTrend: "Aggressive",
        measuresCount: 3,
        description: "Enforcement of Foreign Direct Product Rules.",
      },
    ],
    measures: [
      {
        id: "meas-1",
        title: "Sub-14nm Logic Export Restrictions",
        regime: "US BIS EAR",
        category: "Export Controls & Dual-Use",
        severity: "Critical",
        impactedSectors: ["Semiconductors"],
        exposureAssessment: "Mandatory denial of export licenses.",
        complianceDirectives: ["Audit supply chain distributors."],
        source: "BIS",
        effectiveDate: "In Effect",
        articleUrl: "https://example.com/bis-rule",
      },
    ],
    directives: [
      {
        urgency: "Immediate (P0)",
        action: "Screen all suppliers against OFAC SDN.",
        targetDomain: "KYC & Screening",
      },
    ],
    spokenAudioScript: "Spoken script.",
    generatedAt: "2026-11-05T08:00:00Z",
  };

  const digest = formatSanctionsRadarDigest(data);

  assert.ok(digest.includes("SIGNAL GLOBAL SANCTIONS, TARIFFS & EXPORT CONTROLS RADAR"));
  assert.ok(digest.includes("Heightened Enforcement — Strategic Trade Controls"));
  assert.ok(digest.includes("Risk Index: 82/100"));
  assert.ok(digest.includes("Active Sanctions Actions:    2"));
  assert.ok(digest.includes("United States (OFAC & BIS)"));
  assert.ok(digest.includes("Sub-14nm Logic Export Restrictions"));
  assert.ok(digest.includes("Screen all suppliers against OFAC SDN."));
  assert.ok(digest.includes("https://example.com/bis-rule"));
});

test("getJurisdictionIcon returns accurate flags for world trade jurisdictions", () => {
  assert.equal(getJurisdictionIcon("United States (OFAC & BIS)"), "🇺🇸");
  assert.equal(getJurisdictionIcon("European Union (EU Sanctions)"), "🇪🇺");
  assert.equal(getJurisdictionIcon("China (MOFCOM)"), "🇨🇳");
  assert.equal(getJurisdictionIcon("United Kingdom (OFSI)"), "🇬🇧");
  assert.equal(getJurisdictionIcon("Multilateral / G7 Coalition"), "🌐");
  assert.equal(getJurisdictionIcon("Other Regulator"), "⚖️");
});

test("getSanctionSeverityBadgeClass maps severity to CSS utility classes", () => {
  assert.equal(getSanctionSeverityBadgeClass("Critical"), "sanction-badge-critical");
  assert.equal(getSanctionSeverityBadgeClass("High"), "sanction-badge-high");
  assert.equal(getSanctionSeverityBadgeClass("Elevated"), "sanction-badge-elevated");
  assert.equal(getSanctionSeverityBadgeClass("Medium"), "sanction-badge-elevated");
  assert.equal(getSanctionSeverityBadgeClass("Normal"), "sanction-badge-nominal");
});
