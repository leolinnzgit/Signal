import { topicMatchesText } from "./api/news/topic-matching.ts";
import type { DailyBriefingData, DailyBriefingStory } from "./daily-briefing.ts";
import { normalizeBriefingLanguage } from "./daily-briefing-translation.ts";

export type BriefingQaCitation = {
  url: string;
  title: string;
  source: string;
};

export type BriefingQaResult = {
  available: boolean;
  answer: string;
  mode: "azure-ai" | "extractive" | "offline-local" | "empty";
  citations: BriefingQaCitation[];
  language: string;
};

const STOP_WORDS = new Set([
  "about", "after", "any", "are", "briefing", "can", "could", "daily", "did",
  "does", "executive", "for", "from", "give", "happening", "has", "have", "how",
  "into", "latest", "main", "more", "most", "news", "now", "our", "please",
  "report", "reporting", "say", "says", "some", "stories", "story", "summarize",
  "summary", "tell", "that", "the", "their", "them", "there", "these", "they",
  "this", "today", "todays", "top", "update", "updates", "what", "whats", "when",
  "where", "which", "who", "why", "will", "with", "would", "your",
]);

const WEATHER_REGEX =
  /\b(?:weather|rain|raining|temperature|forecast|wind|uv|alert|umbrella|sunny|cloud|cloudy|storm|cold|warm|hot|degrees)\b/i;
const MARKET_REGEX =
  /\b(?:market|markets|stock|stocks|price|prices|ticker|tickers|index|share|shares|gain|drop|mover|movers|trading|nasdaq|dow|nzx|nyse|sp500|s&p)\b/i;
const PULSE_REGEX =
  /\b(?:pulse|surging|trend|trending|momentum|topic|topics|mood|tone|focus|coverage)\b/i;

export function buildBriefingContextStrings(briefing: DailyBriefingData): {
  weatherContext: string;
  marketContext: string;
  pulseContext: string;
} {
  let weatherContext = "";
  if (briefing.weatherGlance) {
    const w = briefing.weatherGlance;
    weatherContext = `In ${w.location}, it is ${w.temperature}°C and ${w.condition}`;
    if (w.high !== undefined && w.low !== undefined) {
      weatherContext += ` (High ${w.high}°C, Low ${w.low}°C)`;
    }
    if (w.rainChance !== undefined && w.rainChance > 0) {
      weatherContext += ` with ${w.rainChance}% chance of rain`;
    }
    if (w.alertsCount > 0 && w.topAlertHeadline) {
      weatherContext += `. Weather alert: ${w.topAlertHeadline}`;
    }
  }

  let marketContext = "";
  const watchlist =
    briefing.marketWatchlistGlance && briefing.marketWatchlistGlance.length > 0
      ? briefing.marketWatchlistGlance
      : briefing.marketGlance
        ? [briefing.marketGlance]
        : [];
  if (watchlist.length > 0) {
    marketContext = watchlist
      .slice(0, 5)
      .map((m) => {
        const dir = m.percentChange > 0 ? "up" : m.percentChange < 0 ? "down" : "flat at";
        return `${m.name} (${m.symbol}) is ${dir} ${Math.abs(m.percentChange).toFixed(2)}% at ${m.formattedPrice}`;
      })
      .join("; ");
  }

  let pulseContext = "";
  if (briefing.pulseGlance && briefing.pulseGlance.totalTracked > 0) {
    const p = briefing.pulseGlance;
    const surging = p.topSurgingTopic ? `Top surging topic is ${p.topSurgingTopic}. ` : "";
    pulseContext = `${surging}${p.totalMentions} total mentions across ${p.totalTracked} tracked topics (${p.sentimentToneLabel})`;
  }

  return { weatherContext, marketContext, pulseContext };
}

/**
 * Generates contextual one-tap question chips tailored to the user's live briefing.
 */
export function buildSuggestedBriefingQuestions(briefing: DailyBriefingData): string[] {
  const suggestions: string[] = [];

  if (briefing.priorityTopics.length > 0) {
    suggestions.push(`What's new on ${briefing.priorityTopics[0]}?`);
  } else if (briefing.leadStories.length > 0) {
    const topTopic =
      briefing.leadStories[0].priorityTopic ||
      briefing.leadStories[0].topics?.[0] ||
      briefing.leadStories[0].matchedTopics?.[0];
    if (topTopic) {
      suggestions.push(`What's happening with ${topTopic}?`);
    } else {
      suggestions.push("What are the top takeaways today?");
    }
  }

  if (
    (briefing.marketWatchlistGlance && briefing.marketWatchlistGlance.length > 0) ||
    briefing.marketGlance
  ) {
    suggestions.push("How are my watched markets moving?");
  }

  if (briefing.weatherGlance) {
    suggestions.push("Do I need an umbrella today?");
  }

  if (suggestions.length < 3) {
    suggestions.push("Summarize today's lead stories");
  }

  return suggestions.slice(0, 3);
}

function ensurePeriod(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function firstSentence(text?: string): string {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const match = cleaned.match(/^([^.!?]+[.!?])/);
  return match ? match[1].trim() : cleaned.slice(0, 180).trim();
}

/**
 * Deterministic local/offline Q&A engine so users can still ask questions against
 * their saved Offline Briefing Pack on a flight or subway without network connectivity.
 */
export function answerBriefingQuestionLocally(
  question: string,
  briefing: DailyBriefingData,
  extraArticles: readonly DailyBriefingStory[] = [],
  language = "en",
): BriefingQaResult {
  const cleanQ = (question || "").replace(/\s+/g, " ").trim();
  const normalizedLang = normalizeBriefingLanguage(language);
  const { weatherContext, marketContext, pulseContext } = buildBriefingContextStrings(briefing);

  const wantsWeather = WEATHER_REGEX.test(cleanQ);
  const wantsMarket = MARKET_REGEX.test(cleanQ);
  const wantsPulse = PULSE_REGEX.test(cleanQ);

  const seenUrls = new Set<string>();
  const pool: DailyBriefingStory[] = [];
  for (const item of [...briefing.leadStories, ...extraArticles]) {
    if (!item?.url || !item?.title || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    pool.push(item);
    if (pool.length >= 20) break;
  }

  const keywords = cleanQ
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

  const scored = pool
    .map((story, idx) => {
      let score = 0;
      const tags = [...(story.topics ?? []), ...(story.matchedTopics ?? [])];
      for (const tag of tags) {
        if (tag && topicMatchesText(cleanQ, tag)) score += 6;
        else if (keywords.some((kw) => tag.toLowerCase().includes(kw))) score += 3;
      }
      const lowerTitle = story.title.toLowerCase();
      const lowerSummary = (story.summary || "").toLowerCase();
      const lowerSource = (story.source || "").toLowerCase();
      for (const kw of keywords) {
        if (lowerTitle.includes(kw)) score += 4;
        if (lowerSummary.includes(kw)) score += 2;
        if (lowerSource.includes(kw)) score += 3;
      }
      return { story, score, idx };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));

  let matched = scored
    .filter((entry) => entry.score > 0)
    .slice(0, 3)
    .map((entry) => entry.story);

  const hasSpecificSignal =
    (wantsWeather && Boolean(weatherContext)) ||
    (wantsMarket && Boolean(marketContext)) ||
    (wantsPulse && Boolean(pulseContext));

  if (matched.length === 0 && !hasSpecificSignal) {
    matched = pool.slice(0, 3);
  }

  const sentences: string[] = [];
  if (wantsWeather && weatherContext) sentences.push(ensurePeriod(weatherContext));
  if (wantsMarket && marketContext) sentences.push(ensurePeriod(marketContext));
  if (wantsPulse && pulseContext) sentences.push(ensurePeriod(pulseContext));

  for (const story of matched) {
    if (sentences.length >= 3) break;
    const lead = firstSentence(story.summary);
    if (lead && lead.toLowerCase() !== story.title.toLowerCase()) {
      sentences.push(`According to ${story.source}, ${ensurePeriod(story.title)} ${ensurePeriod(lead)}`);
    } else {
      sentences.push(`${story.source} reports: ${ensurePeriod(story.title)}`);
    }
  }

  if (sentences.length === 0) {
    if (weatherContext) sentences.push(ensurePeriod(weatherContext));
    if (marketContext && sentences.length < 3) sentences.push(ensurePeriod(marketContext));
    if (pulseContext && sentences.length < 3) sentences.push(ensurePeriod(pulseContext));
  }

  if (sentences.length === 0) {
    return {
      available: false,
      answer: "There are not enough stories or live signals in today's briefing yet to answer that question.",
      mode: "empty",
      citations: [],
      language: normalizedLang,
    };
  }

  return {
    available: true,
    answer: sentences.join(" "),
    mode: "offline-local",
    citations: matched.map((s) => ({
      url: s.url,
      title: s.title,
      source: s.source,
    })),
    language: normalizedLang,
  };
}

/**
 * Queries POST /api/briefing-qa/ask for a cited, synthesized answer across today's
 * briefing stories, weather, market watchlist, and momentum — with automatic
 * offline fallback when disconnected.
 */
export async function askDailyBriefing(
  params: {
    question: string;
    briefing: DailyBriefingData;
    articles?: readonly DailyBriefingStory[];
    language?: string;
    isOnline?: boolean;
  },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<BriefingQaResult> {
  const cleanQuestion = (params.question || "").replace(/\s+/g, " ").trim();
  const normalizedLang = normalizeBriefingLanguage(params.language);
  const online =
    params.isOnline ?? (typeof navigator !== "undefined" ? navigator.onLine !== false : true);

  if (!online) {
    return answerBriefingQuestionLocally(
      cleanQuestion,
      params.briefing,
      params.articles,
      normalizedLang,
    );
  }

  const { weatherContext, marketContext, pulseContext } = buildBriefingContextStrings(
    params.briefing,
  );

  const seenUrls = new Set<string>();
  const candidateArticles: Array<{
    url: string;
    title: string;
    source: string;
    summary: string;
    topics: string[];
  }> = [];

  for (const item of [...params.briefing.leadStories, ...(params.articles ?? [])]) {
    if (!item?.url || !item?.title || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    candidateArticles.push({
      url: item.url,
      title: item.title,
      source: item.source || "",
      summary: (item.summary || "").slice(0, 750),
      topics: [...(item.topics ?? []), ...(item.matchedTopics ?? [])].slice(0, 8),
    });
    if (candidateArticles.length >= 16) break;
  }

  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!csrf.ok) {
      return answerBriefingQuestionLocally(
        cleanQuestion,
        params.briefing,
        params.articles,
        normalizedLang,
      );
    }
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) {
      return answerBriefingQuestionLocally(
        cleanQuestion,
        params.briefing,
        params.articles,
        normalizedLang,
      );
    }

    const response = await fetcher("/api/briefing-qa/ask", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": token,
      },
      body: JSON.stringify({
        question: cleanQuestion,
        weatherContext,
        marketContext,
        pulseContext,
        articles: candidateArticles,
        language: normalizedLang,
      }),
    });

    if (!response.ok) {
      return answerBriefingQuestionLocally(
        cleanQuestion,
        params.briefing,
        params.articles,
        normalizedLang,
      );
    }

    const data = (await response.json()) as {
      available?: boolean;
      answer?: string;
      mode?: string;
      citations?: BriefingQaCitation[];
      language?: string;
    };

    if (typeof data?.answer === "string" && data.answer.trim()) {
      const mode =
        data.mode === "azure-ai"
          ? "azure-ai"
          : data.mode === "empty"
            ? "empty"
            : "extractive";
      return {
        available: Boolean(data.available),
        answer: data.answer.trim(),
        mode,
        citations: Array.isArray(data.citations) ? data.citations : [],
        language: data.language || normalizedLang,
      };
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
  }

  return answerBriefingQuestionLocally(
    cleanQuestion,
    params.briefing,
    params.articles,
    normalizedLang,
  );
}
