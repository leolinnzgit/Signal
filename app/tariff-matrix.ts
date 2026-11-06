/**
 * Global Tariff & Trade Arbitrage Impact Matrix Client Engine
 * Models corridor tariff sensitivity, COGS compression, and FTA arbitrage pathways.
 */

export interface TradeProfile {
  id: string;
  name: string;
  hsCode: string;
  sector: string;
  baselineTariffRate: number;
  tier1ConcentrationPercent: number;
  typicalGrossMarginPercent: number;
  primaryOrigins: string[];
  dualUseExportControlEccn: string;
  executiveBrief: string;
}

export interface CorridorAdjustment {
  corridor: "us-china" | "eu-china" | "apac-us" | "us-eu";
  tariffRatePercent: number;
}

export interface ArbitrageOption {
  destination: string;
  ftaAgreement: string;
  tariffRecoveryPercent: number;
  leadTimeDeltaWeeks: number;
  strategicRationale: string;
}

export interface TariffSimulationResponse {
  profileId: string;
  profileName: string;
  blendedEffectiveTariffPercent: number;
  cogsImpactPercent: number;
  ebitdaMarginCompressionBps: number;
  annualizedPnlVarianceUsd: string;
  arbitrageOptions: ArbitrageOption[];
  exportControlAlerts: string[];
  executiveDirectives: string[];
  simulatedAt: string;
}

/**
 * Compiles a comprehensive Tariff Defense & Supply Arbitrage Dossier
 */
export function formatTariffDefenseDossier(
  profile: TradeProfile,
  sim: TariffSimulationResponse,
  corridors: CorridorAdjustment[]
): string {
  const date = new Date().toUTCString();
  return `# SIGNAL TARIFF DEFENSE & SUPPLY ARBITRAGE DOSSIER
Sector Profile: ${profile.name} (${profile.hsCode})
Sector: ${profile.sector}
Generated: ${date}

## Tariff Impact Telemetry
- Blended Effective Tariff: ${sim.blendedEffectiveTariffPercent}%
- Direct COGS Inflation: +${sim.cogsImpactPercent}%
- EBITDA Margin Compression: -${sim.ebitdaMarginCompressionBps} bps
- Projected Annualized P&L Impact: ${sim.annualizedPnlVarianceUsd} (per $100M revenue unit)

## Applied Trade Corridor Assumptions
${corridors.map((c) => `- ${c.corridor.toUpperCase()}: ${c.tariffRatePercent}%`).join("\n")}

## Nearshoring & FTA Arbitrage Pathways
${sim.arbitrageOptions
  .map(
    (a, i) =>
      `### ${i + 1}. ${a.destination} (${a.ftaAgreement})
- Tariff Recovery: ${a.tariffRecoveryPercent}%
- Lead Time Delta: +${a.leadTimeDeltaWeeks} weeks
- Strategic Rationale: ${a.strategicRationale}`
  )
  .join("\n\n")}

## Export Control & BIS Dual-Use Notices
${sim.exportControlAlerts.map((e) => `* ${e}`).join("\n")}

## Strategic Action Checklist
${sim.executiveDirectives.map((d, i) => `${i + 1}. ${d}`).join("\n")}

---
CONFIDENTIAL - SIGNAL GLOBAL TRADE INTELLIGENCE`;
}

/**
 * Client API fetchers
 */
export async function fetchTradeProfiles(): Promise<TradeProfile[]> {
  const res = await fetch("/api/tariff-matrix/profiles", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load trade profiles: HTTP ${res.status}`);
  return res.json();
}

export async function simulateTariffImpact(
  profileId: string,
  corridorAdjustments: CorridorAdjustment[],
  customTier1Concentration?: number,
  customGrossMargin?: number
): Promise<TariffSimulationResponse> {
  const res = await fetch("/api/tariff-matrix/simulate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      profileId,
      corridorAdjustments,
      customTier1Concentration,
      customGrossMargin,
    }),
  });
  if (!res.ok) throw new Error(`Failed to simulate tariff: HTTP ${res.status}`);
  return res.json();
}
