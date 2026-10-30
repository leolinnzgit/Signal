export type EntityTimelinePoint = {
  date: string;
  label: string;
  count: number;
};

export type EntityTrend = "surging" | "rising" | "steady" | "recent" | "quiet";

export type EntityFrequencyStats = {
  entity: string;
  totalMentions: number;
  days: number;
  timeline: EntityTimelinePoint[];
  trend: EntityTrend;
  trendPercent: number;
  trendLabel: string;
  peakCount: number;
  peakDay: string;
};

export type ArticleSummaryLike = {
  title: string;
  summary?: string;
  publishedAt?: string;
  topics?: string[];
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Calculates a 7-day timeline and frequency stats for an entity across articles.
 * Zero external API calls; runs purely in-memory over client feed articles.
 */
export function calculateEntityFrequency(
  entityText: string,
  articles: readonly ArticleSummaryLike[],
  days = 7,
  referenceDate: Date = new Date(),
): EntityFrequencyStats {
  const cleanEntity = entityText.trim();
  const lowerEntity = cleanEntity.toLowerCase();

  // 1. Build daily buckets from oldest to newest (today)
  const timeline: EntityTimelinePoint[] = [];
  const dateMap = new Map<string, number>();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(referenceDate);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const label = DAY_LABELS[d.getDay()];
    timeline.push({ date: dateStr, label, count: 0 });
    dateMap.set(dateStr, timeline.length - 1);
  }

  if (!cleanEntity || !articles || articles.length === 0) {
    return {
      entity: cleanEntity,
      totalMentions: 0,
      days,
      timeline,
      trend: "quiet",
      trendPercent: 0,
      trendLabel: "No recent mentions",
      peakCount: 0,
      peakDay: timeline[timeline.length - 1]?.label ?? "",
    };
  }

  // 2. Count mentions in each day bucket
  let totalMentions = 0;
  for (const article of articles) {
    const titleMatch = article.title ? article.title.toLowerCase().includes(lowerEntity) : false;
    const summaryMatch = article.summary ? article.summary.toLowerCase().includes(lowerEntity) : false;
    const topicMatch = article.topics ? article.topics.some((t) => t.toLowerCase().includes(lowerEntity)) : false;

    if (titleMatch || summaryMatch || topicMatch) {
      let articleDateStr = "";
      if (article.publishedAt) {
        try {
          const parsed = new Date(article.publishedAt);
          if (!isNaN(parsed.getTime())) {
            articleDateStr = parsed.toISOString().slice(0, 10);
          }
        } catch {
          // ignore date parse errors
        }
      }

      // If missing or unparseable, count towards today
      if (!articleDateStr || !dateMap.has(articleDateStr)) {
        articleDateStr = timeline[timeline.length - 1].date;
      }

      const index = dateMap.get(articleDateStr);
      if (index !== undefined) {
        timeline[index].count += 1;
        totalMentions += 1;
      }
    }
  }

  // 3. Find peak day
  let peakCount = 0;
  let peakDay = timeline[timeline.length - 1].label;
  for (const point of timeline) {
    if (point.count >= peakCount) {
      peakCount = point.count;
      peakDay = point.label;
    }
  }

  // 4. Calculate trend
  // Last 2 days vs previous days
  const recentDays = timeline.slice(-2);
  const priorDays = timeline.slice(0, -2);
  const recentCount = recentDays.reduce((acc, p) => acc + p.count, 0);
  const priorCount = priorDays.reduce((acc, p) => acc + p.count, 0);

  let trend: EntityTrend = "quiet";
  let trendLabel = "Low coverage";
  let trendPercent = 0;

  if (totalMentions >= 3 && recentCount >= 2 && (priorCount === 0 || recentCount >= priorCount * 1.4)) {
    trend = "surging";
    trendPercent = priorCount === 0 ? 100 : Math.round(((recentCount - priorCount) / priorCount) * 100);
    trendLabel = `Surging (${trendPercent > 0 ? `+${trendPercent}%` : "high"})`;
  } else if (recentCount > priorCount && totalMentions >= 2) {
    trend = "rising";
    trendPercent = priorCount === 0 ? 50 : Math.round(((recentCount - priorCount) / priorCount) * 100);
    trendLabel = "Trending up";
  } else if (totalMentions >= 3) {
    trend = "steady";
    trendLabel = "Steady coverage";
  } else if (totalMentions >= 1) {
    trend = "recent";
    trendLabel = `${totalMentions} ${totalMentions === 1 ? "story" : "stories"}`;
  }

  return {
    entity: cleanEntity,
    totalMentions,
    days,
    timeline,
    trend,
    trendPercent,
    trendLabel,
    peakCount,
    peakDay,
  };
}
