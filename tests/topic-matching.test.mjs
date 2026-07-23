import assert from "node:assert/strict";
import test from "node:test";
import { topicMatchesText } from "../app/api/news/topic-matching.ts";

test("matches exact phrases and complete meaningful topic words", () => {
  assert.equal(topicMatchesText("New Zealand economy faces a slower recovery", "New Zealand economy"), true);
  assert.equal(topicMatchesText("Economy outlook improves across New Zealand", "New Zealand economy"), true);
  assert.equal(topicMatchesText("New AI regulation proposed for health systems", "AI regulation"), true);
});

test("rejects partial, one-word, and substring-only matches", () => {
  assert.equal(topicMatchesText("New species discovered near Australia", "New Zealand economy"), false);
  assert.equal(topicMatchesText("Regulation changes affect local councils", "AI regulation"), false);
  assert.equal(topicMatchesText("Painting exhibition opens downtown", "AI"), false);
});

test("requires exact tokens for short topics", () => {
  assert.equal(topicMatchesText("AI tools reshape software development", "AI"), true);
  assert.equal(topicMatchesText("UK election campaign enters its final week", "UK"), true);
  assert.equal(topicMatchesText("Ukraine election reporting continues", "UK"), false);
});
