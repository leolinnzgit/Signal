import test from "node:test";
import assert from "node:assert/strict";
import { loadArticleImageCaption, clearCaptionCache } from "../app/article-image-caption.ts";

test("loadArticleImageCaption returns unavailable for blank image URL", async () => {
  clearCaptionCache();
  const res = await loadArticleImageCaption("");
  assert.equal(res.available, false);
  assert.equal(res.caption, "");
});

test("loadArticleImageCaption fetches and parses AI caption from API", async () => {
  clearCaptionCache();

  const mockFetcher = async (url, init) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "csrf-token" }) };
    }
    if (url.includes("/api/article-image-caption")) {
      assert.equal(init.method, "POST");
      const payload = JSON.parse(init.body);
      assert.equal(payload.imageUrl, "https://example.com/photo.jpg");
      return {
        ok: true,
        json: async () => ({
          available: true,
          reason: "",
          caption: "A busy street market in Auckland",
          confidence: 0.92,
          denseCaptions: ["people shopping", "fruit stall"],
          width: 800,
          height: 600,
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const res = await loadArticleImageCaption("https://example.com/photo.jpg", mockFetcher);
  assert.equal(res.available, true);
  assert.equal(res.caption, "A busy street market in Auckland");
  assert.equal(res.confidence, 0.92);
  assert.equal(res.denseCaptions.length, 2);
  assert.equal(res.width, 800);
});

test("loadArticleImageCaption returns cached response on subsequent calls", async () => {
  clearCaptionCache();
  let calls = 0;

  const mockFetcher = async (url) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "csrf-token" }) };
    }
    calls++;
    return {
      ok: true,
      json: async () => ({
        available: true,
        reason: "",
        caption: "A mountain landscape",
        confidence: 0.95,
        denseCaptions: [],
        width: 1024,
        height: 768,
      }),
    };
  };

  const res1 = await loadArticleImageCaption("https://example.com/mountain.jpg", mockFetcher);
  const res2 = await loadArticleImageCaption("https://example.com/mountain.jpg", mockFetcher);

  assert.equal(calls, 1);
  assert.equal(res1.caption, "A mountain landscape");
  assert.equal(res2.caption, "A mountain landscape");
});
