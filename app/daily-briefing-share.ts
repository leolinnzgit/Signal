import { createHostedArticleShare, type ArticleShareResult } from "./article-share.ts";
import type { DailyBriefingData } from "./daily-briefing.ts";
import { normalizeBriefingLanguage } from "./daily-briefing-translation.ts";
import { articleNarrationParts } from "./headline-audio.ts";

/**
 * Formats an Executive Daily Briefing into a clean, copy-and-share ready
 * executive digest with weather, market movers, momentum, and numbered story links.
 */
export function formatDailyBriefingDigestText(briefing: DailyBriefingData): string {
  const lines: string[] = [];
  const editionTitle =
    briefing.edition.charAt(0).toUpperCase() + briefing.edition.slice(1);
  lines.push(`🗞️ Signal Executive Daily Briefing (${editionTitle}) — ${briefing.formattedDate}`);
  lines.push("");

  if (briefing.weatherGlance) {
    const w = briefing.weatherGlance;
    const range =
      w.high !== undefined && w.low !== undefined ? ` (H: ${w.high}° / L: ${w.low}°)` : "";
    lines.push(`⛅ Weather: ${w.temperature}°C ${w.condition} in ${w.location}${range}`);
  }

  const watchlist =
    briefing.marketWatchlistGlance && briefing.marketWatchlistGlance.length > 0
      ? briefing.marketWatchlistGlance
      : briefing.marketGlance
        ? [briefing.marketGlance]
        : [];

  if (watchlist.length > 0) {
    const movers = watchlist
      .slice(0, 5)
      .map((m) => {
        const sign = m.percentChange > 0 ? "+" : "";
        return `${m.symbol} ${sign}${m.percentChange.toFixed(2)}% (${m.formattedPrice})`;
      })
      .join(" · ");
    lines.push(`📈 Markets: ${movers}`);
  }

  if (briefing.pulseGlance && briefing.pulseGlance.totalTracked > 0) {
    const p = briefing.pulseGlance;
    const focus = p.topSurgingTopic || `${p.totalTracked} tracked topics`;
    lines.push(`⚡ Momentum: ${focus} (${p.totalMentions} mentions · ${p.sentimentToneLabel})`);
  }

  if (briefing.leadStories.length > 0) {
    lines.push("");
    lines.push("Lead Stories:");
    briefing.leadStories.forEach((story, idx) => {
      const priority = story.priorityTopic ? ` [★ ${story.priorityTopic}]` : "";
      lines.push(`${idx + 1}. [${story.source}]${priority} ${story.title}`);
      if (story.summary) {
        lines.push(`   ${story.summary.trim()}`);
      }
      if (story.url) {
        lines.push(`   ${story.url}`);
      }
    });
  }

  return lines.join("\n").trim();
}

export async function shareOrCopyDailyBriefingDigest(
  briefing: DailyBriefingData,
  target?: {
    share?: (data: { title: string; text: string }) => Promise<void>;
    clipboard?: { writeText: (value: string) => Promise<void> };
  },
): Promise<ArticleShareResult> {
  const nav = target ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const text = formatDailyBriefingDigestText(briefing);
  const editionTitle =
    briefing.edition.charAt(0).toUpperCase() + briefing.edition.slice(1);
  const title = `Signal ${editionTitle} Executive Briefing — ${briefing.formattedDate}`;

  if (nav && typeof nav.share === "function") {
    try {
      await nav.share({ title, text });
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return "cancelled";
      }
    }
  }

  if (nav?.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(text);
      return "copied";
    } catch {
      // Fall through to failed
    }
  }

  return "failed";
}

export async function copyTextToClipboard(
  text: string,
  clipboard?: { writeText: (value: string) => Promise<void> },
): Promise<boolean> {
  const clip =
    clipboard ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clip || typeof clip.writeText !== "function") return false;
  try {
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds structured non-empty paragraphs for publishing an Executive Daily Briefing
 * as a public hosted Signal share page (/shared/<48-hex>) with neural audio playback.
 */
export function buildDailyBriefingShareParagraphs(briefing: DailyBriefingData): string[] {
  const paragraphs: string[] = [];
  paragraphs.push(`${briefing.greeting} — ${briefing.formattedDate}.`);

  if (briefing.weatherGlance) {
    const w = briefing.weatherGlance;
    const hiLo =
      w.high !== undefined && w.low !== undefined ? ` High ${w.high}°C, low ${w.low}°C.` : "";
    paragraphs.push(`Local Weather (${w.location}): ${w.temperature}°C and ${w.condition}.${hiLo}`);
  }

  const watchlist =
    briefing.marketWatchlistGlance && briefing.marketWatchlistGlance.length > 0
      ? briefing.marketWatchlistGlance
      : briefing.marketGlance
        ? [briefing.marketGlance]
        : [];
  if (watchlist.length > 0) {
    const line = watchlist
      .slice(0, 5)
      .map((m) => `${m.name} (${m.symbol}) ${m.percentChange >= 0 ? "+" : ""}${m.percentChange.toFixed(2)}% at ${m.formattedPrice}`)
      .join("; ");
    paragraphs.push(`Market Watchlist: ${line}.`);
  }

  if (briefing.pulseGlance && briefing.pulseGlance.totalTracked > 0) {
    const p = briefing.pulseGlance;
    const focus = p.topSurgingTopic ? `Top surging topic: ${p.topSurgingTopic}. ` : "";
    paragraphs.push(
      `Topic Momentum: ${focus}${p.totalMentions} mentions across ${p.totalTracked} tracked topics (${p.sentimentToneLabel}).`,
    );
  }

  for (const story of briefing.leadStories) {
    const summaryPart = story.summary ? ` — ${story.summary.trim()}` : "";
    paragraphs.push(`[${story.source}] ${story.title}${summaryPart}`);
  }

  if (briefing.spokenScript && paragraphs.length < 3) {
    paragraphs.push(briefing.spokenScript);
  }

  return paragraphs.filter((p) => p.trim().length > 0).slice(0, 40);
}

/**
 * Publishes the Executive Daily Briefing to Signal's hosted /shared/<token> endpoint
 * so recipients can read and play neural audio in their browser.
 */
export async function createHostedDailyBriefingShare(
  params: {
    briefing: DailyBriefingData;
    packId: string;
    language?: string;
    origin?: string;
  },
  fetcher?: typeof fetch,
): Promise<{ url: string; path: string }> {
  const { briefing, packId } = params;
  const language = normalizeBriefingLanguage(params.language);
  const safeSlug = encodeURIComponent((packId || "daily-briefing").replace(/[^a-zA-Z0-9_-]/g, "-"));
  const canonicalUrl = `https://signal.news/briefing/${safeSlug}`;
  const editionTitle =
    briefing.edition.charAt(0).toUpperCase() + briefing.edition.slice(1);
  const title = `Signal ${editionTitle} Executive Briefing — ${briefing.formattedDate}`;
  const paragraphs = buildDailyBriefingShareParagraphs(briefing);
  const summary = paragraphs.slice(0, 2).join(" ").slice(0, 320);

  const created = await createHostedArticleShare(
    {
      url: canonicalUrl,
      title,
      source: "Signal Executive Briefing",
      summary,
      discussionUrl: resolveBriefingWatchHandoffUrl(briefing),
    },
    {
      title,
      paragraphs,
      language,
      byline: "Signal Executive Daily Briefing",
    },
    fetcher as never,
  );

  const origin =
    params.origin ?? (typeof window !== "undefined" && window.location ? window.location.origin : "");
  return {
    path: created.path,
    url: origin ? `${origin}${created.path}` : created.path,
  };
}

function isPublicHttpsUrl(candidate?: string): boolean {
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]" || /^127\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Selects a non-loopback public HTTPS URL for SignalWatch listening handoff validation.
 */
export function resolveBriefingWatchHandoffUrl(briefing: DailyBriefingData): string {
  for (const story of briefing.leadStories) {
    if (isPublicHttpsUrl(story.url)) {
      return story.url;
    }
  }
  return "https://signal.news/daily-briefing";
}

/**
 * Splits the Executive Daily Briefing spoken script into watch-transfer-compliant
 * narration parts (1..190 parts, each <= 900 chars, total <= 19,000 chars).
 */
export function buildBriefingWatchParts(briefing: DailyBriefingData): string[] {
  const rawParts = articleNarrationParts("", [briefing.spokenScript || ""], 800)
    .map((p) => p.trim())
    .filter(Boolean);
  if (rawParts.length === 0) {
    return [`${briefing.greeting}. Signal Executive Briefing for ${briefing.formattedDate}.`];
  }

  const bounded: string[] = [];
  let totalChars = 0;
  for (const part of rawParts) {
    const clipped = part.length <= 950 ? part : part.slice(0, 950).trimEnd();
    if (bounded.length >= 180 || totalChars + clipped.length > 19000) break;
    bounded.push(clipped);
    totalChars += clipped.length;
  }
  return bounded;
}
