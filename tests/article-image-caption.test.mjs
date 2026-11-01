import test from "node:test";
import assert from "node:assert/strict";
import {
  loadArticleImageCaption,
  loadArticleImageOcr,
  clearCaptionCache,
  formatFocalObjectPosition,
  getCachedImageFocalPoint,
  saveCachedImageFocalPoint,
  enqueueLazyImageFocalAnalysis,
} from "../app/article-image-caption.ts";

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

test("loadArticleImageCaption returns unavailable for blank image URL", async () => {
  clearCaptionCache();
  const res = await loadArticleImageCaption("");
  assert.equal(res.available, false);
  assert.equal(res.caption, "");
  assert.equal(res.focalX, 0.5);
  assert.equal(res.focalY, 0.5);
});

test("loadArticleImageCaption fetches caption and smart focal coordinates and persists focal point", async () => {
  const storage = createMemoryStorage();
  clearCaptionCache(storage);

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
          height: 1200,
          focalX: 0.65,
          focalY: 0.125,
          smartCrops: [{ aspectRatio: 1.6, x: 0, y: 88, width: 800, height: 500 }],
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const res = await loadArticleImageCaption("https://example.com/photo.jpg", mockFetcher, undefined, storage);
  assert.equal(res.available, true);
  assert.equal(res.caption, "A busy street market in Auckland");
  assert.equal(res.confidence, 0.92);
  assert.equal(res.denseCaptions.length, 2);
  assert.equal(res.width, 800);
  assert.equal(res.focalX, 0.65);
  assert.equal(res.focalY, 0.125);
  assert.equal(res.smartCrops?.length, 1);

  // Even after clearing in-memory cache (simulating page reload), localStorage retains focal point
  clearCaptionCache();
  const persisted = getCachedImageFocalPoint("https://example.com/photo.jpg", storage);
  assert.deepEqual(persisted, { focalX: 0.65, focalY: 0.125 });
  assert.equal(formatFocalObjectPosition(persisted), "65% 12.5%");
});

test("loadArticleImageCaption deduplicates concurrent in-flight requests and caches result", async () => {
  clearCaptionCache();
  let captionCalls = 0;

  const mockFetcher = async (url) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "csrf-token" }) };
    }
    captionCalls++;
    await new Promise((resolve) => setTimeout(resolve, 15));
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
        focalX: 0.4,
        focalY: 0.25,
        smartCrops: [],
      }),
    };
  };

  const [res1, res2] = await Promise.all([
    loadArticleImageCaption("https://example.com/mountain.jpg", mockFetcher),
    loadArticleImageCaption("https://example.com/mountain.jpg", mockFetcher),
  ]);
  const res3 = await loadArticleImageCaption("https://example.com/mountain.jpg", mockFetcher);

  assert.equal(captionCalls, 1);
  assert.equal(res1.caption, "A mountain landscape");
  assert.equal(res2.focalX, 0.4);
  assert.equal(res3.focalY, 0.25);
});

test("formatFocalObjectPosition clamps out-of-range coordinates and defaults cleanly", () => {
  assert.equal(formatFocalObjectPosition(null), "50% 50%");
  assert.equal(formatFocalObjectPosition({ focalX: -0.4, focalY: 1.5 }), "0% 100%");
  assert.equal(formatFocalObjectPosition({ focalX: 0.8, focalY: 0.1 }), "80% 10%");

  const storage = createMemoryStorage();
  saveCachedImageFocalPoint("https://example.com/portrait.jpg", { focalX: 0.5, focalY: 0.086 }, storage);
  assert.deepEqual(getCachedImageFocalPoint("https://example.com/portrait.jpg", storage), {
    focalX: 0.5,
    focalY: 0.086,
  });
});

test("enqueueLazyImageFocalAnalysis pauses subsequent lazy thumbnail requests when Vision is unconfigured", async () => {
  clearCaptionCache();
  let apiCalls = 0;

  const unconfiguredFetcher = async (url) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "csrf-token" }) };
    }
    apiCalls++;
    return {
      ok: true,
      json: async () => ({
        available: false,
        reason: "Azure AI Vision has not been configured yet.",
        caption: "",
        confidence: 0,
        denseCaptions: [],
        width: 0,
        height: 0,
      }),
    };
  };

  await new Promise((resolve) => {
    enqueueLazyImageFocalAnalysis("https://example.com/thumb1.jpg", () => resolve(), unconfiguredFetcher);
  });
  assert.equal(apiCalls, 1);

  // Subsequent lazy enqueue should be suppressed during cooldown without calling the API
  let secondCallbackCalled = false;
  enqueueLazyImageFocalAnalysis("https://example.com/thumb2.jpg", () => {
    secondCallbackCalled = true;
  }, unconfiguredFetcher);

  assert.equal(apiCalls, 1);
  assert.equal(secondCallbackCalled, false);
});

test("loadArticleImageOcr handles blank URLs, deduplicates concurrent OCR requests, and caches results", async () => {
  clearCaptionCache();

  const blank = await loadArticleImageOcr("   ");
  assert.equal(blank.available, false);
  assert.equal(blank.lineCount, 0);

  let ocrCalls = 0;
  const mockFetcher = async (url, init) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "ocr-csrf-token" }) };
    }
    if (url.includes("/api/article-image-caption/ocr")) {
      ocrCalls++;
      assert.equal(init.method, "POST");
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        ok: true,
        json: async () => ({
          available: true,
          reason: "",
          text: "OFFICIAL CASH RATE\n4.25% (-50 bps)",
          lines: ["OFFICIAL CASH RATE", "4.25% (-50 bps)"],
          lineCount: 2,
        }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const [first, second] = await Promise.all([
    loadArticleImageOcr("https://example.com/rbnz-chart.png", mockFetcher),
    loadArticleImageOcr("https://example.com/rbnz-chart.png", mockFetcher),
  ]);
  const cached = await loadArticleImageOcr("https://example.com/rbnz-chart.png", mockFetcher);

  assert.equal(ocrCalls, 1);
  assert.equal(first.available, true);
  assert.equal(first.lineCount, 2);
  assert.deepEqual(second.lines, ["OFFICIAL CASH RATE", "4.25% (-50 bps)"]);
  assert.equal(cached.text, "OFFICIAL CASH RATE\n4.25% (-50 bps)");
});

test("loadArticleImageOcr caches confirmed empty-text responses to avoid duplicate Vision Read calls", async () => {
  clearCaptionCache();
  let ocrCalls = 0;

  const emptyOcrFetcher = async (url) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "ocr-csrf-token" }) };
    }
    ocrCalls++;
    return {
      ok: true,
      json: async () => ({
        available: false,
        reason: "No readable text was detected in this image.",
        text: "",
        lines: [],
        lineCount: 0,
      }),
    };
  };

  const first = await loadArticleImageOcr("https://example.com/scenic-photo.jpg", emptyOcrFetcher);
  const second = await loadArticleImageOcr("https://example.com/scenic-photo.jpg", emptyOcrFetcher);

  assert.equal(first.available, false);
  assert.equal(second.available, false);
  assert.equal(ocrCalls, 1);
});
