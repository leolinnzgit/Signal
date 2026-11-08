export interface PreMortemInitiative {
  id: string;
  title: string;
  category: string;
  capitalAtStakeUsd: string;
  baselineRiskScore: number;
  summary: string;
}

export interface CollapseVector {
  vectorId: string;
  name: string;
  severity: 'Critical' | 'High' | 'Moderate' | string;
  failureMechanism: string;
  earlyWarningIndicators: string[];
  preemptiveHedgingDirective: string;
}

export interface PreMortemSimulateRequest {
  initiativeId?: string;
  customTitle?: string;
  horizonMonths?: number;
}

export interface PreMortemLiveSignal {
  title: string;
  source: string;
  url: string;
  matchedVector: string;
}

export interface PreMortemDossier {
  initiativeId: string;
  title: string;
  horizonMonths: number;
  executiveSummaryAutopsy: string;
  overallFatalityProbabilityPercent: number;
  collapseVectors: CollapseVector[];
  boardRecommendation: string;
  simulatedAt: string;
  liveRiskSignals?: PreMortemLiveSignal[];
}

export const FALLBACK_INITIATIVES: PreMortemInitiative[] = [
  {
    id: 'ai-cloud-migration',
    title: 'Autonomous Enterprise AI Cloud Transformation',
    category: 'Technology & Infrastructure',
    capitalAtStakeUsd: '$45M USD',
    baselineRiskScore: 78,
    summary: 'Complete core architecture shift to multi-tenant frontier LLM pipelines and automated agent workflows.'
  },
  {
    id: 'pan-european-fintech-mna',
    title: 'Pan-European Cross-Border Fintech Acquisition',
    category: 'M&A / Inorganic Growth',
    capitalAtStakeUsd: '$120M USD',
    baselineRiskScore: 68,
    summary: 'Acquiring Tier-2 payments processor to secure cross-border SEPA and multi-currency rails across 14 EU member states.'
  },
  {
    id: 'critical-materials-foundry',
    title: 'Rare-Earth & Advanced Substrate Foundry Joint Venture',
    category: 'Supply Chain & Manufacturing',
    capitalAtStakeUsd: '$85M USD',
    baselineRiskScore: 84,
    summary: 'Building on-shore processing joint venture for gallium/germanium wafer packaging to decouple from East Asian export curbs.'
  },
  {
    id: 'direct-consumer-health',
    title: 'Global Direct-to-Consumer Biometric Health Platform',
    category: 'Product Expansion',
    capitalAtStakeUsd: '$30M USD',
    baselineRiskScore: 62,
    summary: 'Direct-to-consumer connected health wearable ecosystem with recurring subscription and health analytics.'
  }
];

export function getSeverityBadgeClass(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical':
      return 'pre-mortem-badge-critical';
    case 'high':
      return 'pre-mortem-badge-high';
    default:
      return 'pre-mortem-badge-moderate';
  }
}

export function formatPreMortemDossier(dossier: PreMortemDossier): string {
  const lines: string[] = [
    `# Boardroom Pre-Mortem Autopsy: "${dossier.title}"`,
    `Simulated Time Horizon: +${dossier.horizonMonths} Months | Fatality Probability: ${dossier.overallFatalityProbabilityPercent}%`,
    `Generated: ${new Date(dossier.simulatedAt).toUTCString()}`,
    '',
    `## Executive Autopsy Scenario`,
    dossier.executiveSummaryAutopsy,
    '',
    `## Board Governance Recommendation`,
    `> ${dossier.boardRecommendation}`,
    '',
    `## Fatal Collapse Vectors & Hedging Directives`,
    ...dossier.collapseVectors.flatMap((v, idx) => [
      `### ${idx + 1}. [${v.severity.toUpperCase()}] ${v.name}`,
      `**Failure Mechanism:** ${v.failureMechanism}`,
      `**Early Warning Indicators (EWIs):**`,
      ...v.earlyWarningIndicators.map(ewi => `  - ${ewi}`),
      `**Pre-Emptive Hedging Directive:**`,
      `  * ${v.preemptiveHedgingDirective}`,
      ''
    ]),
    `---\n*CONFIDENTIAL - Corporate Pre-Mortem Wargame Simulator ("Kill The Company")*`
  ];

  return lines.join('\n');
}

export async function fetchPreMortemInitiatives(fetchImpl: typeof fetch = fetch): Promise<PreMortemInitiative[]> {
  try {
    const res = await fetchImpl('/api/pre-mortem/initiatives', { credentials: 'same-origin' });
    if (!res.ok) {
      return FALLBACK_INITIATIVES;
    }
    return (await res.json()) as PreMortemInitiative[];
  } catch {
    return FALLBACK_INITIATIVES;
  }
}

export async function simulatePreMortem(
  request: PreMortemSimulateRequest,
  fetchImpl: typeof fetch = fetch
): Promise<PreMortemDossier> {
  try {
    const res = await fetchImpl('/api/pre-mortem/simulate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as PreMortemDossier;
  } catch {
    const matched = FALLBACK_INITIATIVES.find(i => i.id === request.initiativeId) || FALLBACK_INITIATIVES[0];
    const horizon = request.horizonMonths ?? 18;
    return {
      initiativeId: matched.id,
      title: request.customTitle || matched.title,
      horizonMonths: horizon,
      executiveSummaryAutopsy: `PRE-MORTEM AUTOPSY SCENARIO: By month ${horizon}, '${matched.title}' suffered catastrophic operational shutdown. Fragility vectors expanded faster than mitigation budgets.`,
      overallFatalityProbabilityPercent: matched.baselineRiskScore > 75 ? 68 : 54,
      collapseVectors: [
        {
          vectorId: 'v1',
          name: 'Regulatory Intervention & Compliance Injunction',
          severity: 'Critical',
          failureMechanism: 'Sudden enforcement action halted market rollout due to unhedged cross-jurisdiction data compliance conflicts.',
          earlyWarningIndicators: ['Phase 2 regulator inquiry initiated', 'Compliance audit backlog spikes > 30%'],
          preemptiveHedgingDirective: 'Implement zero-trust isolated tenant sandboxes and pre-clear supervisory filing.'
        },
        {
          vectorId: 'v2',
          name: 'Cost Escalation & Margin Inversion',
          severity: 'High',
          failureMechanism: 'Operating vendor overhead and unexpected licensing scaling fees erased projected EBITDA margins.',
          earlyWarningIndicators: ['Unit cost per active client rises > 15%', 'Vendor renewal rate price hike'],
          preemptiveHedgingDirective: 'Contractually lock 3-year enterprise rate ceilings and maintain fallback open-source pipeline.'
        }
      ],
      boardRecommendation: 'BOARD DIRECTIVE: CONDITIONAL APPROVAL WITH GATED TRANCHES. Release seed capital only upon milestone verification.',
      simulatedAt: new Date().toISOString()
    };
  }
}
