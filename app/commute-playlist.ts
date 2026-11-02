export interface CommuteChapter {
  id: string;
  title: string;
  category: "weather" | "macro_market" | "lead_story" | "deep_dive" | "forward_watch";
  durationSeconds: number;
  startTimeSeconds: number;
  narrationText: string;
  source?: string;
  url?: string;
}

export interface CommutePlaylist {
  id: string;
  title: string;
  edition: string;
  totalDurationSeconds: number;
  chapters: CommuteChapter[];
  generatedAt: string;
}

export function buildCommutePlaylist(
  briefing?: {
    edition?: string;
    formattedDate?: string;
    spokenScript?: string;
    leadStories?: Array<{ title: string; source: string; url: string; summary?: string }>;
    weatherGlance?: { temperature: number; condition: string; location: string };
  } | null,
  marketSentiment?: {
    macroHeadline?: string;
    assets?: Array<{ symbol: string; name: string; price: number; changePercent?: number; percentChange?: number; sentimentTone?: string }>;
  } | null,
  stagedArticles?: Array<{ title: string; source: string; url: string; summary?: string }>,
): CommutePlaylist {
  const chapters: CommuteChapter[] = [];
  let currentTime = 0;

  // Chapter 1: Introduction & Local Weather
  const weatherText = briefing?.weatherGlance
    ? `Currently ${briefing.weatherGlance.temperature} degrees and ${briefing.weatherGlance.condition} in ${briefing.weatherGlance.location}.`
    : "Weather conditions are optimal across monitored regional hubs.";

  const greeting = briefing?.edition ? `Signal ${briefing.edition} Executive Commute Briefing` : "Signal Executive Commute Briefing";
  const introNarration = `Welcome to your commute briefing for ${briefing?.formattedDate || "today"}. ${weatherText}`;
  const introDuration = 45;

  chapters.push({
    id: "chapter-weather-intro",
    title: "Commute Intro & Local Weather Glance",
    category: "weather",
    durationSeconds: introDuration,
    startTimeSeconds: currentTime,
    narrationText: introNarration,
    source: "Signal Weather Desk",
  });
  currentTime += introDuration;

  // Chapter 2: Macro Market & Currency Sentiment
  if (marketSentiment && marketSentiment.assets && marketSentiment.assets.length > 0) {
    const marketDuration = 75;
    const topGainers = marketSentiment.assets
      .slice(0, 3)
      .map((a) => {
        const pct = a.changePercent ?? a.percentChange ?? 0;
        return `${a.name}: ${pct > 0 ? "+" : ""}${pct}%`;
      })
      .join(", ");
    const marketNarration = `Macro financial pulse: ${marketSentiment.macroHeadline || "Consolidation across primary sector benchmarks."} Monitored movers: ${topGainers}.`;

    chapters.push({
      id: "chapter-macro-market",
      title: "Macro Financial Pulse & Watchlist",
      category: "macro_market",
      durationSeconds: marketDuration,
      startTimeSeconds: currentTime,
      narrationText: marketNarration,
      source: "Signal Market Desk",
    });
    currentTime += marketDuration;
  }

  // Chapter 3..N: Lead Stories
  const stories = (briefing?.leadStories && briefing.leadStories.length > 0)
    ? briefing.leadStories.slice(0, 4)
    : (stagedArticles && stagedArticles.length > 0)
      ? stagedArticles.slice(0, 4)
      : [
          {
            title: "Reserve Bank Balances Cash Rate with Inflation Trajectory",
            source: "Signal Wire",
            url: "https://signal.internal/story/1",
            summary: "Policy committee balances cooling service inflation against steady economic recovery.",
          },
        ];

  stories.forEach((story, idx) => {
    const storyDuration = 90;
    const narration = `${story.title}. Reported by ${story.source}. ${story.summary || "Key operational and policy developments unfolding across monitored sectors."}`;

    chapters.push({
      id: `chapter-lead-${idx + 1}`,
      title: story.title,
      category: "lead_story",
      durationSeconds: storyDuration,
      startTimeSeconds: currentTime,
      narrationText: narration,
      source: story.source,
      url: story.url,
    });
    currentTime += storyDuration;
  });

  // Final Chapter: Forward Watch Horizon
  const forwardDuration = 45;
  const forwardNarration = "Forward horizon: Watch for official regulatory disclosures, corporate compliance deadlines, and secondary partner statements over the coming trading sessions.";

  chapters.push({
    id: "chapter-forward-watch",
    title: "Strategic Watch Horizon & Next Steps",
    category: "forward_watch",
    durationSeconds: forwardDuration,
    startTimeSeconds: currentTime,
    narrationText: forwardNarration,
    source: "Signal Intelligence",
  });
  currentTime += forwardDuration;

  return {
    id: `commute-${Date.now()}`,
    title: greeting,
    edition: briefing?.edition || "Morning",
    totalDurationSeconds: currentTime,
    chapters,
    generatedAt: new Date().toISOString(),
  };
}

export function formatCommuteTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function setupMediaSession(
  playlist: CommutePlaylist,
  currentChapterIndex: number,
  handlers: {
    onPlay?: () => void;
    onPause?: () => void;
    onPrevious?: () => void;
    onNext?: () => void;
    onSeekTo?: (time: number) => void;
  },
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

  const chapter = playlist.chapters[currentChapterIndex] || playlist.chapters[0];
  if (!chapter) return;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: chapter.source || "Signal Intelligence",
      album: playlist.title,
      artwork: [
        { src: "/icons/signal-medallion-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" },
      ],
    });

    if (handlers.onPlay) navigator.mediaSession.setActionHandler("play", handlers.onPlay);
    if (handlers.onPause) navigator.mediaSession.setActionHandler("pause", handlers.onPause);
    if (handlers.onPrevious) navigator.mediaSession.setActionHandler("previoustrack", handlers.onPrevious);
    if (handlers.onNext) navigator.mediaSession.setActionHandler("nexttrack", handlers.onNext);
    if (handlers.onSeekTo) {
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (typeof details.seekTime === "number") handlers.onSeekTo!(details.seekTime);
      });
    }
  } catch {}
}
