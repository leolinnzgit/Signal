// Autonomous Horizon Scanner & Living Intelligence Dossiers

export interface StrategicMilestone {
  date: string;
  milestone: string;
  status: "Completed" | "In Progress" | "Target" | "Delayed";
  verificationSource: string;
}

export interface WeeklyDeltaReport {
  inflectionPointsThisWeek: string[];
  invalidatedAssumptions: string[];
  catalystsNext90Days: string[];
}

export interface HorizonDossier {
  id: string;
  strategicTopic: string;
  domain: string;
  maturityPhase: string;
  status: string;
  confidenceScore: number;
  horizonWindow: string;
  executiveThesis: string;
  milestones: StrategicMilestone[];
  weeklyDelta: WeeklyDeltaReport;
  keyWatchEntities: string[];
  lastUpdated: string;
}

export interface HorizonScannerResponse {
  available: boolean;
  activeDossiersCount: number;
  inflectionsCount: number;
  strategicSummary: string;
  dossiers: HorizonDossier[];
  spokenAudioScript: string;
  generatedAt: string;
}

export interface FetchHorizonScannerOptions {
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  watchedDomains?: string[];
  signal?: AbortSignal;
}

export async function fetchHorizonDossiers(
  options?: FetchHorizonScannerOptions,
  fetcher: typeof fetch = fetch
): Promise<HorizonScannerResponse> {
  const hasArticles = options?.articles && options.articles.length > 0;
  const endpoint = hasArticles ? "/api/horizon-scanner/analyze" : "/api/horizon-scanner/dossiers";
  const method = hasArticles ? "POST" : "GET";

  let token = "";
  if (hasArticles && typeof window !== "undefined") {
    try {
      const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", signal: options?.signal });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (hasArticles) {
    headers["Content-Type"] = "application/json";
    if (token) {
      headers["X-XSRF-TOKEN"] = token;
    }
  }

  const response = await fetcher(endpoint, {
    method,
    headers,
    credentials: "same-origin",
    body: hasArticles ? JSON.stringify({ articles: options?.articles, watchedDomains: options?.watchedDomains }) : undefined,
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load horizon dossiers: HTTP ${response.status}`);
  }

  return (await response.json()) as HorizonScannerResponse;
}

export function formatHorizonScannerDigest(data: HorizonScannerResponse): string {
  const lines: string[] = [
    `🔭 SIGNAL AUTONOMOUS HORIZON SCANNER & LIVING DOSSIERS`,
    `Summary: ${data.strategicSummary}`,
    `Active Strategic Horizons: ${data.activeDossiersCount} | Inflection Points Detected: ${data.inflectionsCount}`,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    ``,
    `STRATEGIC LIVING DOSSIERS:`,
  ];

  for (const d of data.dossiers) {
    lines.push(`═══════════════════════════════════════════════════════════════`);
    lines.push(`[${d.status.toUpperCase()}] ${d.strategicTopic}`);
    lines.push(`Domain: ${d.domain} | Horizon: ${d.horizonWindow} | Confidence: ${d.confidenceScore}/100`);
    lines.push(`Maturity Phase: ${d.maturityPhase}`);
    lines.push(`Executive Thesis: ${d.executiveThesis}`);
    lines.push(``);
    lines.push(`WEEKLY DELTA & INFLECTIONS:`);
    for (const inf of d.weeklyDelta.inflectionPointsThisWeek) {
      lines.push(`  • Inflection: ${inf}`);
    }
    for (const inv of d.weeklyDelta.invalidatedAssumptions) {
      lines.push(`  • Invalidated Assumption: ${inv}`);
    }
    for (const cat of d.weeklyDelta.catalystsNext90Days) {
      lines.push(`  • Upcoming Catalyst: ${cat}`);
    }
    lines.push(``);
    lines.push(`STRATEGIC ROADMAP MILESTONES:`);
    for (const m of d.milestones) {
      lines.push(`  - [${m.status.toUpperCase()}] (${m.date}) ${m.milestone} [Source: ${m.verificationSource}]`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export function getDomainIcon(domain: string): string {
  const lower = domain.toLowerCase();
  if (lower.includes("semiconductor") || lower.includes("deep tech")) return "🔬";
  if (lower.includes("cybersecurity") || lower.includes("crypto")) return "🔐";
  if (lower.includes("energy") || lower.includes("mobility") || lower.includes("battery")) return "🔋";
  if (lower.includes("geopolitics") || lower.includes("maritime")) return "⚓";
  if (lower.includes("monetary") || lower.includes("currency")) return "🪙";
  return "🔭";
}

export function getMilestoneStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "completed":
      return "horizon-milestone-completed";
    case "in progress":
      return "horizon-milestone-progress";
    case "delayed":
      return "horizon-milestone-delayed";
    default:
      return "horizon-milestone-target";
  }
}

export function getDossierStatusClass(status: string): string {
  if (status.includes("Inflection")) return "horizon-status-inflection";
  if (status.includes("Challenged")) return "horizon-status-challenged";
  if (status.includes("Accelerating")) return "horizon-status-accelerating";
  return "horizon-status-monitoring";
}
