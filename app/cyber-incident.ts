// Cyber Warfare & Critical Infrastructure Incident HUD (CISO Radar)

export interface SectorImpact {
  sector: string;
  riskLevel: "Critical" | "High" | "Elevated" | "Normal";
  threatVector: string;
  trend: "Escalating" | "Elevated" | "Stable" | "De-escalating";
  activeThreats: number;
  description: string;
}

export interface CyberIncident {
  id: string;
  title: string;
  threatActor: string;
  cve: string;
  category: "Zero-Day Exploit" | "Nation-State APT" | "Ransomware & Extortion" | "Critical Infrastructure" | "Cloud & Telecom Outage" | "Supply Chain Vulnerability";
  severity: "Critical" | "High" | "Medium" | "Low";
  affectedSystems: string[];
  impactAssessment: string;
  mitigationDirectives: string[];
  source: string;
  timestamp: string;
  articleUrl?: string;
}

export interface ExecutiveMitigation {
  urgency: string;
  action: string;
  targetDomain: string;
}

export interface CyberIncidentResponse {
  available: boolean;
  defconLevel: string;
  compositeThreatIndex: number;
  threatSummary: string;
  activeZeroDays: number;
  activeAptCampaigns: number;
  ransomwareSurges: number;
  criticalOutages: number;
  sectors: SectorImpact[];
  incidents: CyberIncident[];
  mitigations: ExecutiveMitigation[];
  spokenAudioScript: string;
  generatedAt: string;
}

export interface FetchCyberIncidentOptions {
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  signal?: AbortSignal;
}

export async function fetchCyberIncidentStatus(
  options?: FetchCyberIncidentOptions,
  fetcher: typeof fetch = fetch
): Promise<CyberIncidentResponse> {
  const hasArticles = options?.articles && options.articles.length > 0;
  const endpoint = hasArticles ? "/api/cyber-incident-hud/analyze" : "/api/cyber-incident-hud/status";
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
    throw new Error(`Failed to load cyber incident status: HTTP ${response.status}`);
  }

  return (await response.json()) as CyberIncidentResponse;
}

export function formatCyberIncidentDigest(data: CyberIncidentResponse): string {
  const lines: string[] = [
    `⚡ SIGNAL CISO CYBER THREAT RADAR & INCIDENT COMMAND HUD`,
    `Current Posture: ${data.defconLevel} (Risk Index: ${data.compositeThreatIndex}/100)`,
    `Threat Summary: ${data.threatSummary}`,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    ``,
    `THREAT METRICS:`,
    `  • Active Zero-Days in Wild:   ${data.activeZeroDays}`,
    `  • Nation-State APT Campaigns: ${data.activeAptCampaigns}`,
    `  • Extortion/Ransomware Waves: ${data.ransomwareSurges}`,
    `  • Critical Infra Outages:     ${data.criticalOutages}`,
    ``,
    `SECTOR EXPOSURE MATRIX:`,
  ];

  for (const s of data.sectors) {
    lines.push(`  • [${s.riskLevel.toUpperCase()}] ${s.sector} (${s.trend})`);
    lines.push(`    Vector: ${s.threatVector}`);
    lines.push(`    Status: ${s.description}`);
  }

  lines.push(``);
  lines.push(`PRIORITY DEFENSE DIRECTIVES:`);
  for (const m of data.mitigations) {
    lines.push(`  • [${m.urgency}] [${m.targetDomain}]: ${m.action}`);
  }

  lines.push(``);
  lines.push(`ACTIVE CYBER & INFRASTRUCTURE INCIDENTS:`);
  for (const inc of data.incidents) {
    lines.push(`  [${inc.severity.toUpperCase()}] ${inc.title}`);
    lines.push(`  Actor: ${inc.threatActor} | Identifier: ${inc.cve} | Category: ${inc.category}`);
    lines.push(`  Impact: ${inc.impactAssessment}`);
    if (inc.mitigationDirectives?.length) {
      lines.push(`  Immediate Actions:`);
      for (const act of inc.mitigationDirectives) {
        lines.push(`    - ${act}`);
      }
    }
    lines.push(`  Source: ${inc.source} (${inc.timestamp})`);
    if (inc.articleUrl) {
      lines.push(`  Story URL: ${inc.articleUrl}`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export function getSectorIcon(sector: string): string {
  const lower = sector.toLowerCase();
  if (lower.includes("cloud") || lower.includes("telecom")) return "☁️";
  if (lower.includes("energy") || lower.includes("grid") || lower.includes("scada")) return "⚡";
  if (lower.includes("financial") || lower.includes("payment")) return "🏦";
  if (lower.includes("healthcare") || lower.includes("med")) return "🏥";
  if (lower.includes("defense") || lower.includes("aerospace")) return "🛡️";
  if (lower.includes("government") || lower.includes("public")) return "🏛️";
  return "🔒";
}

export function getSeverityBadgeClass(severity: string): string {
  const lower = severity.toLowerCase();
  if (lower.includes("critical")) return "cyber-badge-critical";
  if (lower.includes("high")) return "cyber-badge-high";
  if (lower.includes("medium") || lower.includes("elevated")) return "cyber-badge-elevated";
  return "cyber-badge-nominal";
}
