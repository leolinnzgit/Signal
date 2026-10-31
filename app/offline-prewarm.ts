import { loadArticleKeyPhrases } from "./article-keyphrases.ts";
import { loadArticleSentiment } from "./article-sentiment.ts";
import { loadArticleEntities } from "./article-entities.ts";
import { loadArticleImageCaption } from "./article-image-caption.ts";

export type CachedArticleData = {
  url: string;
  title: string;
  byline: string;
  siteName: string;
  publishedAt: string;
  paragraphs: string[];
  finalUrl: string;
  cachedAt: string;
};

export type PrewarmResult = {
  success: boolean;
  url: string;
  components: string[];
};

export const OFFLINE_ARTICLE_PREFIX = "signal:offline-article:";

export function getOfflineStorageKey(url: string): string {
  return `${OFFLINE_ARTICLE_PREFIX}${url.trim().toLowerCase()}`;
}

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

export function saveOfflineArticleContent(
  url: string,
  article: {
    title: string;
    byline?: string;
    siteName?: string;
    publishedAt?: string;
    paragraphs: string[];
    finalUrl?: string;
  },
  storage?: Storage,
): void {
  try {
    const store = getSafeStorage(storage);
    if (!store) return;
    const key = getOfflineStorageKey(url);
    const data: CachedArticleData = {
      url,
      title: article.title,
      byline: article.byline || "",
      siteName: article.siteName || "",
      publishedAt: article.publishedAt || "",
      paragraphs: article.paragraphs,
      finalUrl: article.finalUrl || url,
      cachedAt: new Date().toISOString(),
    };
    store.setItem(key, JSON.stringify(data));
  } catch {
    // Handle quota errors gracefully
  }
}

export function getCachedOfflineArticle(
  url: string,
  storage?: Storage,
): CachedArticleData | null {
  try {
    const store = getSafeStorage(storage);
    if (!store) return null;
    const key = getOfflineStorageKey(url);
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as CachedArticleData;
  } catch {
    return null;
  }
}

export function clearOfflineArticleContent(
  url: string,
  storage?: Storage,
): void {
  try {
    const store = getSafeStorage(storage);
    if (!store) return;
    store.removeItem(getOfflineStorageKey(url));
  } catch {
    // Ignore
  }
}

/**
 * Prewarms an article for complete offline readability and listening:
 * 1. Fetches full reader paragraphs and caches them in offline storage.
 * 2. Pre-fetches key phrase takeaways.
 * 3. Pre-fetches article sentiment.
 * 4. Pre-fetches recognized entities.
 * 5. Pre-fetches AI photo caption if hero image exists.
 */
export async function prewarmBookmarkedArticle(
  article: { url: string; title: string; imageUrl?: string },
  fetcher: typeof fetch = fetch,
  storage?: Storage,
): Promise<PrewarmResult> {
  const components: string[] = [];

  try {
    // 1. Fetch reader content
    const params = new URLSearchParams({ url: article.url });
    const readerRes = await fetcher(`/api/article-reader?${params.toString()}`, { cache: "no-store" });

    if (readerRes.ok) {
      const data = (await readerRes.json()) as {
        available: boolean;
        article?: {
          title: string;
          byline: string;
          siteName: string;
          publishedAt: string;
          paragraphs: string[];
          finalUrl: string;
        };
      };

      if (data.available && data.article && data.article.paragraphs.length > 0) {
        saveOfflineArticleContent(article.url, data.article, storage);
        components.push("reader-content");

        // 2. Prewarm AI Key Phrases
        try {
          const kp = await loadArticleKeyPhrases(article.url, data.article.title, data.article.paragraphs, undefined, fetcher);
          if (kp.available) components.push("key-phrases");
        } catch {
          // ignore
        }

        // 3. Prewarm Sentiment
        try {
          const sent = await loadArticleSentiment(article.url, data.article.title, data.article.paragraphs, undefined, fetcher);
          if (sent.available) components.push("sentiment");
        } catch {
          // ignore
        }

        // 4. Prewarm Entities
        try {
          const ent = await loadArticleEntities(article.url, data.article.title, data.article.paragraphs, undefined, fetcher);
          if (ent.available) components.push("entities");
        } catch {
          // ignore
        }
      }
    }

    // 5. Prewarm Photo Caption
    if (article.imageUrl && article.imageUrl.startsWith("https://")) {
      try {
        const cap = await loadArticleImageCaption(article.imageUrl, fetcher);
        if (cap.available) components.push("image-caption");
      } catch {
        // ignore
      }
    }

    return {
      success: components.length > 0,
      url: article.url,
      components,
    };
  } catch {
    return {
      success: false,
      url: article.url,
      components,
    };
  }
}

/**
 * Prewarms all bookmarked articles in the background with controlled concurrency.
 */
export async function prewarmAllBookmarkedArticles(
  articles: readonly { url: string; title: string; isBookmarked?: boolean; imageUrl?: string }[],
  fetcher: typeof fetch = fetch,
  maxConcurrent = 2,
  storage?: Storage,
): Promise<number> {
  const bookmarked = articles.filter((a) => a.isBookmarked).slice(0, 15);
  if (bookmarked.length === 0) return 0;

  let prewarmedCount = 0;
  const queue = [...bookmarked];

  const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const res = await prewarmBookmarkedArticle(item, fetcher, storage);
      if (res.success) prewarmedCount += 1;
    }
  });

  await Promise.all(workers);
  return prewarmedCount;
}
