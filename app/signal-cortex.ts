/**
 * Signal Cortex (Unified Semantic Search & Executive Second Brain) Client Engine
 * Provides cross-suite query synthesis, multi-corpus ranking, and deep jump links.
 */

export interface CortexArticleInput {
  title: string;
  source: string;
  url: string;
  summary?: string;
}

export interface CortexHit {
  id: string;
  title: string;
  domain: string;
  snippet: string;
  relevanceScore: number;
  targetSuiteId: string;
  url?: string;
}

export interface CortexSearchResponse {
  query: string;
  synthesizedAnswer: string;
  confidence: number;
  crossDomainHits: CortexHit[];
  suggestedQueries: string[];
  executedAt: string;
}

/**
 * Returns distinct badge styling per intelligence domain
 */
export function getDomainBadgeClass(domain: string): { label: string; badgeClass: string } {
  switch (domain) {
    case "Chokepoints & Straits":
      return { label: "🌊 STRAITS", badgeClass: "domain-chokepoint" };
    case "Tariff & Arbitrage":
      return { label: "📊 TARIFFS", badgeClass: "domain-tariff" };
    case "Cyber Incident":
      return { label: "⚡ CYBER", badgeClass: "domain-cyber" };
    case "Boardroom Sparring":
      return { label: "🤺 SPARRING", badgeClass: "domain-sparring" };
    case "Competitor Radar":
      return { label: "🎯 COMPETITOR", badgeClass: "domain-competitor" };
    default:
      return { label: "🗞️ WIRE", badgeClass: "domain-news" };
  }
}

/**
 * Formats Cortex search response into a structured executive memo
 */
export function formatCortexDigest(query: string, res: CortexSearchResponse): string {
  const timestamp = new Date().toUTCString();
  return `# SIGNAL CORTEX INTELLIGENCE SYNTHESIS
Query: "${query}"
Generated: ${timestamp}
Confidence Score: ${Math.round(res.confidence * 100)}%

## Executive Synthesis
${res.synthesizedAnswer}

## Identified Cross-Domain Intelligence (${res.crossDomainHits.length} sources)
${res.crossDomainHits
  .map(
    (h, idx) =>
      `### ${idx + 1}. [${h.domain}] ${h.title} (Relevance: ${Math.round(h.relevanceScore * 100)}%)
${h.snippet}
Target Suite: ${h.targetSuiteId}`
  )
  .join("\n\n")}

---
CONFIDENTIAL - SIGNAL EXECUTIVE CORTEX`;
}

/**
 * Client API fetcher
 */
export async function searchSignalCortex(
  query: string,
  articles?: CortexArticleInput[]
): Promise<CortexSearchResponse> {
  const res = await fetch("/api/cortex/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, articles: articles ?? [] }),
  });
  if (!res.ok) throw new Error(`Cortex query failed: HTTP ${res.status}`);
  return res.json();
}
