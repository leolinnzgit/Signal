import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityPulse, sortPulseItems } from "../app/entity-pulse.ts";

test("buildEntityPulse returns empty summary when topics list is empty", () => {
  const summary = buildEntityPulse([], []);
  assert.equal(summary.totalTracked, 0);
  assert.equal(summary.surgingCount, 0);
  assert.equal(summary.totalMentionsThisWeek, 0);
  assert.equal(summary.items.length, 0);
});

test("buildEntityPulse computes mentions, trends, and latest articles across topics", () => {
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

test("sortPulseItems correctly orders by momentum, mentions, and alpha", () => {
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
