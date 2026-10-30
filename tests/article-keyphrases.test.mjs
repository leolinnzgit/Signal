import assert from "node:assert/strict";
import test from "node:test";
import { loadArticleKeyPhrases } from "../app/article-keyphrases.ts";

test("loadArticleKeyPhrases requests API and caches results", async () => {
  let callCount = 0;
  const fakeFetcher = async (url, init) => {
    callCount++;
    assert.equal(url, "/api/article-keyphrases");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(init?.body);
    assert.equal(body.url, "https://example.com/ai");
    return {
      ok: true,
      json: async () => ({
        available: true,
        reason: "",
        keyPhrases: ["cloud AI advancements", "Satya Nadella", "Microsoft Azure"],
      }),
    };
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetcher;
  try {
    const res1 = await loadArticleKeyPhrases("https://example.com/ai", "AI News", ["Paragraph one."]);
    assert.equal(res1.available, true);
    assert.equal(res1.keyPhrases.length, 3);
    assert.equal(res1.keyPhrases[0], "cloud AI advancements");
    assert.equal(callCount, 1);

    // Second call should come from cache
    const res2 = await loadArticleKeyPhrases("https://example.com/ai", "AI News", ["Paragraph one."]);
    assert.equal(res2.available, true);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
