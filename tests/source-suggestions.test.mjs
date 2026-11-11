import assert from "node:assert/strict";
import test from "node:test";

import { SOURCE_SUGGESTIONS, suggestNewsSources } from "../app/source-suggestions.ts";

test("technology topics prioritize specialist technology feeds", () => {
  const suggestions = suggestNewsSources(["Artificial intelligence"], [], [], 4);
  assert.deepEqual(
    suggestions.slice(0, 3).map((source) => source.name),
    ["Ars Technica", "RNZ Media & Technology", "The Guardian Technology"],
  );
  assert.equal(
    suggestions.find((source) => source.name === "The Guardian Technology")?.feed,
    "https://www.theguardian.com/uk/technology/rss",
  );
});

test("already-added feeds are not suggested", () => {
  const suggestions = suggestNewsSources(
    ["Climate change"],
    [],
    ["https://www.rnz.co.nz/rss/environment.xml"],
    4,
  );
  assert.equal(suggestions.some((source) => source.name === "RNZ Environment"), false);
  assert.equal(suggestions.some((source) => source.name.startsWith("RNZ ")), false);
  assert.equal(suggestions[0].name, "The Guardian Environment");
});

test("redirected Guardian edition feeds are recognized as already added", () => {
  const suggestions = suggestNewsSources(
    ["Artificial intelligence"],
    [],
    ["https://www.theguardian.com/uk/technology/rss"],
    10,
  );
  assert.equal(
    suggestions.some((source) => source.name.startsWith("The Guardian ")),
    false,
  );
});

test("suggestions contain only one feed from each publisher", () => {
  const suggestions = suggestNewsSources(
    ["Artificial intelligence", "Climate change", "Business"],
    [],
    [],
    10,
  );
  const publisherGroups = suggestions.map((source) => source.publisherAliases[0]);
  assert.equal(new Set(publisherGroups).size, publisherGroups.length);
});

test("general fallback suggestions include local and international coverage", () => {
  const suggestions = suggestNewsSources(["Chess"], [], [], 3);
  assert.deepEqual(
    suggestions.map((source) => source.name),
    ["RNZ New Zealand", "BBC World", "The Guardian World"],
  );
});

test("specialist topics prioritize semiconductors, robotics, clean energy and markets", () => {
  const chipAndRobotSuggestions = suggestNewsSources(["NVIDIA", "TSMC", "Robotics"], [], [], 4);
  assert.ok(chipAndRobotSuggestions.some((source) => source.name === "IEEE Spectrum"));
  assert.ok(chipAndRobotSuggestions.some((source) => source.name === "Wccftech" || source.name === "TechNews 科技新報"));

  const energySuggestions = suggestNewsSources(["Solar", "Tesla", "Renewable Energy"], [], [], 4);
  assert.equal(energySuggestions[0].name, "Electrek");
  assert.equal(energySuggestions[1].name, "CleanTechnica");

  const marketSuggestions = suggestNewsSources(["Stock Market", "Warren Buffett"], [], [], 4);
  assert.ok(marketSuggestions.some((source) => source.name === "Wall Street Journal Markets"));
  assert.ok(marketSuggestions.some((source) => source.name === "MarketWatch"));
});

test("CJK topics match Taiwan and Greater China publishers including compound phrases", () => {
  const suggestions = suggestNewsSources(["台積電", "輝達", "美國政府"], [], [], 5);
  assert.ok(suggestions.some((source) => source.name === "TechNews 科技新報"));
  assert.ok(suggestions.some((source) => source.name === "Liberty Times 自由時報"));
});

test("redirected canonical URLs suppress already-added publishers", () => {
  const suggestions = suggestNewsSources(
    ["Stock Market", "Taiwan", "China"],
    [],
    [
      "https://www.ft.com/rss/home",
      "https://www.twreporter.org/a/rss2.xml",
      "https://rthk.hk/rthk/news/rss/c_expressnews_greaterchina.xml",
    ],
    100,
  );
  assert.equal(suggestions.some((source) => source.name === "Financial Times"), false);
  assert.equal(suggestions.some((source) => source.name === "The Reporter 報導者"), false);
  assert.equal(suggestions.some((source) => source.name === "RTHK Greater China"), false);
});

test("all source suggestions use valid HTTPS URLs with unique feeds and sequential ranks", () => {
  const feeds = new Set();
  const ranks = new Set();
  for (const source of SOURCE_SUGGESTIONS) {
    assert.ok(source.feed.startsWith("https://"), `${source.name} must use HTTPS`);
    assert.ok(!feeds.has(source.feed), `Duplicate feed URL: ${source.feed}`);
    assert.ok(!ranks.has(source.fallbackRank), `Duplicate fallbackRank: ${source.fallbackRank}`);
    assert.ok(source.topicTerms.length > 0, `${source.name} must have topicTerms`);
    assert.ok(source.publisherAliases.length > 0, `${source.name} must have publisherAliases`);
    feeds.add(source.feed);
    ranks.add(source.fallbackRank);
  }
});
