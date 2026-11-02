import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchRegulatoryRadar,
  synthesizeRegulatoryRadarLocally,
  formatRegulatoryRadarClipboard,
} from "../app/regulatory-radar.ts";

test("synthesizeRegulatoryRadarLocally produces compliance action schedule", () => {
  const radar = synthesizeRegulatoryRadarLocally("Banking & Fintech", "New Zealand / Australasia");

  assert.equal(radar.available, true);
  assert.equal(radar.industrySector, "Banking & Fintech");
  assert.ok(radar.billsAndMandates.length >= 2);
  assert.equal(radar.billsAndMandates[0].regulatoryBody, "Financial Markets Authority");
  assert.ok(radar.complianceChecklist.length >= 2);
  assert.ok(radar.spokenComplianceScript.includes("Banking & Fintech"));
});

test("fetchRegulatoryRadar calls endpoint and resolves mandate pipeline", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/regulatory-radar/scan") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          industrySector: "Agri & Primary Industries",
          jurisdiction: "New Zealand",
          billsAndMandates: [
            {
              title: "Water Quality & Environmental Discharge Standards",
              regulatoryBody: "Regional Councils / MfE",
              stage: "Implementation",
              complianceDeadline: "Dec 2026",
              penaltyExposure: "NZ$600k",
              summary: "Runoff monitoring.",
            },
          ],
          sectorRisks: [
            { sector: "Agri", exposureLevel: "High", keyImpactArea: "Nitrogen discharge", recommendedBoardQuery: "Are consents current?" },
          ],
          complianceChecklist: [
            { id: "CHK-01", requirement: "Audit", actionItem: "Run audit", targetQuarter: "Q4 2026", priority: "Urgent" },
          ],
          spokenComplianceScript: "Agri compliance script.",
          generatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await fetchRegulatoryRadar("Agri & Primary Industries", "New Zealand", [], undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.industrySector, "Agri & Primary Industries");
  assert.equal(res.billsAndMandates[0].title, "Water Quality & Environmental Discharge Standards");
});

test("formatRegulatoryRadarClipboard formats boardroom action schedule", () => {
  const radar = synthesizeRegulatoryRadarLocally("Energy & Resources", "New Zealand");
  const text = formatRegulatoryRadarClipboard(radar);

  assert.ok(text.includes("REGULATORY HORIZON & COMPLIANCE RADAR"));
  assert.ok(text.includes("ACTIVE LEGISLATIVE BILLS & REGULATORY MANDATES:"));
  assert.ok(text.includes("BOARDROOM COMPLIANCE ACTION CHECKLIST:"));
});
