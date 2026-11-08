/**
 * Executive Tripwires & Deep-Linked Push Alerts Engine (Suite #28)
 * Manages keyword trigger rules backed by SQLite (when signed in) or localStorage (guest),
 * evaluates breaking headlines against rules, and builds deep links (`/?suite=...&focus=...`).
 */

export type TripwireSeverity = "Critical" | "High" | "Elevated" | string;

export interface ExecutiveTripwire {
  id: string;
  name: string;
  keywords: string[];
  targetSuiteId: string;
  targetEntityId: string;
  severity: TripwireSeverity;
  enabled: boolean;
  pushOnMatch: boolean;
  triggerCount: number;
  lastTriggeredAtUtc: string | null;
  lastMatchedTitle: string;
  lastMatchedUrl: string;
  deepLinkUrl: string;
}

export interface TripwireUpsertInput {
  id?: string;
  name: string;
  keywords: string[];
  targetSuiteId: string;
  targetEntityId?: string;
  severity: TripwireSeverity;
  enabled?: boolean;
  pushOnMatch?: boolean;
}

export interface TripwireArticleInput {
  title: string;
  url: string;
  source: string;
  summary?: string;
  topics?: string[];
}

export interface TripwireMatchResult {
  tripwireId: string;
  tripwireName: string;
  severity: string;
  targetSuiteId: string;
  targetEntityId: string;
  deepLinkUrl: string;
  matchedKeywords: string[];
  matchedTitle: string;
  matchedUrl: string;
  matchedSource: string;
}

export interface TripwiresStateResponse {
  authenticated: boolean;
  tripwires: ExecutiveTripwire[];
  presets: ExecutiveTripwire[];
}

export interface TripwireEvaluateResponse {
  evaluatedArticles: number;
  evaluatedRules: number;
  matches: TripwireMatchResult[];
  evaluatedAt: string;
}

export const TRIPWIRE_SUITE_DESTINATIONS: Array<{ id: string; label: string; hintFocus?: string }> = [
  { id: "geopolitical-transit", label: "Signal Sky & Sea (Straits)", hintFocus: "red-sea" },
  { id: "sovereign-risk", label: "Sovereign Risk & Debt Stress", hintFocus: "argentina" },
  { id: "pre-mortem", label: "Corporate Pre-Mortem Simulator", hintFocus: "ai-cloud-migration" },
  { id: "tariff-matrix", label: "Global Tariff & Supply Arbitrage", hintFocus: "semiconductors" },
  { id: "cyber-incident", label: "Cyber Threat Radar", hintFocus: "edge-infrastructure" },
  { id: "radar", label: "Executive Radar" },
  { id: "sanctions-radar", label: "Sanctions & Tariffs Radar" },
  { id: "supply-chain", label: "Supply Chain Tracker" },
  { id: "regulatory-radar", label: "Regulatory Horizon" },
  { id: "competitor-radar", label: "Competitor Radar & M&A" },
  { id: "crisis-war-room", label: "Crisis War Room" },
  { id: "daily-cast", label: "Signal Studio Daily Cast" },
  { id: "signal-cortex", label: "Signal Cortex (Second Brain)" },
];

export const DEFAULT_TRIPWIRE_PRESETS: ExecutiveTripwire[] = [
  {
    id: "preset-red-sea-chokepoint",
    name: "Red Sea & Hormuz Transit Disruption",
    keywords: ["red sea", "hormuz", "bab el-mandeb", "cape of good hope", "suez", "reroute"],
    targetSuiteId: "geopolitical-transit",
    targetEntityId: "red-sea",
    severity: "Critical",
    enabled: true,
    pushOnMatch: true,
    triggerCount: 0,
    lastTriggeredAtUtc: null,
    lastMatchedTitle: "",
    lastMatchedUrl: "",
    deepLinkUrl: "/?suite=geopolitical-transit&focus=red-sea",
  },
  {
    id: "preset-sovereign-argentina-egp",
    name: "EM Sovereign Debt & FX Controls Shock",
    keywords: ["argentina", "cepo", "peso", "egypt", "pound", "imf bailout", "sovereign default", "devaluation"],
    targetSuiteId: "sovereign-risk",
    targetEntityId: "argentina",
    severity: "High",
    enabled: true,
    pushOnMatch: true,
    triggerCount: 0,
    lastTriggeredAtUtc: null,
    lastMatchedTitle: "",
    lastMatchedUrl: "",
    deepLinkUrl: "/?suite=sovereign-risk&focus=argentina",
  },
  {
    id: "preset-premortem-ai-compliance",
    name: "Pre-Mortem EWI: AI Regulatory Injunction",
    keywords: ["eu ai act", "ai liability", "algorithmic injunction", "model audit", "ftc inquiry", "antitrust"],
    targetSuiteId: "pre-mortem",
    targetEntityId: "ai-cloud-migration",
    severity: "High",
    enabled: true,
    pushOnMatch: true,
    triggerCount: 0,
    lastTriggeredAtUtc: null,
    lastMatchedTitle: "",
    lastMatchedUrl: "",
    deepLinkUrl: "/?suite=pre-mortem&focus=ai-cloud-migration",
  },
  {
    id: "preset-tariff-silicon-export",
    name: "Section 301 & Semiconductor Tariff Shock",
    keywords: ["section 301", "tariff", "bis export", "asml", "euv", "tsmc", "rare earth", "gallium"],
    targetSuiteId: "tariff-matrix",
    targetEntityId: "semiconductors",
    severity: "Critical",
    enabled: true,
    pushOnMatch: true,
    triggerCount: 0,
    lastTriggeredAtUtc: null,
    lastMatchedTitle: "",
    lastMatchedUrl: "",
    deepLinkUrl: "/?suite=tariff-matrix&focus=semiconductors",
  },
  {
    id: "preset-cyber-edge-zeroday",
    name: "CISA Zero-Day & Ransomware Infrastructure Alert",
    keywords: ["zero-day", "cisa", "kev", "ransomware", "cve-2026", "edge gateway", "wiper"],
    targetSuiteId: "cyber-incident",
    targetEntityId: "edge-infrastructure",
    severity: "Critical",
    enabled: true,
    pushOnMatch: true,
    triggerCount: 0,
    lastTriggeredAtUtc: null,
    lastMatchedTitle: "",
    lastMatchedUrl: "",
    deepLinkUrl: "/?suite=cyber-incident&focus=edge-infrastructure",
  },
];

const LOCAL_STORAGE_KEY = "signal_executive_tripwires_v1";

export function buildTripwireDeepLink(targetSuiteId: string, targetEntityId?: string): string {
  const suite = encodeURIComponent((targetSuiteId || "tripwires").trim() || "tripwires");
  const focus = (targetEntityId || "").trim();
  if (!focus) return `/?suite=${suite}`;
  return `/?suite=${suite}&focus=${encodeURIComponent(focus)}`;
}

export function loadLocalTripwires(
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): ExecutiveTripwire[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ExecutiveTripwire => Boolean(item && typeof item.id === "string" && typeof item.name === "string"));
  } catch {
    return [];
  }
}

export function saveLocalTripwires(
  rules: ExecutiveTripwire[],
  storage: Pick<Storage, "setItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): void {
  if (!storage) return;
  try {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(rules));
  } catch {
    // Ignore storage quota errors
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function evaluateTripwiresLocally(
  articles: TripwireArticleInput[],
  rules: ExecutiveTripwire[],
): TripwireMatchResult[] {
  const matches: TripwireMatchResult[] = [];
  const activeRules = rules.filter((r) => r.enabled && r.keywords.length > 0);
  if (activeRules.length === 0 || articles.length === 0) return matches;

  for (const rule of activeRules) {
    for (const art of articles) {
      const haystack = `${art.title || ""} ${art.summary || ""} ${(art.topics || []).join(" ")}`.trim();
      if (!haystack) continue;
      const matchedKeywords = rule.keywords.filter((kw) => {
        const clean = kw.trim();
        if (clean.length < 2) return false;
        const regex = new RegExp(`\\b${escapeRegExp(clean)}\\b`, "i");
        return regex.test(haystack);
      });
      if (matchedKeywords.length > 0) {
        matches.push({
          tripwireId: rule.id,
          tripwireName: rule.name,
          severity: rule.severity,
          targetSuiteId: rule.targetSuiteId,
          targetEntityId: rule.targetEntityId || "",
          deepLinkUrl: buildTripwireDeepLink(rule.targetSuiteId, rule.targetEntityId),
          matchedKeywords,
          matchedTitle: art.title,
          matchedUrl: art.url,
          matchedSource: art.source || "Wire",
        });
        break;
      }
    }
  }

  return matches;
}

async function getCsrfToken(fetcher: typeof fetch): Promise<string | null> {
  try {
    const res = await fetcher("/api/auth/csrf", { credentials: "same-origin" });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    return data.token || null;
  } catch {
    return null;
  }
}

export async function fetchTripwiresState(
  fetcher: typeof fetch = fetch,
  storage: Pick<Storage, "getItem"> | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<TripwiresStateResponse> {
  try {
    const res = await fetcher("/api/tripwires", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = (await res.json()) as TripwiresStateResponse;
    if (!payload.authenticated) {
      return {
        authenticated: false,
        tripwires: loadLocalTripwires(storage),
        presets: payload.presets?.length ? payload.presets : DEFAULT_TRIPWIRE_PRESETS,
      };
    }
    return payload;
  } catch {
    return {
      authenticated: false,
      tripwires: loadLocalTripwires(storage),
      presets: DEFAULT_TRIPWIRE_PRESETS,
    };
  }
}

export async function saveTripwireRule(
  input: TripwireUpsertInput,
  authenticated: boolean,
  fetcher: typeof fetch = fetch,
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<ExecutiveTripwire> {
  const cleanKeywords = Array.from(
    new Set(
      input.keywords
        .map((k) => k.trim())
        .filter((k) => k.length >= 2 && k.length <= 60),
    ),
  ).slice(0, 12);

  if (authenticated) {
    const token = await getCsrfToken(fetcher);
    const res = await fetcher("/api/tripwires", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify({
        ...input,
        keywords: cleanKeywords,
      }),
    });
    if (res.ok) {
      return (await res.json()) as ExecutiveTripwire;
    }
    if (res.status !== 401) {
      const errBody = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(errBody.error || `Failed to save tripwire: HTTP ${res.status}`);
    }
  }

  // Guest / unauthenticated localStorage persistence
  const existing = loadLocalTripwires(storage);
  const id = input.id && input.id.trim().length > 0 ? input.id.trim() : `tw-local-${Date.now()}`;
  const prev = existing.find((item) => item.id === id);
  const targetSuiteId = input.targetSuiteId || "radar";
  const targetEntityId = (input.targetEntityId || "").trim();
  const saved: ExecutiveTripwire = {
    id,
    name: input.name.trim(),
    keywords: cleanKeywords,
    targetSuiteId,
    targetEntityId,
    severity: input.severity || "High",
    enabled: input.enabled ?? true,
    pushOnMatch: input.pushOnMatch ?? true,
    triggerCount: prev?.triggerCount ?? 0,
    lastTriggeredAtUtc: prev?.lastTriggeredAtUtc ?? null,
    lastMatchedTitle: prev?.lastMatchedTitle ?? "",
    lastMatchedUrl: prev?.lastMatchedUrl ?? "",
    deepLinkUrl: buildTripwireDeepLink(targetSuiteId, targetEntityId),
  };

  const next = prev
    ? existing.map((item) => (item.id === id ? saved : item))
    : [saved, ...existing];
  saveLocalTripwires(next, storage);
  return saved;
}

export async function deleteTripwireRule(
  id: string,
  authenticated: boolean,
  fetcher: typeof fetch = fetch,
  storage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<void> {
  if (authenticated) {
    const token = await getCsrfToken(fetcher);
    const res = await fetcher(`/api/tripwires/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
      headers: token ? { "X-XSRF-TOKEN": token } : undefined,
    });
    if (res.ok || res.status === 404) return;
    if (res.status !== 401) {
      throw new Error(`Failed to delete tripwire: HTTP ${res.status}`);
    }
  }

  const existing = loadLocalTripwires(storage);
  saveLocalTripwires(
    existing.filter((item) => item.id !== id),
    storage,
  );
}

export async function evaluateTripwires(
  articles: TripwireArticleInput[],
  rules: ExecutiveTripwire[],
  fetcher: typeof fetch = fetch,
): Promise<TripwireEvaluateResponse> {
  try {
    const res = await fetcher("/api/tripwires/evaluate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        articles: articles.slice(0, 120),
        rules: rules.map((r) => ({
          id: r.id,
          name: r.name,
          keywords: r.keywords,
          targetSuiteId: r.targetSuiteId,
          targetEntityId: r.targetEntityId,
          severity: r.severity,
          enabled: r.enabled,
        })),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as TripwireEvaluateResponse;
  } catch {
    return {
      evaluatedArticles: articles.length,
      evaluatedRules: rules.filter((r) => r.enabled).length,
      matches: evaluateTripwiresLocally(articles, rules),
      evaluatedAt: new Date().toISOString(),
    };
  }
}

export function formatTripwiresDigest(
  tripwires: ExecutiveTripwire[],
  matches: TripwireMatchResult[],
): string {
  const date = new Date().toUTCString();
  return `# SIGNAL EXECUTIVE TRIPWIRES & PROACTIVE ESCALATION LOG
Generated: ${date}
Active Monitors: ${tripwires.filter((t) => t.enabled).length} / ${tripwires.length}
Live Wire Detections: ${matches.length}

## Configured Tripwires
${tripwires.length === 0
  ? "- No custom tripwires configured."
  : tripwires
      .map(
        (t) =>
          `- **[${t.severity}] ${t.name}** (${t.enabled ? "Active" : "Paused"}) -> \`${t.deepLinkUrl}\`
  Keywords: ${t.keywords.join(", ")} | Triggers: ${t.triggerCount}`,
      )
      .join("\n")}

## Live Feed Matches
${matches.length === 0
  ? "- No matching headlines in the current feed scan."
  : matches
      .map(
        (m, idx) =>
          `### ${idx + 1}. [${m.severity}] ${m.tripwireName}
- Headline: ${m.matchedTitle} (${m.matchedSource})
- Matched Keywords: ${m.matchedKeywords.join(", ")}
- Suite Deep Link: ${m.deepLinkUrl}`,
      )
      .join("\n\n")}

---
CONFIDENTIAL - SIGNAL EXECUTIVE TRIPWIRE ENGINE`;
}
