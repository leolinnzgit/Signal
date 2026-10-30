export type ArticleKeyPhrasesResponse = {
  available: boolean;
  reason?: string;
  keyPhrases: string[];
};

const keyPhrasesCache = new Map<string, ArticleKeyPhrasesResponse>();

export async function loadArticleKeyPhrases(
  url: string,
  title?: string,
  paragraphs?: string[],
  signal?: AbortSignal,
): Promise<ArticleKeyPhrasesResponse> {
  const cacheKey = `${url}::${(title || "").slice(0, 50)}`;
  const cached = keyPhrasesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch("/api/article-keyphrases", {
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
        keyPhrases: [],
      };
    }

    const data = (await response.json()) as ArticleKeyPhrasesResponse;
    if (data.available) {
      keyPhrasesCache.set(cacheKey, data);
    }
    return data;
  } catch {
    return {
      available: false,
      reason: "Key phrase extraction failed",
      keyPhrases: [],
    };
  }
}
