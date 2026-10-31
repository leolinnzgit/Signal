import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyHeadlineSentiment,
  clearSentimentCache,
  getCachedArticleSentiment,
  getSentimentIcon,
  loadArticleSentiment,
  recordArticleSentiment,
  resolveArticleSentiment,
} from "../app/article-sentiment.ts";

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    key(index) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

test("getSentimentIcon returns appropriate emojis for sentiments", () => {
  assert.equal(getSentimentIcon("positive"), "😊");
  assert.equal(getSentimentIcon("negative"), "😟");
  assert.equal(getSentimentIcon("mixed"), "⚖️");
  assert.equal(getSentimentIcon("neutral"), "😐");
  assert.equal(getSentimentIcon("unknown"), "😐");
});

test("classifyHeadlineSentiment detects positive, negative, mixed, and neutral news framing without API calls", () => {
  const pos = classifyHeadlineSentiment("Solar breakthrough drives record clean energy growth");
  assert.equal(pos.sentiment, "positive");
  assert.ok(pos.positiveScore > pos.negativeScore);

  const neg = classifyHeadlineSentiment("Major airline faces crisis after outage and safety probe");
  assert.equal(neg.sentiment, "negative");
  assert.ok(neg.negativeScore > pos.negativeScore);

  const mixed = classifyHeadlineSentiment("Company posts record profit despite union strike");
  assert.equal(mixed.sentiment, "mixed");

  const neutral = classifyHeadlineSentiment("Reserve Bank schedules quarterly policy statement for Wednesday");
  assert.equal(neutral.sentiment, "neutral");
});

test("recordArticleSentiment persists Azure sentiment across cache clears and overrides heuristic", async () => {
  const storage = createMemoryStorage();
  clearSentimentCache(storage);

  const mockFetcher = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      sentiment: "negative",
      positiveScore: 0.05,
      neutralScore: 0.15,
      negativeScore: 0.8,
    }),
  });

  const fetched = await loadArticleSentiment(
    "https://example.com/story-1",
    "Neutral looking headline",
    ["Full body text reveals critical audit findings."],
    undefined,
    mockFetcher,
    storage,
  );
  assert.equal(fetched.sentiment, "negative");

  // Clear in-memory cache to verify localStorage hydration
  clearSentimentCache();
  const hydrated = getCachedArticleSentiment("https://example.com/story-1", storage);
  assert.ok(hydrated);
  assert.equal(hydrated.sentiment, "negative");
  assert.equal(hydrated.negativeScore, 0.8);

  // resolveArticleSentiment should prefer cached Azure result over headline heuristic
  const resolved = resolveArticleSentiment(
    {
      url: "https://example.com/story-1",
      title: "Record breakthrough victory celebration",
    },
    storage,
  );
  assert.equal(resolved.source, "azure");
  assert.equal(resolved.sentiment, "negative");

  // Uncached article uses zero-API heuristic
  recordArticleSentiment("https://example.com/other", {
    available: true,
    sentiment: "positive",
    positiveScore: 0.9,
    neutralScore: 0.05,
    negativeScore: 0.05,
  }, storage);
  const heuristicResolved = resolveArticleSentiment(
    {
      url: "https://example.com/uncached",
      title: "Tech sector celebrates milestone partnership",
    },
    storage,
  );
  assert.equal(heuristicResolved.source, "heuristic");
  assert.equal(heuristicResolved.sentiment, "positive");
});
