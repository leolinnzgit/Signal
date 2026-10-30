import assert from "node:assert/strict";
import test from "node:test";
import { getSentimentIcon } from "../app/article-sentiment.ts";

test("getSentimentIcon returns appropriate emojis for sentiments", () => {
  assert.equal(getSentimentIcon("positive"), "😊");
  assert.equal(getSentimentIcon("negative"), "😟");
  assert.equal(getSentimentIcon("mixed"), "⚖️");
  assert.equal(getSentimentIcon("neutral"), "😐");
  assert.equal(getSentimentIcon("unknown"), "😐");
});
