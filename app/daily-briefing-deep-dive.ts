import type { DailyBriefingData, DailyBriefingStory } from "./daily-briefing.ts";
import { normalizeBriefingLanguage } from "./daily-briefing-translation.ts";

export interface DeepDiveTurn {
  index: number;
  speaker: "Anchor" | "Analyst" | string;
  speakerName: string;
  voiceName: string;
  role: string;
  text: string;
  citedSource?: string | null;
  citedUrl?: string | null;
}

export interface DeepDiveChapter {
  title: string;
  startTurnIndex: number;
}

export interface DeepDiveEpisode {
  available: boolean;
  title: string;
  subtitle: string;
  turns: DeepDiveTurn[];
  chapters: DeepDiveChapter[];
  estimatedDurationSeconds: number;
  language: string;
  sourceLabel?: string;
}

export interface DeepDiveRequestOptions {
  topic?: string;
  briefing?: DailyBriefingData;
  articles?: readonly DailyBriefingStory[];
  marketContext?: string;
  language?: string;
  isOnline?: boolean;
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
 * Deterministic local synthesizer to produce full 2-host investigative episodes
 * even while offline or when Azure language services are in fallback mode.
 */
export function synthesizeDeepDiveLocally(options: DeepDiveRequestOptions): DeepDiveEpisode {
  const lang = normalizeBriefingLanguage(options.language || "en");
  const briefing = options.briefing;
  const articles = options.articles || briefing?.leadStories || [];

  const topTopic =
    options.topic ||
    briefing?.priorityTopics?.[0] ||
    articles[0]?.priorityTopic ||
    articles[0]?.matchedTopics?.[0] ||
    articles[0]?.topics?.[0] ||
    (articles[0]?.title ? articles[0].title.slice(0, 60) : "Global Economic Intelligence");

  const primaryStory = articles[0] || {
    title: topTopic,
    source: "Signal Intelligence",
    url: "https://signal.internal/briefing",
    summary: "Multi-source news coverage tracking major geopolitical and market shifts.",
  };

  const secondaryStory = articles.length > 1 ? articles[1] : primaryStory;

  const lead1 = firstSentence(primaryStory.summary) || primaryStory.title;
  const lead2 = firstSentence(secondaryStory.summary) || secondaryStory.title;

  const anchorVoice = lang.startsWith("zh")
    ? "zh-CN-YunxiNeural"
    : "en-US-AndrewMultilingualNeural";
  const analystVoice = lang.startsWith("zh")
    ? "zh-CN-XiaoxiaoNeural"
    : "en-US-AvaMultilingualNeural";

  const marketText =
    options.marketContext ||
    (briefing?.marketGlance
      ? `${briefing.marketGlance.name} trading at ${briefing.marketGlance.formattedPrice}`
      : "cross-asset indices consolidating");

  const turns: DeepDiveTurn[] = [
    {
      index: 0,
      speaker: "Anchor",
      speakerName: "Alex, Anchor",
      voiceName: anchorVoice,
      role: "Host",
      text: `Welcome to Signal Executive Deep Dive on ${topTopic}. Key publishers are weighing in with diverging angles, and leadership teams are working to separate structural signals from noise. Elena, start us with the ground-level reporting.`,
      citedSource: null,
      citedUrl: null,
    },
    {
      index: 1,
      speaker: "Analyst",
      speakerName: "Elena, Chief Analyst",
      voiceName: analystVoice,
      role: "Senior Analyst",
      text: `Thanks Alex. Reporting led by ${primaryStory.source} indicates that ${ensurePeriod(lead1)} The core catalyst here is that institutions are treating this development as an inflection point rather than a temporary trend.`,
      citedSource: primaryStory.source,
      citedUrl: primaryStory.url,
    },
    {
      index: 2,
      speaker: "Anchor",
      speakerName: "Alex, Anchor",
      voiceName: anchorVoice,
      role: "Host",
      text: `However, ${secondaryStory.source} brings a contrasting perspective, underscoring that ${ensurePeriod(lead2)} Why are we seeing such a divergence in framing between these outlets?`,
      citedSource: secondaryStory.source,
      citedUrl: secondaryStory.url,
    },
    {
      index: 3,
      speaker: "Analyst",
      speakerName: "Elena, Chief Analyst",
      voiceName: analystVoice,
      role: "Senior Analyst",
      text: `That divergence is the exact nexus to watch. While ${primaryStory.source} highlights immediate operational momentum, ${secondaryStory.source} focuses on regulatory friction, governance stakes, and secondary cost pressures. For decision-makers, taking action based solely on the optimistic headline risks overlooking downstream hurdles.`,
      citedSource: secondaryStory.source,
      citedUrl: secondaryStory.url,
    },
    {
      index: 4,
      speaker: "Anchor",
      speakerName: "Alex, Anchor",
      voiceName: anchorVoice,
      role: "Host",
      text: `And against the backdrop of ${marketText}, how should capital allocators and industry leaders evaluate their posture right now?`,
      citedSource: null,
      citedUrl: null,
    },
    {
      index: 5,
      speaker: "Analyst",
      speakerName: "Elena, Chief Analyst",
      voiceName: analystVoice,
      role: "Senior Analyst",
      text: `We are seeing a flight to fundamental strength. Leaders are stress-testing balance sheets and supplier commitments against potential delays. The prudent play is to preserve optionality until policy confirmations firm up.`,
      citedSource: null,
      citedUrl: null,
    },
    {
      index: 6,
      speaker: "Anchor",
      speakerName: "Alex, Anchor",
      voiceName: anchorVoice,
      role: "Host",
      text: `Elena, what is the single watch-item for executives over the next 48 to 72 hours?`,
      citedSource: null,
      citedUrl: null,
    },
    {
      index: 7,
      speaker: "Analyst",
      speakerName: "Elena, Chief Analyst",
      voiceName: analystVoice,
      role: "Senior Analyst",
      text: `Watch for formal filings from lead regulators and coordinated commentary from major enterprise peers. If those align, expect broader strategic realignments. We will track every signal here on the desk.`,
      citedSource: null,
      citedUrl: null,
    },
    {
      index: 8,
      speaker: "Anchor",
      speakerName: "Alex, Anchor",
      voiceName: anchorVoice,
      role: "Host",
      text: `That concludes this edition of Signal Executive Deep Dive. Stay informed, and we will see you in the next briefing.`,
      citedSource: null,
      citedUrl: null,
    },
  ];

  const chapters: DeepDiveChapter[] = [
    { title: "Ground-Level Reporting", startTurnIndex: 0 },
    { title: "Contrasting Perspectives", startTurnIndex: 2 },
    { title: "Market & Sector Exposure", startTurnIndex: 4 },
    { title: "Executive Outlook", startTurnIndex: 6 },
  ];

  const wordCount = turns.reduce((acc, t) => acc + t.text.split(/\s+/).length, 0);

  return {
    available: true,
    title: `Executive Deep Dive: ${topTopic}`,
    subtitle: `Dual-voice investigative breakdown across ${primaryStory.source} & ${secondaryStory.source}`,
    turns,
    chapters,
    estimatedDurationSeconds: Math.max(45, Math.round(wordCount / 2.5)),
    language: lang,
    sourceLabel: `${primaryStory.source} & ${secondaryStory.source}`,
  };
}

/**
 * Requests an Executive Deep Dive episode from POST /api/briefing/deep-dive,
 * falling back gracefully to the deterministic local engine when offline or network fails.
 */
export async function fetchBriefingDeepDive(
  options: DeepDiveRequestOptions,
  signal?: AbortSignal,
): Promise<DeepDiveEpisode> {
  const isOnline = options.isOnline ?? (typeof navigator !== "undefined" ? navigator.onLine : true);
  if (!isOnline) {
    return synthesizeDeepDiveLocally(options);
  }

  const articles = options.articles || options.briefing?.leadStories || [];
  const payload = {
    topic: options.topic,
    articles: articles.slice(0, 6).map((a) => ({
      url: a.url,
      title: a.title,
      source: a.source,
      summary: a.summary,
      topics: a.topics,
    })),
    marketContext: options.marketContext,
    language: options.language || "en",
  };

  try {
    let token = "";
    try {
      const csrf = await fetch("/api/auth/csrf", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (csrf.ok) {
        const json = await csrf.json();
        token = json?.token || "";
      }
    } catch {}

    const response = await fetch("/api/briefing/deep-dive", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-XSRF-TOKEN": token } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      return synthesizeDeepDiveLocally(options);
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.turns) || data.turns.length === 0) {
      return synthesizeDeepDiveLocally(options);
    }

    return {
      available: Boolean(data.available),
      title: data.title || `Executive Deep Dive: ${options.topic || "Lead Story"}`,
      subtitle: data.subtitle || "Investigative multi-publisher audio analysis",
      turns: data.turns,
      chapters: data.chapters || [],
      estimatedDurationSeconds: data.estimatedDurationSeconds || 90,
      language: data.language || options.language || "en",
    };
  } catch {
    return synthesizeDeepDiveLocally(options);
  }
}
