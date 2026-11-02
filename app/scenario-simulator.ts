export interface ScenarioOrderImpact {
  orderLevel: number;
  domain: string;
  impactSummary: string;
  transmissionChannel: string;
  severity: "Critical" | "High" | "Elevated" | "Moderate" | string;
}

export interface ScenarioMitigationItem {
  priority: string;
  action: string;
  ownerRole: string;
}

export interface ScenarioSimulationResult {
  available: boolean;
  scenario: string;
  executiveSummary: string;
  resilienceScore: number;
  riskLevel: string;
  impacts: ScenarioOrderImpact[];
  mitigationPlan: ScenarioMitigationItem[];
  simulatedAt: string;
}

export async function simulateScenario(
  scenario: string,
  baselineAssets?: Array<{ symbol: string; name: string; price: number; percentChange?: number; changePercent?: number }>,
  industryFocus?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ScenarioSimulationResult> {
  const isOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;
  if (!isOnline) {
    return synthesizeScenarioLocally(scenario);
  }

  try {
    let token = "";
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const res = await fetcher("/api/scenario-simulator/simulate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        scenario,
        baselineAssets: baselineAssets?.slice(0, 10).map((a) => ({
          symbol: a.symbol,
          name: a.name,
          price: a.price,
          percentChange: a.percentChange ?? a.changePercent ?? 0,
        })),
        industryFocus,
      }),
      signal,
    });

    if (!res.ok) {
      return synthesizeScenarioLocally(scenario);
    }

    const data = await res.json();
    return {
      available: Boolean(data.available),
      scenario: data.scenario || scenario,
      executiveSummary: data.executiveSummary || "",
      resilienceScore: typeof data.resilienceScore === "number" ? data.resilienceScore : 65,
      riskLevel: data.riskLevel || "Moderate Exposure",
      impacts: Array.isArray(data.impacts) ? data.impacts : [],
      mitigationPlan: Array.isArray(data.mitigationPlan) ? data.mitigationPlan : [],
      simulatedAt: data.simulatedAt || new Date().toISOString(),
    };
  } catch {
    return synthesizeScenarioLocally(scenario);
  }
}

export function synthesizeScenarioLocally(scenario: string): ScenarioSimulationResult {
  const sLower = scenario.toLowerCase();
  const now = new Date().toISOString();

  let impacts: ScenarioOrderImpact[];
  if (sLower.includes("ocr") || sLower.includes("rate") || sLower.includes("cut") || sLower.includes("inflation")) {
    impacts = [
      {
        orderLevel: 1,
        domain: "Wholesale Yields & FX Repricing",
        impactSummary: "Wholesale 2-year swap rates drop 35bps; NZD dips against USD within 24 hours.",
        transmissionChannel: "Algorithmic interbank execution",
        severity: "Elevated",
      },
      {
        orderLevel: 2,
        domain: "Commercial Debt Rollovers & Capex",
        impactSummary: "Mid-market banking covenants loosen; corporates reassess delayed automation capex.",
        transmissionChannel: "Bank lending facility repricing",
        severity: "Moderate",
      },
      {
        orderLevel: 3,
        domain: "Strategic Valuation & M&A Multiples",
        impactSummary: "Discount rate compression drives private equity bidding across cash-generative industrial assets.",
        transmissionChannel: "Terminal valuation recalculation",
        severity: "Moderate",
      },
    ];
  } else if (sLower.includes("port") || sLower.includes("strike") || sLower.includes("freight") || sLower.includes("supply")) {
    impacts = [
      {
        orderLevel: 1,
        domain: "Port Berth Capacity & Demurrage",
        impactSummary: "Container dwell times triple; shipping lines activate congestion surcharges immediately.",
        transmissionChannel: "Maritime logistics berth stoppage",
        severity: "High",
      },
      {
        orderLevel: 2,
        domain: "Tier-1 Inventory Depletion",
        impactSummary: "Just-in-time assembly lines encounter component stockouts within 14 days.",
        transmissionChannel: "Inland freight distribution backlog",
        severity: "High",
      },
      {
        orderLevel: 3,
        domain: "Dual-Sourcing Mandates",
        impactSummary: "Governance committees mandate 60-day safety stock buffers and alternate air freight contracts.",
        transmissionChannel: "Supply chain risk compliance review",
        severity: "Elevated",
      },
    ];
  } else {
    impacts = [
      {
        orderLevel: 1,
        domain: "Primary Sector Sentiment & Equity Volatility",
        impactSummary: "Benchmark equities drop 1.8%; corporate spreads widen on foreign currency debt.",
        transmissionChannel: "Market price discovery & risk premium reassessment",
        severity: "Elevated",
      },
      {
        orderLevel: 2,
        domain: "Working Capital Drawdown",
        impactSummary: "Supply chain partners demand tighter trade terms; cash conversion cycles stretch by 2 weeks.",
        transmissionChannel: "Trade credit insurance revisions",
        severity: "High",
      },
      {
        orderLevel: 3,
        domain: "Board Governance & Capital Preservation",
        impactSummary: "Board mandates temporary freeze on uncommitted expansion capital and reviews liquidity reserves.",
        transmissionChannel: "Audit committee special review",
        severity: "Moderate",
      },
    ];
  }

  const highCount = impacts.filter((i) => i.severity === "High").length;
  const score = Math.max(35, 85 - highCount * 15);

  return {
    available: true,
    scenario,
    executiveSummary: `Simulation of '${scenario}': Models multi-order transmission from immediate market discovery to operational inventory constraints and strategic governance responses.`,
    resilienceScore: score,
    riskLevel: score < 50 ? "High Vulnerability" : score < 75 ? "Moderate Exposure" : "Resilient Posture",
    impacts,
    mitigationPlan: [
      {
        priority: "Immediate (Day 1-7)",
        action: "Conduct emergency liquidity review and lock in available revolving credit facilities.",
        ownerRole: "Chief Financial Officer",
      },
      {
        priority: "Operational (Day 8-30)",
        action: "Audit core suppliers for inventory buffers and activate alternate logistics routing.",
        ownerRole: "Chief Operating Officer",
      },
      {
        priority: "Governance (Day 31-90)",
        action: "Convene Board Risk Committee to re-baseline multi-year capital hurdle rates.",
        ownerRole: "Board Chair / CEO",
      },
    ],
    simulatedAt: now,
  };
}

export function formatScenarioClipboard(sim: ScenarioSimulationResult): string {
  let text = `🎲 BOARDROOM SCENARIO SIMULATION PLAYBOOK\n`;
  text += `Scenario: "${sim.scenario}"\n`;
  text += `Resilience Score: ${sim.resilienceScore}/100 (${sim.riskLevel})\n`;
  text += `====================================================\n\n`;

  text += `EXECUTIVE SUMMARY:\n${sim.executiveSummary}\n\n`;

  text += `MULTI-ORDER TRANSMISSION IMPACTS:\n`;
  for (const imp of sim.impacts) {
    text += `* [ORDER ${imp.orderLevel}] ${imp.domain} [${imp.severity}]\n  Impact: ${imp.impactSummary}\n  Channel: ${imp.transmissionChannel}\n`;
  }
  text += `\n`;

  text += `MITIGATION & PLAYBOOK CHECKLIST:\n`;
  for (const m of sim.mitigationPlan) {
    text += `* [${m.priority}] ${m.action} (Owner: ${m.ownerRole})\n`;
  }
  text += `\nGenerated via Signal Boardroom Scenario Simulator.\n`;
  return text;
}
