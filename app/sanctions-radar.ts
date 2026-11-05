// Global Sanctions, Tariffs & Export Controls Radar

export interface JurisdictionRisk {
  jurisdiction: string;
  riskLevel: "Critical" | "High" | "Elevated" | "Guarded";
  focusArea: string;
  enforcementTrend: "Aggressive" | "Escalating" | "Active" | "Stable";
  measuresCount: number;
  description: string;
}

export interface SanctionMeasure {
  id: string;
  title: string;
  regime: string;
  category: "Export Controls & Dual-Use" | "Financial & Banking Sanctions" | "Tariffs & Trade Remedies" | "Critical Minerals & Commodities" | "Maritime & Shadow Fleet";
  severity: "Critical" | "High" | "Medium" | "Low";
  impactedSectors: string[];
  exposureAssessment: string;
  complianceDirectives: string[];
  source: string;
  effectiveDate: string;
  articleUrl?: string;
}

export interface ComplianceDirective {
  urgency: string;
  action: string;
  targetDomain: string;
}

export interface SanctionsRadarResponse {
  available: boolean;
  globalEnforcementLevel: string;
  compositeRiskIndex: number;
  policySummary: string;
  activeSanctionsActions: number;
  exportBansInEffect: number;
  tariffDisputes: number;
  designatedEntitiesCount: number;
  jurisdictions: JurisdictionRisk[];
  measures: SanctionMeasure[];
  directives: ComplianceDirective[];
  spokenAudioScript: string;
  generatedAt: string;
}

export interface FetchSanctionsRadarOptions {
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  signal?: AbortSignal;
}

export async function fetchSanctionsRadarStatus(
  options?: FetchSanctionsRadarOptions,
  fetcher: typeof fetch = fetch
): Promise<SanctionsRadarResponse> {
  const hasArticles = options?.articles && options.articles.length > 0;
  const endpoint = hasArticles ? "/api/sanctions-radar/analyze" : "/api/sanctions-radar/status";
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
    body: hasArticles ? JSON.stringify({ articles: options?.articles }) : undefined,
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load sanctions radar status: HTTP ${response.status}`);
  }

  return (await response.json()) as SanctionsRadarResponse;
}

export function formatSanctionsRadarDigest(data: SanctionsRadarResponse): string {
  const lines: string[] = [
    `🛡️ SIGNAL GLOBAL SANCTIONS, TARIFFS & EXPORT CONTROLS RADAR`,
    `Enforcement Posture: ${data.globalEnforcementLevel} (Risk Index: ${data.compositeRiskIndex}/100)`,
    `Policy Summary: ${data.policySummary}`,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    ``,
    `REGULATORY METRICS:`,
    `  • Active Sanctions Actions:    ${data.activeSanctionsActions}`,
    `  • Export Controls / Dual-Use:  ${data.exportBansInEffect}`,
    `  • Active Tariff Disputes:      ${data.tariffDisputes}`,
    `  • Watchlisted Entities Tracked: ${data.designatedEntitiesCount}+`,
    ``,
    `JURISDICTION EXPOSURE MATRIX:`,
  ];

  for (const j of data.jurisdictions) {
    lines.push(`  • [${j.riskLevel.toUpperCase()}] ${j.jurisdiction} (${j.enforcementTrend})`);
    lines.push(`    Focus: ${j.focusArea}`);
    lines.push(`    Assessment: ${j.description}`);
  }

  lines.push(``);
  lines.push(`PRIORITY COMPLIANCE DIRECTIVES:`);
  for (const d of data.directives) {
    lines.push(`  • [${d.urgency}] [${d.targetDomain}]: ${d.action}`);
  }

  lines.push(``);
  lines.push(`ACTIVE REGULATORY MEASURES & RESTRICTIONS:`);
  for (const m of data.measures) {
    lines.push(`  [${m.severity.toUpperCase()}] ${m.title}`);
    lines.push(`  Regime: ${m.regime} | Category: ${m.category} | Effective: ${m.effectiveDate}`);
    lines.push(`  Exposure: ${m.exposureAssessment}`);
    if (m.complianceDirectives?.length) {
      lines.push(`  Mandatory Action:`);
      for (const cd of m.complianceDirectives) {
        lines.push(`    - ${cd}`);
      }
    }
    lines.push(`  Source: ${m.source}`);
    if (m.articleUrl) {
      lines.push(`  Source Article: ${m.articleUrl}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export function getJurisdictionIcon(jurisdiction: string): string {
  const lower = jurisdiction.toLowerCase();
  if (lower.includes("united states") || lower.includes("ofac") || lower.includes("bis")) return "🇺🇸";
  if (lower.includes("european union") || lower.includes("eu")) return "🇪🇺";
  if (lower.includes("china") || lower.includes("mofcom")) return "🇨🇳";
  if (lower.includes("united kingdom") || lower.includes("ofsi") || lower.includes("uk")) return "🇬🇧";
  if (lower.includes("g7") || lower.includes("multilateral")) return "🌐";
  return "⚖️";
}

export function getSanctionSeverityBadgeClass(severity: string): string {
  const lower = severity.toLowerCase();
  if (lower.includes("critical")) return "sanction-badge-critical";
  if (lower.includes("high")) return "sanction-badge-high";
  if (lower.includes("medium") || lower.includes("elevated")) return "sanction-badge-elevated";
  return "sanction-badge-nominal";
}
