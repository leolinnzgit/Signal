export type ArticleSentimentResponse = {
  available: boolean;
  reason?: string;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  positiveScore: number;
  neutralScore: number;
  negativeScore: number;
};

const sentimentCache = new Map<string, ArticleSentimentResponse>();

export async function loadArticleSentiment(
  url: string,
  title?: string,
  paragraphs?: string[],
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ArticleSentimentResponse> {
  const cacheKey = `${url}::${(title || "").slice(0, 50)}`;
  const cached = sentimentCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetcher("/api/article-sentiment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        title: title || undefined,
        paragraphs: paragraphs && paragraphs.length > 0 ? paragraphs.slice(0, 4) : undefined,
      }),
      signal,
    });

    if (!response.ok) {
      return {
        available: false,
        reason: `Server returned status ${response.status}`,
        sentiment: "neutral",
        positiveScore: 0,
        neutralScore: 0,
        negativeScore: 0,
      };
    }

    const data = (await response.json()) as ArticleSentimentResponse;
    if (data.available) {
      sentimentCache.set(cacheKey, data);
    }
    return data;
  } catch {
    return {
      available: false,
      reason: "Sentiment analysis failed",
      sentiment: "neutral",
      positiveScore: 0,
      neutralScore: 0,
      negativeScore: 0,
    };
  }
}

export function getSentimentIcon(sentiment: string): string {
  switch (sentiment.toLowerCase()) {
    case "positive":
      return "😊";
    case "negative":
      return "😟";
    case "mixed":
      return "⚖️";
    case "neutral":
    default:
      return "😐";
  }
}
