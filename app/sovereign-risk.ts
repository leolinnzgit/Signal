export interface SovereignEconomy {
  id: string;
  name: string;
  currencyCode: string;
  sovereignRiskScore: number; // 0 - 100
  cdsSpreadBps: number;
  fx30dDepreciationVelocityPercent: number;
  foreignReservesCoverMonths: number;
  capitalControlStatus: 'Open' | 'Advisory' | 'Severe Restrictions' | 'Strict Rationing' | string;
  macroBrief: string;
}

export interface SovereignAssessRequest {
  economyId?: string;
  corporateExposureUsd?: number;
}

export interface SovereignCorrelatedSignal {
  title: string;
  source: string;
  url: string;
  signalType: string;
}

export interface SovereignAssessResponse {
  economyId: string;
  name: string;
  currencyCode: string;
  sovereignRiskScore: number;
  cdsSpreadBps: number;
  fx30dDepreciationVelocityPercent: number;
  foreignReservesCoverMonths: number;
  capitalControlStatus: string;
  repatriationHaircutPercent: number;
  estimatedExposureLossUsd: string;
  treasuryActionPlaybooks: string[];
  assessedAt: string;
  correlatedSignals?: SovereignCorrelatedSignal[];
  dataSource?: string;
}

export const FALLBACK_ECONOMIES: SovereignEconomy[] = [
  {
    id: 'argentina',
    name: 'Argentina',
    currencyCode: 'ARS',
    sovereignRiskScore: 92,
    cdsSpreadBps: 1420,
    fx30dDepreciationVelocityPercent: -18.4,
    foreignReservesCoverMonths: 1.8,
    capitalControlStatus: 'Strict Rationing',
    macroBrief: 'Cepo cambiario restrictions and severe central bank net reserve deficits enforce mandatory central bank approval for foreign currency repatriation.'
  },
  {
    id: 'egypt',
    name: 'Egypt',
    currencyCode: 'EGP',
    sovereignRiskScore: 78,
    cdsSpreadBps: 980,
    fx30dDepreciationVelocityPercent: -12.2,
    foreignReservesCoverMonths: 2.6,
    capitalControlStatus: 'Severe Restrictions',
    macroBrief: 'Suez Canal transit revenue down 55% due to Red Sea diversions, widening current account deficit despite Ras El-Hekma investment inflows.'
  },
  {
    id: 'pakistan',
    name: 'Pakistan',
    currencyCode: 'PKR',
    sovereignRiskScore: 82,
    cdsSpreadBps: 890,
    fx30dDepreciationVelocityPercent: -9.5,
    foreignReservesCoverMonths: 2.1,
    capitalControlStatus: 'Severe Restrictions',
    macroBrief: 'Heavy external debt amortization schedule ($24B due over 12 months) requiring rolling bilateral deposit rollovers from GCC partners.'
  },
  {
    id: 'turkey',
    name: 'Turkey',
    currencyCode: 'TRY',
    sovereignRiskScore: 64,
    cdsSpreadBps: 420,
    fx30dDepreciationVelocityPercent: -6.8,
    foreignReservesCoverMonths: 3.4,
    capitalControlStatus: 'Advisory',
    macroBrief: 'CBRT policy rate held at 50% with orthodox disinflation framework showing signs of net reserve rebuilding, but real rates remain volatile.'
  },
  {
    id: 'nigeria',
    name: 'Nigeria',
    currencyCode: 'NGN',
    sovereignRiskScore: 71,
    cdsSpreadBps: 680,
    fx30dDepreciationVelocityPercent: -14.6,
    foreignReservesCoverMonths: 3.1,
    capitalControlStatus: 'Advisory',
    macroBrief: 'Naira float and fuel subsidy reforms creating transitional inflation shock; central bank working through backlog of foreign airline and corporate FX remittances.'
  },
  {
    id: 'japan',
    name: 'Japan',
    currencyCode: 'JPY',
    sovereignRiskScore: 32,
    cdsSpreadBps: 25,
    fx30dDepreciationVelocityPercent: -4.2,
    foreignReservesCoverMonths: 16.5,
    capitalControlStatus: 'Open',
    macroBrief: 'Bank of Japan policy rate normalization and global JPY carry trade unwinding creating cross-asset equity volatility.'
  },
  {
    id: 'uk',
    name: 'United Kingdom',
    currencyCode: 'GBP',
    sovereignRiskScore: 24,
    cdsSpreadBps: 18,
    fx30dDepreciationVelocityPercent: -0.8,
    foreignReservesCoverMonths: 8.4,
    capitalControlStatus: 'Open',
    macroBrief: 'Gilt market steady with tight fiscal rules; sovereign debt-to-GDP hovering near 98% with limited autumn budget headroom.'
  },
  {
    id: 'us',
    name: 'United States',
    currencyCode: 'USD',
    sovereignRiskScore: 15,
    cdsSpreadBps: 0,
    fx30dDepreciationVelocityPercent: 0.0,
    foreignReservesCoverMonths: 24.0,
    capitalControlStatus: 'Open',
    macroBrief: 'Global reserve currency anchor; federal deficit at 6.4% of GDP with steady international demand for Treasury auctions.'
  }
];

export function getSovereignRiskColor(score: number): string {
  if (score >= 80) return 'var(--danger-color, #ef4444)';
  if (score >= 60) return 'var(--warning-color, #f59e0b)';
  if (score >= 40) return 'var(--info-color, #3b82f6)';
  return 'var(--success-color, #10b981)';
}

export function formatSovereignRiskReport(assessment: SovereignAssessResponse): string {
  const lines: string[] = [
    `# Sovereign Risk & Capital Repatriation Intelligence Brief: ${assessment.name} (${assessment.currencyCode})`,
    `Generated: ${new Date(assessment.assessedAt).toUTCString()}`,
    '',
    `## Executive Macro Diagnostics`,
    `- **Sovereign Risk Score**: ${assessment.sovereignRiskScore}/100`,
    `- **5Y Sovereign CDS Spread**: ${assessment.cdsSpreadBps} bps`,
    `- **30-Day FX Velocity**: ${assessment.fx30dDepreciationVelocityPercent > 0 ? '+' : ''}${assessment.fx30dDepreciationVelocityPercent}%`,
    `- **Import Reserve Cover**: ${assessment.foreignReservesCoverMonths} months`,
    `- **Capital Controls & FX Status**: ${assessment.capitalControlStatus}`,
    '',
    `## Corporate Haircut & Value at Risk`,
    `- **Model Repatriation Haircut**: ${assessment.repatriationHaircutPercent}%`,
    `- **Estimated Capital at Risk**: ${assessment.estimatedExposureLossUsd}`,
    '',
    `## Recommended Treasury Action Playbooks`,
    ...assessment.treasuryActionPlaybooks.map((p, idx) => `${idx + 1}. ${p}`),
    '',
    `---\n*CONFIDENTIAL - Signal Macro FX & Debt Stress Radar*`
  ];
  return lines.join('\n');
}

export async function fetchSovereignEconomies(fetchImpl: typeof fetch = fetch): Promise<SovereignEconomy[]> {
  try {
    const res = await fetchImpl('/api/sovereign-risk/economies', { credentials: 'same-origin' });
    if (!res.ok) {
      return FALLBACK_ECONOMIES;
    }
    return (await res.json()) as SovereignEconomy[];
  } catch {
    return FALLBACK_ECONOMIES;
  }
}

export async function assessSovereignRisk(
  request: SovereignAssessRequest,
  fetchImpl: typeof fetch = fetch
): Promise<SovereignAssessResponse> {
  try {
    const res = await fetchImpl('/api/sovereign-risk/assess', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as SovereignAssessResponse;
  } catch {
    const economy = FALLBACK_ECONOMIES.find(e => e.id === request.economyId) || FALLBACK_ECONOMIES[0];
    const exposure = request.corporateExposureUsd ?? 10000000;
    const haircut = economy.capitalControlStatus === 'Strict Rationing' ? 42.0 :
      economy.capitalControlStatus === 'Severe Restrictions' ? 28.0 :
      economy.capitalControlStatus === 'Advisory' ? 14.0 : 1.5;
    const loss = exposure * (haircut / 100.0);
    return {
      economyId: economy.id,
      name: economy.name,
      currencyCode: economy.currencyCode,
      sovereignRiskScore: economy.sovereignRiskScore,
      cdsSpreadBps: economy.cdsSpreadBps,
      fx30dDepreciationVelocityPercent: economy.fx30dDepreciationVelocityPercent,
      foreignReservesCoverMonths: economy.foreignReservesCoverMonths,
      capitalControlStatus: economy.capitalControlStatus,
      repatriationHaircutPercent: haircut,
      estimatedExposureLossUsd: `$${(loss / 1000000).toFixed(2)}M USD`,
      treasuryActionPlaybooks: [
        'Execute local currency reinvestment into inflation-linked sovereign paper.',
        'Structure cross-border dividend distributions via authorized multi-currency swap clearing.',
        'Hedge 90-day forward FX receivables via offshore non-deliverable forwards.'
      ],
      assessedAt: new Date().toISOString()
    };
  }
}
