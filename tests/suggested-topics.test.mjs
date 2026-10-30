import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITY_HISTORY_STORAGE_KEY,
  recordReadArticleEntities,
  getSuggestedTopics,
  loadStoredEntityHistory,
} from "../app/suggested-topics.ts";

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

test("recordReadArticleEntities stores valid entities and ignores noisy categories", () => {
  const storage = createMockStorage();

  const entities = [
    { text: "Reserve Bank", category: "Organization", confidenceScore: 0.95 },
    { text: "Auckland", category: "Location", confidenceScore: 0.92 },
    { text: "100%", category: "Quantity", confidenceScore: 0.8 },
    { text: "x", category: "Person", confidenceScore: 0.9 },
  ];

  recordReadArticleEntities("https://example.com/story-1", entities, storage);

  const history = loadStoredEntityHistory(storage);
  assert.equal(history.length, 2);
  assert.equal(history[0].text, "Reserve Bank");
  assert.equal(history[0].count, 1);
  assert.equal(history[1].text, "Auckland");
  assert.equal(history[1].count, 1);
});

test("recordReadArticleEntities increments count across different stories but not the same story", () => {
  const storage = createMockStorage();

  const entities = [
    { text: "Christopher Luxon", category: "Person", confidenceScore: 0.99 },
  ];

  // Story 1 first read
  recordReadArticleEntities("https://example.com/story-1", entities, storage);
  assert.equal(loadStoredEntityHistory(storage)[0].count, 1);

  // Story 1 repeated read (same URL should not increment)
  recordReadArticleEntities("https://example.com/story-1", entities, storage);
  assert.equal(loadStoredEntityHistory(storage)[0].count, 1);

  // Story 2 read (different URL increments)
  recordReadArticleEntities("https://example.com/story-2", entities, storage);
  assert.equal(loadStoredEntityHistory(storage)[0].count, 2);
});

test("getSuggestedTopics filters already followed topics and ranks by frequency", () => {
  const storage = createMockStorage();

  recordReadArticleEntities(
    "https://example.com/story-1",
    [
      { text: "Reserve Bank", category: "Organization", confidenceScore: 0.95 },
      { text: "Wellington", category: "Location", confidenceScore: 0.92 },
    ],
    storage
  );

  recordReadArticleEntities(
    "https://example.com/story-2",
    [
      { text: "Reserve Bank", category: "Organization", confidenceScore: 0.95 },
      { text: "Auckland", category: "Location", confidenceScore: 0.92 },
    ],
    storage
  );

  // Without following any topic:
  const allSuggestions = getSuggestedTopics([], 5, storage);
  assert.equal(allSuggestions.length, 3);
  assert.equal(allSuggestions[0].text, "Reserve Bank");
  assert.equal(allSuggestions[0].count, 2);

  // When "Reserve Bank" is already followed (case-insensitively):
  const filtered = getSuggestedTopics(["reserve bank"], 5, storage);
  assert.equal(filtered.length, 2);
  assert.equal(filtered.some((t) => t.text === "Reserve Bank"), false);
});
