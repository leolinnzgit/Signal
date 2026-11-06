import test from "node:test";
import assert from "node:assert/strict";
import { formatTariffDefenseDossier } from "../app/tariff-matrix.ts";

test("formatTariffDefenseDossier accurately compiles a structured strategic dossier", () => {
  const mockProfile = {
    id: "semiconductors",
    name: "Advanced Microelectronics",
    hsCode: "HS 8542.31",
    sector: "Technology & Hardware",
    baselineTariffRate: 15.0,
    tier1ConcentrationPercent: 72,
    typicalGrossMarginPercent: 54.0,
    primaryOrigins: ["Taiwan", "South Korea"],
    dualUseExportControlEccn: "3A090.a",
    executiveBrief: "Exposure to Section 301 tariffs.",
  };

  const mockSim = {
    profileId: "semiconductors",
    profileName: "Advanced Microelectronics",
    blendedEffectiveTariffPercent: 18.5,
    cogsImpactPercent: 8.6,
    ebitdaMarginCompressionBps: 320,
    annualizedPnlVarianceUsd: "-$15.9M",
    arbitrageOptions: [
      {
        destination: "Penang, Malaysia",
        ftaAgreement: "CPTPP Free Trade Zone",
        tariffRecoveryPercent: 72.0,
        leadTimeDeltaWeeks: 3,
        strategicRationale: "Established advanced packaging ecosystem.",
      },
    ],
    exportControlAlerts: ["Dual-Use Classification: 3A090.a requires validated end-user license."],
    executiveDirectives: ["Initiate qualification of bonded assembly facilities."],
    simulatedAt: new Date().toISOString(),
  };

  const mockCorridors = [
    { corridor: "us-china", tariffRatePercent: 25 },
    { corridor: "eu-china", tariffRatePercent: 18 },
  ];

  const memo = formatTariffDefenseDossier(mockProfile, mockSim, mockCorridors);
  assert.ok(memo.includes("SIGNAL TARIFF DEFENSE & SUPPLY ARBITRAGE DOSSIER"));
  assert.ok(memo.includes("Advanced Microelectronics"));
  assert.ok(memo.includes("HS 8542.31"));
  assert.ok(memo.includes("Blended Effective Tariff: 18.5%"));
  assert.ok(memo.includes("Direct COGS Inflation: +8.6%"));
  assert.ok(memo.includes("EBITDA Margin Compression: -320 bps"));
  assert.ok(memo.includes("Penang, Malaysia"));
  assert.ok(memo.includes("CPTPP Free Trade Zone"));
  assert.ok(memo.includes("3A090.a"));
  assert.ok(memo.includes("Initiate qualification"));
});
