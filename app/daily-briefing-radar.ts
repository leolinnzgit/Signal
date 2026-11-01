import type { EntityPulseSummary } from "./entity-pulse.ts";
import type { MarketQuote } from "./market-quote.ts";

export const BRIEFING_VISIT_CHECKPOINT_KEY = "signal:briefing-last-visit:v1";

export type SituationRadarLevel = "calm" | "advisory" | "elevated";

export type RawQuakeEvent = {
  id: string;
  source?: string;
  magnitude: number;
  place: string;
  timeUtc: string;
  latitude?: number;
  longitude?: number;
  depthKm?: number;
  url?: string;
  distanceKm?: number;
};

export type RawDisasterEvent = {
  id: string;
  kind?: string;
  source?: string;
  title: string;
  description?: string;
  alertLevel?: string;
  timeUtc: string;
  endTimeUtc?: string | null;
  latitude?: number;
  longitude?: number;
  url?: string;
  distanceKm?: number | null;
};

export type SituationRadarItem = {
  id: string;
  kind: "earthquake" | "disaster";
  severity: "advisory" | "elevated";
  badge: string;
  title: string;
  detail: string;
  url?: string;
  distanceKm?: number;
};

export type SituationRadarSummary = {
  level: SituationRadarLevel;
  source?: string;
  items: SituationRadarItem[];
  spokenAlert: string | null;
};

export type BriefingVisitCheckpoint = {
  visitedAtIso: string;
  seenArticleUrls: string[];
  surgingTopics: string[];
  marketPrices: Record<string, { price: number; percentChange: number }>;
};

export type CatchUpArticleInput = {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
};

export type CatchUpMarketSwing = {
  symbol: string;
  name: string;
  deltaPercent: number;
  currentPrice: number;
  currency: string;
  directionFlipped: boolean;
};

export type CatchUpDeltaSummary = {
  hasChanges: boolean;
  elapsedLabel: string;
  newStoriesCount: number;
  topNewStories: Array<{ title: string; url: string; source: string }>;
  newlySurgingTopics: string[];
  marketSwings: CatchUpMarketSwing[];
  spokenCatchUp: string | null;
};

export function buildSituationRadar(params: {
  events?: readonly RawQuakeEvent[] | null;
  disasters?: readonly RawDisasterEvent[] | null;
  hasUserLocation?: boolean;
  source?: string;
  now?: Date;
}): SituationRadarSummary {
  const nowMs = (params.now ?? new Date()).getTime();
  const hasLoc = Boolean(params.hasUserLocation);
  const candidates: Array<SituationRadarItem & { sortWeight: number }> = [];

  for (const quake of params.events || []) {
    if (!quake || typeof quake.magnitude !== "number" || !Number.isFinite(quake.magnitude)) continue;
    const tMs = Date.parse(quake.timeUtc);
    if (Number.isFinite(tMs) && nowMs - tMs > 36 * 3600_000) continue;

    const dist =
      hasLoc && typeof quake.distanceKm === "number" && Number.isFinite(quake.distanceKm) && quake.distanceKm > 0
        ? Math.round(quake.distanceKm)
        : undefined;

    const isNearbyNotable = dist !== undefined && dist <= 350 && quake.magnitude >= 3.8;
    const isMajorGlobal = quake.magnitude >= 6.0;
    if (!isNearbyNotable && !isMajorGlobal) continue;

    const isElevated =
      (dist !== undefined && dist <= 200 && quake.magnitude >= 4.8) || quake.magnitude >= 6.5;
    const magFormatted = quake.magnitude.toFixed(1);
    const place = (quake.place || "recorded epicenter").trim();
    const detail =
      dist !== undefined
        ? `${dist} km away${quake.source ? ` · ${quake.source}` : ""}`
        : `Global seismic monitor${quake.source ? ` · ${quake.source}` : ""}`;

    candidates.push({
      id: `quake:${quake.id}`,
      kind: "earthquake",
      severity: isElevated ? "elevated" : "advisory",
      badge: `M${magFormatted}`,
      title: `M${magFormatted} earthquake — ${place}`,
      detail,
      url: quake.url || undefined,
      distanceKm: dist,
      sortWeight: (isElevated ? 1000 : 500) + quake.magnitude * 25 - (dist ?? 600) * 0.2,
    });
  }

  for (const disaster of params.disasters || []) {
    if (!disaster || !disaster.title) continue;
    if (disaster.endTimeUtc) {
      const endMs = Date.parse(disaster.endTimeUtc);
      if (Number.isFinite(endMs) && nowMs - endMs > 24 * 3600_000) continue;
    }

    const levelRaw = (disaster.alertLevel || "").trim().toLowerCase();
    const dist =
      hasLoc && typeof disaster.distanceKm === "number" && Number.isFinite(disaster.distanceKm)
        ? Math.round(disaster.distanceKm)
        : undefined;

    const isRed = levelRaw === "red";
    const isOrange = levelRaw === "orange" && (!hasLoc || dist === undefined || dist <= 2500);
    const isNearbyGreen = levelRaw === "green" && dist !== undefined && dist <= 800;
    if (!isRed && !isOrange && !isNearbyGreen) continue;

    const isElevated = isRed || (levelRaw === "orange" && dist !== undefined && dist <= 1000);
    const badgeLabel = isRed ? "GDACS RED" : levelRaw === "orange" ? "GDACS ORANGE" : "GDACS";
    const detail =
      dist !== undefined
        ? `${dist} km away · ${(disaster.kind || "Hazard").toUpperCase()}`
        : `Active ${(disaster.kind || "GDACS").toUpperCase()} alert`;

    candidates.push({
      id: `disaster:${disaster.id}`,
      kind: "disaster",
      severity: isElevated ? "elevated" : "advisory",
      badge: badgeLabel,
      title: disaster.title.trim(),
      detail,
      url: disaster.url || undefined,
      distanceKm: dist,
      sortWeight: (isElevated ? 950 : 450) - (dist ?? 800) * 0.1,
    });
  }

  if (candidates.length === 0) {
    return {
      level: "calm",
      source: params.source,
      items: [],
      spokenAlert: null,
    };
  }

  candidates.sort((a, b) => b.sortWeight - a.sortWeight);
  const items: SituationRadarItem[] = candidates.slice(0, 4).map(({ sortWeight: _w, ...rest }) => rest);
  const level: SituationRadarLevel = items.some((i) => i.severity === "elevated")
    ? "elevated"
    : "advisory";

  const lead = items[0];
  let spokenLead = "";
  if (lead.kind === "earthquake") {
    const distClause =
      lead.distanceKm !== undefined ? ` ${lead.distanceKm} kilometers away` : "";
    spokenLead = `A ${lead.badge.replace(/^M/, "magnitude ")} earthquake was recorded${distClause} (${lead.title.replace(/^M[\d.]+\s+earthquake\s+—\s+/i, "")})`;
  } else {
    const distClause =
      lead.distanceKm !== undefined ? ` (${lead.distanceKm} kilometers away)` : "";
    spokenLead = `Active ${lead.badge} alert: ${lead.title}${distClause}`;
  }

  const extraCount = items.length - 1;
  const extraClause =
    extraCount > 0
      ? `, plus ${extraCount} other active ${extraCount === 1 ? "advisory" : "advisories"}`
      : "";

  return {
    level,
    source: params.source,
    items,
    spokenAlert: `Live situation radar: ${spokenLead}${extraClause}.`,
  };
}

export async function loadSituationRadarFeed(
  latitude?: number | null,
  longitude?: number | null,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SituationRadarSummary> {
  try {
    const hasCoords =
      typeof latitude === "number" &&
      Number.isFinite(latitude) &&
      typeof longitude === "number" &&
      Number.isFinite(longitude);
    const qs = hasCoords
      ? `?latitude=${encodeURIComponent(String(latitude))}&longitude=${encodeURIComponent(String(longitude))}`
      : "";
    const response = await fetcher(`/api/earthquakes/map-feed${qs}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return { level: "calm", items: [], spokenAlert: null };
    }
    const payload = (await response.json()) as {
      source?: string;
      events?: RawQuakeEvent[];
      disasters?: RawDisasterEvent[];
      userLocation?: { latitude?: number; longitude?: number } | null;
    };
    return buildSituationRadar({
      events: payload?.events,
      disasters: payload?.disasters,
      hasUserLocation: hasCoords || Boolean(payload?.userLocation),
      source: payload?.source,
    });
  } catch {
    return { level: "calm", items: [], spokenAlert: null };
  }
}

export function createVisitCheckpoint(params: {
  articles: readonly CatchUpArticleInput[];
  pulse?: EntityPulseSummary | null;
  marketWatchlist?: readonly MarketQuote[] | null;
  now?: Date;
}): BriefingVisitCheckpoint {
  const visitedAtIso = (params.now ?? new Date()).toISOString();
  const seenArticleUrls: string[] = [];
  for (const article of params.articles || []) {
    if (article?.url && !seenArticleUrls.includes(article.url)) {
      seenArticleUrls.push(article.url);
      if (seenArticleUrls.length >= 250) break;
    }
  }

  const surgingTopics = (params.pulse?.items || [])
    .filter((item) => item.stats.trend === "surging")
    .map((item) => item.topic)
    .slice(0, 30);

  const marketPrices: Record<string, { price: number; percentChange: number }> = {};
  for (const quote of params.marketWatchlist || []) {
    if (!quote?.symbol || !Number.isFinite(quote.price)) continue;
    marketPrices[quote.symbol.trim().toUpperCase()] = {
      price: quote.price,
      percentChange: Number.isFinite(quote.percentChange) ? quote.percentChange : 0,
    };
  }

  return {
    visitedAtIso,
    seenArticleUrls,
    surgingTopics,
    marketPrices,
  };
}

export function loadVisitCheckpoint(
  storage?: Pick<Storage, "getItem"> | null,
): BriefingVisitCheckpoint | null {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return null;
  try {
    const raw = target.getItem(BRIEFING_VISIT_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BriefingVisitCheckpoint>;
    if (!parsed || typeof parsed.visitedAtIso !== "string" || !Number.isFinite(Date.parse(parsed.visitedAtIso))) {
      return null;
    }
    return {
      visitedAtIso: parsed.visitedAtIso,
      seenArticleUrls: Array.isArray(parsed.seenArticleUrls)
        ? parsed.seenArticleUrls.filter((u): u is string => typeof u === "string")
        : [],
      surgingTopics: Array.isArray(parsed.surgingTopics)
        ? parsed.surgingTopics.filter((t): t is string => typeof t === "string")
        : [],
      marketPrices:
        parsed.marketPrices && typeof parsed.marketPrices === "object"
          ? parsed.marketPrices
          : {},
    };
  } catch {
    return null;
  }
}

export function saveVisitCheckpoint(
  checkpoint: BriefingVisitCheckpoint,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return;
  try {
    target.setItem(BRIEFING_VISIT_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch {
    // Ignore quota errors
  }
}

function formatElapsedSince(elapsedMs: number): string {
  const mins = Math.max(1, Math.round(elapsedMs / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function computeCatchUpDelta(
  previous: BriefingVisitCheckpoint | null | undefined,
  current: {
    articles: readonly CatchUpArticleInput[];
    pulse?: EntityPulseSummary | null;
    marketWatchlist?: readonly MarketQuote[] | null;
    now?: Date;
  },
): CatchUpDeltaSummary {
  const empty: CatchUpDeltaSummary = {
    hasChanges: false,
    elapsedLabel: "",
    newStoriesCount: 0,
    topNewStories: [],
    newlySurgingTopics: [],
    marketSwings: [],
    spokenCatchUp: null,
  };
  if (!previous) return empty;

  const prevMs = Date.parse(previous.visitedAtIso);
  const nowMs = (current.now ?? new Date()).getTime();
  if (!Number.isFinite(prevMs) || nowMs - prevMs < 5 * 60_000) {
    return empty;
  }

  const elapsedLabel = formatElapsedSince(nowMs - prevMs);
  const seenUrls = new Set(previous.seenArticleUrls || []);
  const newStories: Array<{ title: string; url: string; source: string }> = [];

  for (const article of current.articles || []) {
    if (!article?.url || !article.title) continue;
    if (seenUrls.has(article.url)) continue;
    newStories.push({
      title: article.title,
      url: article.url,
      source: article.source || "Signal",
    });
  }

  const prevSurgingLower = new Set((previous.surgingTopics || []).map((t) => t.toLowerCase()));
  const newlySurgingTopics: string[] = [];
  for (const item of current.pulse?.items || []) {
    if (item.stats.trend === "surging" && !prevSurgingLower.has(item.topic.toLowerCase())) {
      newlySurgingTopics.push(item.topic);
      if (newlySurgingTopics.length >= 3) break;
    }
  }

  const marketSwings: CatchUpMarketSwing[] = [];
  const prevMarkets = previous.marketPrices || {};
  for (const quote of current.marketWatchlist || []) {
    if (!quote?.symbol || !Number.isFinite(quote.price) || quote.price <= 0) continue;
    const sym = quote.symbol.trim().toUpperCase();
    const prev = prevMarkets[sym];
    if (!prev || !Number.isFinite(prev.price) || prev.price <= 0) continue;

    const deltaPct = ((quote.price - prev.price) / prev.price) * 100;
    const flipped =
      prev.percentChange * quote.percentChange < 0 &&
      Math.abs(quote.percentChange - prev.percentChange) >= 1.5;

    if (Math.abs(deltaPct) >= 1.0 || flipped) {
      marketSwings.push({
        symbol: sym,
        name: quote.name || sym,
        deltaPercent: Math.round(deltaPct * 100) / 100,
        currentPrice: quote.price,
        currency: quote.currency || "USD",
        directionFlipped: flipped,
      });
    }
  }

  marketSwings.sort((a, b) => Math.abs(b.deltaPercent) - Math.abs(a.deltaPercent));
  const topSwings = marketSwings.slice(0, 3);
  const hasChanges =
    newStories.length > 0 || newlySurgingTopics.length > 0 || topSwings.length > 0;

  if (!hasChanges) return empty;

  const clauses: string[] = [];
  if (newStories.length > 0) {
    clauses.push(
      `${newStories.length} new ${newStories.length === 1 ? "story has" : "stories have"} arrived`,
    );
  }
  if (newlySurgingTopics.length > 0) {
    clauses.push(
      `${newlySurgingTopics.join(" and ")} ${newlySurgingTopics.length === 1 ? "is" : "are"} newly surging`,
    );
  }
  if (topSwings.length > 0) {
    const leadSwing = topSwings[0];
    const dir = leadSwing.deltaPercent >= 0 ? "climbed" : "slipped";
    clauses.push(`${leadSwing.symbol} ${dir} ${Math.abs(leadSwing.deltaPercent).toFixed(1)} percent`);
  }

  return {
    hasChanges: true,
    elapsedLabel,
    newStoriesCount: newStories.length,
    topNewStories: newStories.slice(0, 3),
    newlySurgingTopics,
    marketSwings: topSwings,
    spokenCatchUp: `Since your last visit (${elapsedLabel}), ${clauses.join(", ")}.`,
  };
}
