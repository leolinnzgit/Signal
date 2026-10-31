import test from "node:test";
import assert from "node:assert/strict";
import {
  saveOfflineArticleContent,
  getCachedOfflineArticle,
  clearOfflineArticleContent,
  prewarmBookmarkedArticle,
  prewarmAllBookmarkedArticles,
} from "../app/offline-prewarm.ts";

function createMemoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, String(val)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

test("saveOfflineArticleContent saves and retrieves article data", () => {
  const storage = createMemoryStorage();
  const url = "https://example.com/breaking-news";
  const article = {
    title: "Major Climate Agreement Reached",
    byline: "Jane Reporter",
    siteName: "NewsDaily",
    publishedAt: "2026-10-31T08:00:00Z",
    paragraphs: ["Leaders from 50 nations have signed a landmark agreement.", "The pact focuses on clean energy."],
    finalUrl: url,
  };

  saveOfflineArticleContent(url, article, storage);
  const retrieved = getCachedOfflineArticle(url, storage);

  assert.ok(retrieved);
  assert.equal(retrieved.title, "Major Climate Agreement Reached");
  assert.equal(retrieved.paragraphs.length, 2);
  assert.equal(retrieved.byline, "Jane Reporter");

  clearOfflineArticleContent(url, storage);
  assert.equal(getCachedOfflineArticle(url, storage), null);
});

test("prewarmBookmarkedArticle fetches reader and sub-components", async () => {
  const mockFetcher = async (url) => {
    if (url.includes("/api/article-reader")) {
      return {
        ok: true,
        json: async () => ({
          available: true,
          article: {
            title: "Test Story",
            byline: "Reporter",
            siteName: "Source",
            publishedAt: "2026-10-31",
            paragraphs: ["Paragraph one text.", "Paragraph two text."],
            finalUrl: "https://example.com/test",
          },
        }),
      };
    }
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "token" }) };
    }
    if (url.includes("/api/article-keyphrases") || url.includes("/api/article-sentiment")
        || url.includes("/api/article-entities") || url.includes("/api/article-image-caption")) {
      return {
        ok: true,
        json: async () => ({
          available: true,
          caption: "Photo caption",
          keyPhrases: ["Key point"],
          sentiment: "positive",
          entities: [],
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const storage = createMemoryStorage();
  const res = await prewarmBookmarkedArticle(
    { url: "https://example.com/test", title: "Test Story", imageUrl: "https://example.com/photo.jpg" },
    mockFetcher,
    storage,
  );

  assert.equal(res.success, true);
  assert.ok(res.components.includes("reader-content"));
});

test("prewarmAllBookmarkedArticles filters bookmarked stories and runs concurrency", async () => {
  const storage = createMemoryStorage();
  const articles = [
    { url: "https://example.com/1", title: "Story 1", isBookmarked: true },
    { url: "https://example.com/2", title: "Story 2", isBookmarked: false },
    { url: "https://example.com/3", title: "Story 3", isBookmarked: true },
  ];

  const mockFetcher = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      article: { title: "Title", paragraphs: ["P1"], byline: "", siteName: "", publishedAt: "", finalUrl: "" },
    }),
  });

  const count = await prewarmAllBookmarkedArticles(articles, mockFetcher, 2, storage);
  assert.equal(count, 2);
});
