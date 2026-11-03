// Executive Supply Chain & Geopolitical Trade Chokepoint Tracker

export interface ChokepointIncident {
  headline: string;
  date: string;
  source: string;
  severity: "Critical" | "High" | "Moderate" | "Low";
}

export interface Chokepoint {
  id: string;
  name: string;
  region: string;
  latitude: number;
  longitude: number;
  status: "Disrupted" | "Restricted" | "Watch" | "Normal";
  riskScore: number;
  dailyVolumeShare: string;
  primaryHazards: string[];
  alternativeRoute: string;
  extraTransitDays: number;
  impactedCommodities: string[];
  incidents: ChokepointIncident[];
}

export interface CarrierAlert {
  carrier: string;
  action: string;
  impactedRoute: string;
  effectiveDate: string;
  surcharge: string;
}

export interface ExposureBreakdown {
  energyAndFuel: number;
  electronicsAndChips: number;
  agriCommodities: number;
  freightAndTransit: number;
}

export interface SupplyChainResponse {
  available: boolean;
  compositeExposureIndex: number;
  exposureLabel: string;
  exposure: ExposureBreakdown;
  chokepoints: Chokepoint[];
  carrierAlerts: CarrierAlert[];
  spokenAudioScript: string;
  generatedAt: string;
}

export interface FetchSupplyChainOptions {
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  signal?: AbortSignal;
}

export async function fetchSupplyChainStatus(
  options?: FetchSupplyChainOptions,
  fetcher: typeof fetch = fetch
): Promise<SupplyChainResponse> {
  const hasArticles = options?.articles && options.articles.length > 0;
  const endpoint = hasArticles ? "/api/supply-chain/analyze" : "/api/supply-chain/status";
  const method = hasArticles ? "POST" : "GET";

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (hasArticles) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetcher(endpoint, {
    method,
    headers,
    body: hasArticles ? JSON.stringify({ articles: options?.articles }) : undefined,
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load supply chain status: HTTP ${response.status}`);
  }

  return (await response.json()) as SupplyChainResponse;
}

export function formatSupplyChainDigest(data: SupplyChainResponse): string {
  const lines: string[] = [
    `🚢 EXECUTIVE SUPPLY CHAIN & TRADE CHOKEPOINT RADAR`,
    `Global Maritime Exposure: ${data.compositeExposureIndex}/100 — ${data.exposureLabel}`,
    `Generated: ${new Date(data.generatedAt).toLocaleString()}`,
    ``,
    `SECTOR EXPOSURE VULNERABILITY:`,
    `  • Freight & Transit Delay: ${data.exposure.freightAndTransit}/100`,
    `  • Energy & Crude/LNG:       ${data.exposure.energyAndFuel}/100`,
    `  • Semiconductors & Tech:    ${data.exposure.electronicsAndChips}/100`,
    `  • Agricultural Harvest:     ${data.exposure.agriCommodities}/100`,
    ``,
    `KEY MARITIME BOTTLENECK CORRIDORS:`,
  ];

  for (const c of data.chokepoints) {
    lines.push(
      `[${c.status.toUpperCase()}] ${c.name} (${c.region}) — Risk: ${c.riskScore}/100`,
      `  • Daily Volume: ${c.dailyVolumeShare}`,
      `  • Primary Hazards: ${c.primaryHazards.join(", ")}`,
      `  • Re-routing: ${c.alternativeRoute} (+${c.extraTransitDays} days)`,
      `  • Impacted: ${c.impactedCommodities.join(", ")}`
    );
    if (c.incidents && c.incidents.length > 0) {
      lines.push(`  • Latest Intel: ${c.incidents[0].headline} (${c.incidents[0].source})`);
    }
    lines.push(``);
  }

  lines.push(`CARRIER ADVISORIES & CONTINGENCY ACTIONS:`);
  for (const a of data.carrierAlerts) {
    lines.push(`  • ${a.carrier}: ${a.action} [${a.impactedRoute}] — ${a.surcharge}`);
  }

  return lines.join("\n");
}
