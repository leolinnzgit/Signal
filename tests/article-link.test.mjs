import assert from "node:assert/strict";
import test from "node:test";
import { parseSignalArticleLink, signalArticlePath } from "../app/article-link.ts";

test("news links stay in Signal and preserve the exact story address and title", () => {
  const article = { url: "https://news.example/story?id=123&lang=zh#section-2", title: "世界新闻 & a new discovery", source: "Signal community" };
  const path = signalArticlePath(article);
  assert.ok(path.startsWith("/?article="));
  assert.deepEqual(parseSignalArticleLink(new URL(path, "https://signal.example").search), article);
});

test("invalid story URLs cannot become a navigation request", () => {
  for (const value of ["", "/api/auth/logout", "//example.com/story", "javascript:alert(1)", "data:text/html,test", "file:///C:/secret", "https://name:password@example.com/story", "https://example.com/" + "x".repeat(2048)]) {
    assert.equal(parseSignalArticleLink(`?article=${encodeURIComponent(value)}`), null);
  }
  assert.equal(parseSignalArticleLink("?auth=reset"), null);
});

test("direct news links default missing metadata and bound titles and sources", () => {
  assert.deepEqual(parseSignalArticleLink("?article=https%3A%2F%2Fexample.com%2Fstory"), {
    url: "https://example.com/story", title: "News story", source: "Signal community",
  });
  const result = parseSignalArticleLink(`?${new URLSearchParams({ article: "http://example.com/story", title: "x".repeat(900), source: "y".repeat(900) })}`);
  assert.equal(result.title.length, 500);
  assert.equal(result.source.length, 256);
});
