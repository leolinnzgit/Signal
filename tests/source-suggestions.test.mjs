import assert from "node:assert/strict";
import test from "node:test";

import { suggestNewsSources } from "../app/source-suggestions.ts";

test("technology topics prioritize specialist technology feeds", () => {
  const suggestions = suggestNewsSources(["Artificial intelligence"], [], [], 4);
  assert.deepEqual(
    suggestions.slice(0, 3).map((source) => source.name),
    ["Ars Technica", "RNZ Media & Technology", "The Guardian Technology"],
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
  assert.equal(suggestions[0].name, "The Guardian Environment");
});

test("general fallback suggestions include local and international coverage", () => {
  const suggestions = suggestNewsSources(["Chess"], [], [], 3);
  assert.deepEqual(
    suggestions.map((source) => source.name),
    ["RNZ New Zealand", "BBC World", "The Guardian World"],
  );
});
