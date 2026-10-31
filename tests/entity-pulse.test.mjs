import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityPulse, sortPulseItems } from "../app/entity-pulse.ts";
import { clearSentimentCache, recordArticleSentiment } from "../app/article-sentiment.ts";

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

test("buildEntityPulse returns empty summary when topics list is empty", () => {
  const summary = buildEntityPulse([], []);
  assert.equal(summary.totalTracked, 0);
  assert.equal(summary.surgingCount, 0);
  assert.equal(summary.totalMentionsThisWeek, 0);
  assert.equal(summary.items.length, 0);
  assert.equal(summary.overallSentiment.analyzedCount, 0);
  assert.equal(summary.overallSentiment.dominantTone, "none");
});

test("buildEntityPulse computes mentions, trends, and latest articles across topics", () => {
  clearSentimentCache();
  const ref = new Date("2026-10-31T12:00:00Z");
  const topics = ["Christopher Luxon", "OpenAI", "Wellington"];
  const articles = [
    {
      url: "https://example.com/1",
      title: "OpenAI announces breakthrough model",
      source: "TechNews",
      publishedAt: "2026-10-31T09:00:00Z",
    },
    {
      url: "https://example.com/2",
      title: "More reaction to OpenAI release",
      source: "Stuff",
      publishedAt: "2026-10-31T08:00:00Z",
    },
    {
      url: "https://example.com/3",
      title: "OpenAI partners with universities",
      source: "RNZ",
      publishedAt: "2026-10-30T14:00:00Z",
    },
    {
      url: "https://example.com/4",
      title: "Christopher Luxon addresses national council",
      source: "NZ Herald",
      publishedAt: "2026-10-31T11:00:00Z",
    },
  ];

  const storedHistory = [
    { text: "Christopher Luxon", category: "Person", count: 5, lastSeen: "2026-10-31", articles: [] },
    { text: "OpenAI", category: "Organization", count: 8, lastSeen: "2026-10-31", articles: [] },
  ];

  const summary = buildEntityPulse(topics, articles, storedHistory, 7, ref);

  assert.equal(summary.totalTracked, 3);
  assert.equal(summary.totalMentionsThisWeek, 4);

  // OpenAI should have 3 mentions and be surging
  const openAiItem = summary.items.find((i) => i.topic === "OpenAI");
  assert.ok(openAiItem);
  assert.equal(openAiItem.stats.totalMentions, 3);
  assert.equal(openAiItem.stats.trend, "surging");
  assert.equal(openAiItem.category, "Organization");
  assert.equal(openAiItem.latestArticle?.title, "OpenAI announces breakthrough model");
  assert.equal(openAiItem.sentiment.analyzedCount, 3);

  // Christopher Luxon should have 1 mention and category Person
  const luxonItem = summary.items.find((i) => i.topic === "Christopher Luxon");
  assert.ok(luxonItem);
  assert.equal(luxonItem.stats.totalMentions, 1);
  assert.equal(luxonItem.category, "Person");
  assert.equal(luxonItem.latestArticle?.source, "NZ Herald");

  // Summary should show 1 surging topic
  assert.equal(summary.surgingCount, 1);
  assert.equal(summary.topSurging?.topic, "OpenAI");
});

test("buildEntityPulse computes sentiment distribution percentages, momentum shifts, and respects cached Azure sentiment", () => {
  const storage = createMemoryStorage();
  clearSentimentCache(storage);

  const ref = new Date("2026-10-31T12:00:00Z");
  const topics = ["Rocket Lab", "Boeing"];

  const articles = [
    // Rocket Lab: 3 positive recent, 1 older negative -> 75% positive, improving momentum!
    {
      url: "https://example.com/rl-1",
      title: "Rocket Lab celebrates historic launch victory",
      source: "RNZ",
      publishedAt: "2026-10-31T08:00:00Z",
    },
    {
      url: "https://example.com/rl-2",
      title: "Rocket Lab signs record satellite partnership",
      source: "Stuff",
      publishedAt: "2026-10-31T06:00:00Z",
    },
    {
      url: "https://example.com/rl-3",
      title: "Rocket Lab quarterly operational update",
      source: "NZ Herald",
      publishedAt: "2026-10-30T10:00:00Z",
    },
    {
      url: "https://example.com/rl-4",
      title: "Rocket Lab faces weather delay and warning",
      source: "Stuff",
      publishedAt: "2026-10-27T10:00:00Z",
    },
    // Boeing: 1 older positive, 2 recent critical -> 67% critical, cooling momentum!
    {
      url: "https://example.com/ba-1",
      title: "Boeing faces safety probe after strike and losses",
      source: "Reuters",
      publishedAt: "2026-10-31T09:00:00Z",
    },
    {
      url: "https://example.com/ba-2",
      title: "Boeing warns of deeper deficit and layoffs",
      source: "AP",
      publishedAt: "2026-10-30T15:00:00Z",
    },
    {
      url: "https://example.com/ba-3",
      title: "Boeing secures airline order deal and recovery boost",
      source: "Bloomberg",
      publishedAt: "2026-10-26T12:00:00Z",
    },
  ];

  // Cache an authoritative Azure Language positive sentiment for rl-3 (neutral title)
  recordArticleSentiment(
    "https://example.com/rl-3",
    {
      available: true,
      sentiment: "positive",
      positiveScore: 0.88,
      neutralScore: 0.1,
      negativeScore: 0.02,
    },
    storage,
  );

  const summary = buildEntityPulse(topics, articles, [], 7, ref, storage);

  const rocketLab = summary.items.find((i) => i.topic === "Rocket Lab");
  assert.ok(rocketLab);
  assert.equal(rocketLab.sentiment.analyzedCount, 4);
  assert.equal(rocketLab.sentiment.azureCount, 1);
  assert.equal(rocketLab.sentiment.positiveCount, 3);
  assert.equal(rocketLab.sentiment.negativeCount, 1);
  assert.equal(rocketLab.sentiment.positivePercent, 75);
  assert.equal(rocketLab.sentiment.negativePercent, 25);
  assert.equal(rocketLab.sentiment.dominantTone, "positive");
  assert.equal(rocketLab.sentiment.toneLabel, "75% positive coverage");
  assert.equal(rocketLab.sentiment.momentum, "improving");

  const boeing = summary.items.find((i) => i.topic === "Boeing");
  assert.ok(boeing);
  assert.equal(boeing.sentiment.analyzedCount, 3);
  assert.equal(boeing.sentiment.negativeCount, 2);
  assert.equal(boeing.sentiment.positiveCount, 1);
  assert.equal(boeing.sentiment.negativePercent, 67);
  assert.equal(boeing.sentiment.dominantTone, "negative");
  assert.equal(boeing.sentiment.toneLabel, "67% critical tone");
  assert.equal(boeing.sentiment.momentum, "cooling");

  const byPositive = sortPulseItems(summary.items, "sentiment-positive");
  assert.equal(byPositive[0].topic, "Rocket Lab");
  assert.equal(byPositive[1].topic, "Boeing");

  const byCritical = sortPulseItems(summary.items, "sentiment-critical");
  assert.equal(byCritical[0].topic, "Boeing");
  assert.equal(byCritical[1].topic, "Rocket Lab");
});

test("sortPulseItems correctly orders by momentum, mentions, and alpha", () => {
  clearSentimentCache();
  const ref = new Date("2026-10-31T12:00:00Z");
  const topics = ["Wellington", "OpenAI", "Auckland"];
  const articles = [
    { url: "https://example.com/1", title: "OpenAI release 1", source: "A", publishedAt: "2026-10-31" },
    { url: "https://example.com/2", title: "OpenAI release 2", source: "A", publishedAt: "2026-10-31" },
    { url: "https://example.com/3", title: "OpenAI release 3", source: "A", publishedAt: "2026-10-30" },
    { url: "https://example.com/4", title: "Wellington update", source: "B", publishedAt: "2026-10-31" },
  ];

  const summary = buildEntityPulse(topics, articles, [], 7, ref);

  const byMentions = sortPulseItems(summary.items, "mentions");
  assert.equal(byMentions[0].topic, "OpenAI");
  assert.equal(byMentions[1].topic, "Wellington");
  assert.equal(byMentions[2].topic, "Auckland");

  const byAlpha = sortPulseItems(summary.items, "alpha");
  assert.equal(byAlpha[0].topic, "Auckland");
  assert.equal(byAlpha[1].topic, "OpenAI");
  assert.equal(byAlpha[2].topic, "Wellington");
});
