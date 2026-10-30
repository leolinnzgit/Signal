import { calculateEntityFrequency, type EntityFrequencyStats } from "./entity-frequency.ts";
import type { StoredEntityRecord } from "./suggested-topics.ts";

export type EntityPulseArticle = {
  url: string;
  title: string;
  source: string;
  publishedAt?: string;
  summary?: string;
  topics?: string[];
};

export type EntityPulseItem = {
  topic: string;
  category: string;
  stats: EntityFrequencyStats;
  latestArticle?: {
    url: string;
    title: string;
    source: string;
    publishedAt?: string;
  };
};

export type EntityPulseSummary = {
  items: EntityPulseItem[];
  totalTracked: number;
  surgingCount: number;
  totalMentionsThisWeek: number;
  topSurging?: EntityPulseItem;
};

export type EntityPulseSort = "momentum" | "mentions" | "recent" | "alpha";

/**
 * Builds the news pulse summary for all followed topics/entities.
 * Purely client-side with zero external API calls.
 */
export function buildEntityPulse(
  topics: readonly string[],
  articles: readonly EntityPulseArticle[],
  storedHistory: readonly StoredEntityRecord[] = [],
  days = 7,
  referenceDate: Date = new Date(),
): EntityPulseSummary {
  if (!topics || topics.length === 0) {
    return {
      items: [],
      totalTracked: 0,
      surgingCount: 0,
      totalMentionsThisWeek: 0,
    };
  }

  // Create lookup for known entity categories from reading history
  const categoryMap = new Map<string, string>();
  for (const record of storedHistory) {
    categoryMap.set(record.text.toLowerCase(), record.category);
  }

  const items: EntityPulseItem[] = [];
  let totalMentionsThisWeek = 0;
  let surgingCount = 0;

  for (const topic of topics) {
    const cleanTopic = topic.trim();
    if (!cleanTopic) continue;

    const lowerTopic = cleanTopic.toLowerCase();
    const category = categoryMap.get(lowerTopic) || "Topic";
    const stats = calculateEntityFrequency(cleanTopic, articles, days, referenceDate);

    totalMentionsThisWeek += stats.totalMentions;
    if (stats.trend === "surging") surgingCount += 1;

    // Find newest article mentioning this topic
    let latestArticle: EntityPulseItem["latestArticle"] | undefined;
    for (const article of articles) {
      const titleMatch = article.title ? article.title.toLowerCase().includes(lowerTopic) : false;
      const summaryMatch = article.summary ? article.summary.toLowerCase().includes(lowerTopic) : false;
      const topicMatch = article.topics ? article.topics.some((t) => t.toLowerCase() === lowerTopic) : false;

      if (titleMatch || summaryMatch || topicMatch) {
        if (!latestArticle) {
          latestArticle = {
            url: article.url,
            title: article.title,
            source: article.source,
            publishedAt: article.publishedAt,
          };
        }
      }
    }

    items.push({
      topic: cleanTopic,
      category,
      stats,
      latestArticle,
    });
  }

  // Default sort: surging / active first, then by mentions
  items.sort((a, b) => {
    if (a.stats.trend === "surging" && b.stats.trend !== "surging") return -1;
    if (b.stats.trend === "surging" && a.stats.trend !== "surging") return 1;
    if (a.stats.trend === "rising" && b.stats.trend !== "rising") return -1;
    if (b.stats.trend === "rising" && a.stats.trend !== "rising") return 1;
    return b.stats.totalMentions - a.stats.totalMentions || a.topic.localeCompare(b.topic);
  });

  const topSurging = items.find((i) => i.stats.trend === "surging");

  return {
    items,
    totalTracked: topics.length,
    surgingCount,
    totalMentionsThisWeek,
    topSurging,
  };
}

export function sortPulseItems(items: EntityPulseItem[], sortBy: EntityPulseSort): EntityPulseItem[] {
  const copy = [...items];
  switch (sortBy) {
    case "momentum":
      return copy.sort((a, b) => {
        const trendRank = (t: string) => (t === "surging" ? 4 : t === "rising" ? 3 : t === "steady" ? 2 : t === "recent" ? 1 : 0);
        const rankDiff = trendRank(b.stats.trend) - trendRank(a.stats.trend);
        if (rankDiff !== 0) return rankDiff;
        return b.stats.totalMentions - a.stats.totalMentions || a.topic.localeCompare(b.topic);
      });
    case "mentions":
      return copy.sort((a, b) => b.stats.totalMentions - a.stats.totalMentions || a.topic.localeCompare(b.topic));
    case "recent":
      return copy.sort((a, b) => {
        const dateA = a.latestArticle?.publishedAt ? new Date(a.latestArticle.publishedAt).getTime() : 0;
        const dateB = b.latestArticle?.publishedAt ? new Date(b.latestArticle.publishedAt).getTime() : 0;
        return dateB - dateA || b.stats.totalMentions - a.stats.totalMentions;
      });
    case "alpha":
      return copy.sort((a, b) => a.topic.localeCompare(b.topic));
    default:
      return copy;
  }
}
