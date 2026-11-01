import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesKeyword,
  isArticleMuted,
  isArticleWatchMatch,
} from "../app/noise-cancellation.ts";

test("matchesKeyword identifies substring case-insensitively", () => {
  assert.equal(matchesKeyword("SpaceX launches Starship from Texas", "spacex"), true);
  assert.equal(matchesKeyword("SpaceX launches Starship from Texas", "STARSHIP"), true);
  assert.equal(matchesKeyword("SpaceX launches Starship from Texas", "Boeing"), false);
});

test("isArticleMuted filters muted keywords in moderate and strict mode", () => {
  const moderateRules = {
    watchKeywords: [],
    mutedKeywords: ["gossip", "celebrity", "tabloid"],
    noiseCancellationLevel: "moderate",
  };

  const offRules = {
    ...moderateRules,
    noiseCancellationLevel: "off",
  };

  const gossipArticle = {
    title: "Celebrity spotted leaving cafe in London",
    summary: "Tabloid sources claim romance.",
  };

  const techArticle = {
    title: "Quantum processor achieves error correction milestone",
    summary: "Researchers demonstrate logical qubit scaling.",
  };

  assert.equal(isArticleMuted(gossipArticle, moderateRules), true);
  assert.equal(isArticleMuted(techArticle, moderateRules), false);
  assert.equal(isArticleMuted(gossipArticle, offRules), false);
});

test("isArticleWatchMatch flags articles with watched keywords", () => {
  const rules = {
    watchKeywords: ["Quantum", "RBNZ", "AI"],
    mutedKeywords: [],
    noiseCancellationLevel: "moderate",
  };

  const matchArticle = {
    title: "RBNZ announces official cash rate decision",
    summary: "Monetary policy committee maintains rate.",
  };

  const noMatchArticle = {
    title: "Local football club wins championship",
    summary: "Victory parade scheduled for Saturday.",
  };

  assert.equal(isArticleWatchMatch(matchArticle, rules), true);
  assert.equal(isArticleWatchMatch(noMatchArticle, rules), false);
});
