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
  fetcher: typeof fetch = fetch,
): Promise<ArticleKeyPhrasesResponse> {
  const cacheKey = `${url}::${(title || "").slice(0, 50)}`;
  const cached = keyPhrasesCache.get(cacheKey);
  if (cached) return cached;

  try {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) throw new Error("Could not start a secure article request.");
    const { token } = await csrf.json() as { token?: string };
    if (!token) throw new Error("Could not start a secure article request.");
    signal?.throwIfAborted();
    const response = await fetcher("/api/article-keyphrases", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
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
