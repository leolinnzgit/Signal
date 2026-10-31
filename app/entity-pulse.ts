import { calculateEntityFrequency, type EntityFrequencyStats } from "./entity-frequency.ts";
import { resolveArticleSentiment } from "./article-sentiment.ts";
import type { StoredEntityRecord } from "./suggested-topics.ts";

export type EntityPulseArticle = {
  url: string;
  title: string;
  source: string;
  publishedAt?: string;
  summary?: string;
  topics?: string[];
};

export type SentimentMomentumTrend = "improving" | "cooling" | "steady";

export type EntitySentimentBreakdown = {
  analyzedCount: number;
  azureCount: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
  mixedCount: number;
  positivePercent: number;
  neutralPercent: number;
  negativePercent: number;
  dominantTone: "positive" | "neutral" | "negative" | "mixed" | "none";
  toneLabel: string;
  netScore: number;
  momentum: SentimentMomentumTrend;
  momentumLabel: string;
};

export type EntityPulseItem = {
  topic: string;
  category: string;
  stats: EntityFrequencyStats;
  sentiment: EntitySentimentBreakdown;
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
  overallSentiment: EntitySentimentBreakdown;
};

export type EntityPulseSort =
  | "momentum"
  | "mentions"
  | "recent"
  | "alpha"
  | "sentiment-positive"
  | "sentiment-critical";

export function emptySentimentBreakdown(): EntitySentimentBreakdown {
  return {
    analyzedCount: 0,
    azureCount: 0,
    positiveCount: 0,
    neutralCount: 0,
    negativeCount: 0,
    mixedCount: 0,
    positivePercent: 0,
    neutralPercent: 0,
    negativePercent: 0,
    dominantTone: "none",
    toneLabel: "No recent stories",
    netScore: 0,
    momentum: "steady",
    momentumLabel: "Steady tone",
  };
}

function getRecentCutoffSet(referenceDate: Date): Set<string> {
  const recentDates = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const d = new Date(referenceDate);
    d.setDate(d.getDate() - i);
    recentDates.add(d.toISOString().slice(0, 10));
  }
  return recentDates;
}

function isRecentArticleDate(publishedAt: string | undefined, recentDates: Set<string>): boolean {
  if (!publishedAt) return true;
  const parsed = new Date(publishedAt);
  if (isNaN(parsed.getTime())) return true;
  return recentDates.has(parsed.toISOString().slice(0, 10));
}

/**
 * Computes sentiment tone distribution and 7-day sentiment momentum across a set of articles.
 * Zero external API calls: combines cached Azure AI Language sentiment with local headline analysis.
 */
export function calculateEntitySentiment(
  matchingArticles: readonly EntityPulseArticle[],
  referenceDate: Date = new Date(),
  storage?: Storage,
): EntitySentimentBreakdown {
  if (!matchingArticles || matchingArticles.length === 0) {
    return emptySentimentBreakdown();
  }

  const recentDates = getRecentCutoffSet(referenceDate);

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let mixedCount = 0;
  let azureCount = 0;

  let recentSum = 0;
  let recentTotal = 0;
  let priorSum = 0;
  let priorTotal = 0;

  for (const article of matchingArticles) {
    const resolved = resolveArticleSentiment(article, storage);
    if (resolved.source === "azure") azureCount += 1;

    let polarity = 0;
    if (resolved.sentiment === "positive") {
      positiveCount += 1;
      polarity = 1;
    } else if (resolved.sentiment === "negative") {
      negativeCount += 1;
      polarity = -1;
    } else if (resolved.sentiment === "mixed") {
      mixedCount += 1;
      polarity = 0;
    } else {
      neutralCount += 1;
      polarity = 0;
    }

    if (isRecentArticleDate(article.publishedAt, recentDates)) {
      recentSum += polarity;
      recentTotal += 1;
    } else {
      priorSum += polarity;
      priorTotal += 1;
    }
  }

  const analyzedCount = matchingArticles.length;
  const positivePercent = Math.round((positiveCount / analyzedCount) * 100);
  const negativePercent = Math.round((negativeCount / analyzedCount) * 100);
  const neutralPercent = Math.max(0, 100 - positivePercent - negativePercent);

  const netScore = Math.round(((positiveCount - negativeCount) / analyzedCount) * 1000) / 1000;

  let dominantTone: EntitySentimentBreakdown["dominantTone"] = "neutral";
  let toneLabel = "Mostly neutral coverage";

  if (positiveCount > 0 && negativeCount > 0 && positiveCount === negativeCount && positiveCount + negativeCount >= neutralCount) {
    dominantTone = "mixed";
    toneLabel = "Split coverage";
  } else if (mixedCount > positiveCount && mixedCount > negativeCount && mixedCount >= neutralCount) {
    dominantTone = "mixed";
    toneLabel = "Mixed coverage";
  } else if (positivePercent >= 50 && positiveCount > negativeCount) {
    dominantTone = "positive";
    toneLabel = `${positivePercent}% positive coverage`;
  } else if (negativePercent >= 50 && negativeCount > positiveCount) {
    dominantTone = "negative";
    toneLabel = `${negativePercent}% critical tone`;
  } else if (positiveCount > negativeCount && positivePercent >= 30) {
    dominantTone = "positive";
    toneLabel = `Leaning positive (${positivePercent}%)`;
  } else if (negativeCount > positiveCount && negativePercent >= 30) {
    dominantTone = "negative";
    toneLabel = `Leaning critical (${negativePercent}%)`;
  }

  let momentum: SentimentMomentumTrend = "steady";
  let momentumLabel = "Steady tone";

  if (recentTotal >= 1 && priorTotal >= 1) {
    const delta = recentSum / recentTotal - priorSum / priorTotal;
    if (delta >= 0.4) {
      momentum = "improving";
      momentumLabel = "Tone improving";
    } else if (delta <= -0.4) {
      momentum = "cooling";
      momentumLabel = "Turning critical";
    }
  }

  return {
    analyzedCount,
    azureCount,
    positiveCount,
    neutralCount,
    negativeCount,
    mixedCount,
    positivePercent,
    neutralPercent,
    negativePercent,
    dominantTone,
    toneLabel,
    netScore,
    momentum,
    momentumLabel,
  };
}

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
  storage?: Storage,
): EntityPulseSummary {
  if (!topics || topics.length === 0) {
    return {
      items: [],
      totalTracked: 0,
      surgingCount: 0,
      totalMentionsThisWeek: 0,
      overallSentiment: emptySentimentBreakdown(),
    };
  }

  // Create lookup for known entity categories from reading history
  const categoryMap = new Map<string, string>();
  for (const record of storedHistory) {
    categoryMap.set(record.text.toLowerCase(), record.category);
  }

  const items: EntityPulseItem[] = [];
  const uniqueMatchedArticles = new Map<string, EntityPulseArticle>();
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

    // Collect matching articles and newest article mentioning this topic
    let latestArticle: EntityPulseItem["latestArticle"] | undefined;
    const matchingArticles: EntityPulseArticle[] = [];

    for (const article of articles) {
      const titleMatch = article.title ? article.title.toLowerCase().includes(lowerTopic) : false;
      const summaryMatch = article.summary ? article.summary.toLowerCase().includes(lowerTopic) : false;
      const topicMatch = article.topics
        ? article.topics.some((t) => t.toLowerCase().includes(lowerTopic))
        : false;

      if (titleMatch || summaryMatch || topicMatch) {
        matchingArticles.push(article);
        uniqueMatchedArticles.set(article.url || article.title, article);

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

    const sentiment = calculateEntitySentiment(matchingArticles, referenceDate, storage);

    items.push({
      topic: cleanTopic,
      category,
      stats,
      sentiment,
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
  const overallSentiment = calculateEntitySentiment(
    Array.from(uniqueMatchedArticles.values()),
    referenceDate,
    storage,
  );

  return {
    items,
    totalTracked: topics.length,
    surgingCount,
    totalMentionsThisWeek,
    topSurging,
    overallSentiment,
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
    case "sentiment-positive":
      return copy.sort((a, b) => {
        const hasA = a.sentiment.analyzedCount > 0 ? 1 : 0;
        const hasB = b.sentiment.analyzedCount > 0 ? 1 : 0;
        if (hasA !== hasB) return hasB - hasA;
        return (
          b.sentiment.netScore - a.sentiment.netScore ||
          b.sentiment.positivePercent - a.sentiment.positivePercent ||
          b.stats.totalMentions - a.stats.totalMentions ||
          a.topic.localeCompare(b.topic)
        );
      });
    case "sentiment-critical":
      return copy.sort((a, b) => {
        const hasA = a.sentiment.analyzedCount > 0 ? 1 : 0;
        const hasB = b.sentiment.analyzedCount > 0 ? 1 : 0;
        if (hasA !== hasB) return hasB - hasA;
        return (
          a.sentiment.netScore - b.sentiment.netScore ||
          b.sentiment.negativePercent - a.sentiment.negativePercent ||
          b.stats.totalMentions - a.stats.totalMentions ||
          a.topic.localeCompare(b.topic)
        );
      });
    case "alpha":
      return copy.sort((a, b) => a.topic.localeCompare(b.topic));
    default:
      return copy;
  }
}
