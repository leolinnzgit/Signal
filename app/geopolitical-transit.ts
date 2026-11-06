/**
 * Geopolitical Transit & Airspace Watch ("Signal Sky & Sea") Client Engine
 * Models maritime straits, vessel density, detour calculations, and NOTAM air advisories.
 */

export interface ChokepointZone {
  id: string;
  name: string;
  region: string;
  coordinates: [number, number]; // [lat, lon]
  threatLevel: "Normal" | "Elevated" | "High" | "Critical";
  dailyTeuVolume: number;
  dailyOilBarrelsMbpd: number;
  detourDays: number;
  fuelCostDeltaPercent: number;
  airspaceStatus: "Open" | "Advisory" | "Restricted" | "Closed";
  keyCommodities: string[];
  activeNotams: string[];
  strategicBrief: string;
}

export interface AirspaceAdvisory {
  zoneId: string;
  regionName: string;
  flightLevelFloor: string;
  issuingAuthority: string;
  hazardType: string;
  commercialRerouteCostIndex: number;
}

export interface TransitCorrelatedArticle {
  title: string;
  source: string;
  url: string;
  relevance: string;
}

export interface TransitAssessmentResponse {
  chokepointId: string;
  name: string;
  riskScore: number;
  statusDescription: string;
  alternativeRoute: string;
  estimatedDailyTradeDisruptionUsd: string;
  executiveActionItems: string[];
  correlatedArticles: TransitCorrelatedArticle[];
  assessedAt: string;
}

/**
 * Projects latitude (-90 to +90) and longitude (-180 to +180) to Equirectangular SVG canvas coords
 */
export function projectCoordinatesToSvg(
  lat: number,
  lon: number,
  svgWidth = 800,
  svgHeight = 400
): { x: number; y: number } {
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const clampedLon = Math.max(-180, Math.min(180, lon));
  const x = ((clampedLon + 180) / 360) * svgWidth;
  const y = ((85 - clampedLat) / 170) * svgHeight;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/**
 * Returns severity color and glow for a given threat posture
 */
export function getThreatColor(threat: ChokepointZone["threatLevel"]): {
  fill: string;
  stroke: string;
  badgeClass: string;
} {
  switch (threat) {
    case "Critical":
      return { fill: "#ef4444", stroke: "rgba(239, 68, 68, 0.4)", badgeClass: "threat-critical" };
    case "High":
      return { fill: "#f97316", stroke: "rgba(249, 115, 22, 0.4)", badgeClass: "threat-high" };
    case "Elevated":
      return { fill: "#eab308", stroke: "rgba(234, 179, 8, 0.4)", badgeClass: "threat-elevated" };
    default:
      return { fill: "#10b981", stroke: "rgba(16, 185, 129, 0.4)", badgeClass: "threat-normal" };
  }
}

/**
 * Formats a strategic memo for executive export
 */
export function formatTransitMemo(
  chokepoint: ChokepointZone,
  assessment: TransitAssessmentResponse
): string {
  const timestamp = new Date().toUTCString();
  return `# SIGNAL GEOPOLITICAL TRANSIT BRIEFING
Generated: ${timestamp}
Corridor: ${chokepoint.name} (${chokepoint.region})
Current Threat Posture: ${chokepoint.threatLevel.toUpperCase()}
Calculated Transit Risk Score: ${assessment.riskScore}/100

## Trade Disruption Metrics
- Daily Container Volume: ${chokepoint.dailyTeuVolume.toLocaleString()} TEU
- Daily Hydrocarbon Flow: ${chokepoint.dailyOilBarrelsMbpd} Mbpd
- Detour Impact: +${chokepoint.detourDays} days transit penalty
- Bunker Fuel Variance: +${chokepoint.fuelCostDeltaPercent}%
- Estimated Daily Trade Value At Risk: ${assessment.estimatedDailyTradeDisruptionUsd}

## Airspace & Flight Routing
- Status: ${chokepoint.airspaceStatus}
- Active NOTAM Advisories:
${chokepoint.activeNotams.map((n) => `  * ${n}`).join("\n")}

## Recommended Alternative Route
${assessment.alternativeRoute}

## Actionable Directives
${assessment.executiveActionItems.map((a, i) => `${i + 1}. ${a}`).join("\n")}

---
CONFIDENTIAL - SIGNAL EXECUTIVE STRATEGIC INTELLIGENCE`;
}

/**
 * Client API fetchers
 */
export async function fetchChokepoints(): Promise<ChokepointZone[]> {
  const res = await fetch("/api/geopolitical-transit/chokepoints", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load chokepoints: HTTP ${res.status}`);
  return res.json();
}

export async function fetchAirspaceAdvisories(): Promise<AirspaceAdvisory[]> {
  const res = await fetch("/api/geopolitical-transit/airspace-advisories", {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Failed to load airspace advisories: HTTP ${res.status}`);
  return res.json();
}

export async function assessChokepointTransit(
  chokepointId: string,
  articles?: TransitCorrelatedArticle[]
): Promise<TransitAssessmentResponse> {
  const res = await fetch("/api/geopolitical-transit/assess", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ chokepointId, articles: articles ?? [] }),
  });
  if (!res.ok) throw new Error(`Failed to assess transit: HTTP ${res.status}`);
  return res.json();
}
