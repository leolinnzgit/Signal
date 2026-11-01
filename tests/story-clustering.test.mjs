import test from "node:test";
import assert from "node:assert/strict";
import {
  extractContentTokens,
  computeJaccardSimilarity,
  areArticlesSimilar,
  clusterArticles,
  synthesizeClusterLocally,
  loadClusterSynthesis,
} from "../app/story-clustering.ts";

test("extractContentTokens extracts significant keywords and numbers while removing stop words", () => {
  const tokens = extractContentTokens("Reserve Bank cuts OCR by 50 basis points to 4.25% amid inflation drop");
  assert.ok(tokens.has("reserve"));
  assert.ok(tokens.has("bank"));
  assert.ok(tokens.has("cuts"));
  assert.ok(tokens.has("ocr"));
  assert.ok(tokens.has("50"));
  assert.ok(tokens.has("4.25%"));
  assert.ok(tokens.has("inflation"));
  assert.ok(!tokens.has("by"));
  assert.ok(!tokens.has("to"));
  assert.ok(!tokens.has("amid"));
});

test("computeJaccardSimilarity measures token set overlap cleanly", () => {
  assert.equal(computeJaccardSimilarity(new Set(), new Set(["test"])), 0);
  const a = new Set(["reserve", "bank", "ocr", "cuts"]);
  const b = new Set(["reserve", "bank", "ocr", "slashes"]);
  // 3 shared / 5 union = 0.6
  assert.equal(computeJaccardSimilarity(a, b), 0.6);
});

test("areArticlesSimilar detects breaking news coverage of the same event across publishers", () => {
  const storyA = {
    title: "Reserve Bank cuts OCR by 50 basis points to 4.25%",
    publishedAt: "2026-10-31T08:00:00Z",
  };
  const storyB = {
    title: "RBNZ cuts OCR to 4.25% as inflation slows",
    publishedAt: "2026-10-31T08:15:00Z",
  };
  const storyC = {
    title: "SpaceX successfully launches 24 Starlink satellites into orbit",
    publishedAt: "2026-10-31T09:00:00Z",
  };

  assert.equal(areArticlesSimilar(storyA, storyB), true);
  assert.equal(areArticlesSimilar(storyA, storyC), false);

  // Time difference > 60 hours rejects pairing even with common words
  const oldStory = {
    title: "Reserve Bank cuts OCR by 50 basis points to 4.25%",
    publishedAt: "2026-10-10T08:00:00Z",
  };
  assert.equal(areArticlesSimilar(storyA, oldStory), false);
});

test("clusterArticles groups matching stories under lead item and computes sentiment tone breakdown", () => {
  const articles = [
    {
      url: "https://example.com/rnz-ocr",
      title: "Reserve Bank cuts OCR by 50 basis points to 4.25%",
      source: "RNZ",
      publishedAt: "2026-10-31T08:00:00Z",
      summary: "The central bank lowered rates on Wednesday.",
      topics: ["Economy"],
      providers: ["RSS"],
    },
    {
      url: "https://example.com/spacex",
      title: "SpaceX launches new lunar communication payload",
      source: "TechNews",
      publishedAt: "2026-10-31T08:30:00Z",
      summary: "Falcon 9 lifted off from Florida.",
      topics: ["Space"],
      providers: ["RSS"],
    },
    {
      url: "https://example.com/stuff-ocr",
      title: "RBNZ slashes OCR to 4.25% offering mortgage relief",
      source: "Stuff",
      publishedAt: "2026-10-31T08:15:00Z",
      summary: "Floating rates drop immediately across retail lenders.",
      topics: ["Economy"],
      providers: ["Google News"],
    },
    {
      url: "https://example.com/herald-ocr",
      title: "OCR cut: Economists warn labour market challenges remain at 4.25%",
      source: "NZ Herald",
      publishedAt: "2026-10-31T08:45:00Z",
      summary: "Unemployment expected to rise into next quarter.",
      topics: ["Economy"],
      providers: ["RSS"],
    },
  ];

  const clustered = clusterArticles(articles);
  // 4 input articles: 3 form an OCR cluster, 1 is standalone SpaceX -> 2 feed items emitted!
  assert.equal(clustered.length, 2);

  const ocrItem = clustered.find((i) => i.article.url === "https://example.com/rnz-ocr");
  assert.ok(ocrItem);
  assert.ok(ocrItem.cluster);
  assert.equal(ocrItem.cluster.articles.length, 3);
  assert.deepEqual(ocrItem.cluster.sources.sort(), ["NZ Herald", "RNZ", "Stuff"]);

  const spaceItem = clustered.find((i) => i.article.url === "https://example.com/spacex");
  assert.ok(spaceItem);
  assert.equal(spaceItem.cluster, undefined);
});

test("synthesizeClusterLocally builds attributed cross-publisher brief without cloud calls", () => {
  const articles = [
    {
      url: "https://example.com/1",
      title: "Reserve Bank cuts OCR by 50 basis points to 4.25%.",
      source: "RNZ",
      summary: "The monetary committee decided on Wednesday.",
      topics: [],
      providers: [],
    },
    {
      url: "https://example.com/2",
      title: "Mortgage rates tumble after OCR decision.",
      source: "Stuff",
      summary: "Banks immediately reduced floating home loans.",
      topics: [],
      providers: [],
    },
  ];

  const paragraphs = synthesizeClusterLocally(articles);
  assert.equal(paragraphs.length, 1);
  assert.match(paragraphs[0], /RNZ and Stuff/);
  assert.match(paragraphs[0], /Reserve Bank cuts OCR/);
  assert.match(paragraphs[0], /Stuff/);
});

test("loadClusterSynthesis calls server endpoint with CSRF and falls back to local synthesis cleanly", async () => {
  const articles = [
    {
      url: "https://example.com/1",
      title: "Auckland rail expansion approved.",
      source: "RNZ",
      summary: "Funding approved for transport network.",
      topics: [],
      providers: [],
    },
    {
      url: "https://example.com/2",
      title: "Auckland rail network secures transport funding.",
      source: "Stuff",
      summary: "Government commits $1.2B to line extensions.",
      topics: [],
      providers: [],
    },
  ];

  // 1. Mock successful Azure cloud synthesis
  let calledUrl = "";
  let calledToken = "";
  const cloudFetcher = async (url, init) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "cluster-csrf-xyz" }) };
    }
    calledUrl = url;
    calledToken = init.headers["X-XSRF-TOKEN"];
    return {
      ok: true,
      json: async () => ({
        available: true,
        reason: "",
        paragraphs: [
          "Auckland rail expansion secured $1.2B in government funding. Both RNZ and Stuff report completion is expected by 2030.",
        ],
        sourceCount: 2,
      }),
    };
  };

  const cloudRes = await loadClusterSynthesis(articles, undefined, cloudFetcher);
  assert.equal(cloudRes.available, true);
  assert.equal(cloudRes.source, "azure");
  assert.equal(cloudRes.paragraphs.length, 1);
  assert.equal(calledUrl, "/api/story-cluster/synthesize");
  assert.equal(calledToken, "cluster-csrf-xyz");

  // 2. Unconfigured / error fallback to local synthesis
  const failingFetcher = async (url) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "cluster-csrf-xyz" }) };
    }
    return {
      ok: true,
      json: async () => ({
        available: false,
        reason: "Azure article summaries have not been configured yet.",
        paragraphs: [],
        sourceCount: 2,
      }),
    };
  };

  const localRes = await loadClusterSynthesis(
    [
      {
        url: "https://example.com/other-1",
        title: "Clean energy project expands in Waikato.",
        source: "RNZ",
        summary: "Wind farm begins operation.",
        topics: [],
        providers: [],
      },
      {
        url: "https://example.com/other-2",
        title: "Waikato clean energy wind farm opens.",
        source: "Stuff",
        summary: "Generates power for 40,000 households.",
        topics: [],
        providers: [],
      },
    ],
    undefined,
    failingFetcher,
  );

  assert.equal(localRes.available, true);
  assert.equal(localRes.source, "local");
  assert.ok(localRes.paragraphs[0].includes("RNZ and Stuff"));
});
