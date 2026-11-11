import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeNewsTopicWithSignalBot,
  fetchSignalBotStatus,
  formatSignalBotMarkdown,
  normalizeSignalBotArticles,
  sentimentBadgeMeta,
  SIGNAL_BOT_PRESETS,
} from "../app/signal-bot.ts";

test("SIGNAL_BOT_PRESETS defines four distinct on-demand analysis prompts", () => {
  assert.equal(SIGNAL_BOT_PRESETS.length, 4);
  const ids = new Set(SIGNAL_BOT_PRESETS.map((p) => p.id));
  assert.equal(ids.size, 4);
  assert.ok(SIGNAL_BOT_PRESETS.every((p) => p.label.length > 0 && p.prompt.length > 10));
});

test("normalizeSignalBotArticles prioritizes topic matches, deduplicates URLs, and rejects non-HTTP URLs", () => {
  const result = normalizeSignalBotArticles(
    [
      { url: "javascript:alert(1)", title: "Unsafe", source: "X", summary: "NVIDIA" },
      { url: "https://example.com/other", title: "Macro update", source: "RNZ", summary: "Central bank overview", topics: ["Economy"] },
      { url: "https://example.com/nvda/", title: "NVIDIA expands AI chip supply", source: "Reuters", summary: "Data center demand accelerates.", topics: ["NVIDIA"] },
      { url: "https://example.com/nvda", title: "Duplicate trailing slash", source: "Reuters", summary: "Short", topics: ["NVIDIA"] },
    ],
    "NVIDIA",
    10,
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].title, "NVIDIA expands AI chip supply");
  assert.equal(result[1].title, "Macro update");
});

test("fetchSignalBotStatus parses Foundry provider and model", async () => {
  const status = await fetchSignalBotStatus(undefined, async (input) => {
    assert.equal(input, "/api/signal-bot/status");
    return new Response(JSON.stringify({ available: true, provider: "Microsoft Foundry", model: "gpt-4.1-mini" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  assert.equal(status.available, true);
  assert.equal(status.provider, "Microsoft Foundry");
  assert.equal(status.model, "gpt-4.1-mini");
});

test("analyzeNewsTopicWithSignalBot acquires CSRF token and posts structured topic payload", async () => {
  const calls = [];
  const fakeResponse = {
    available: true,
    topic: "AI Chip Supply",
    headline: "Supply tightens as foundry packaging capacity expands",
    analysis: "Demand for advanced packaging outpaces near-term capacity [S1].",
    keyDrivers: ["Hyperscaler capex remains elevated [S1]"],
    perspectives: ["Lead times may ease late next year [S1]"],
    watchNext: ["Quarterly capex guidance updates"],
    sentiment: "mixed",
    suggestedFollowUps: ["Which suppliers benefit most?"],
    citations: [
      {
        index: 1,
        url: "https://example.com/story-1",
        title: "Packaging crunch eases slowly",
        source: "Reuters",
        publishedAt: "2026-11-12T00:00:00Z",
        summary: "Packaging capacity expands.",
      },
    ],
    marketQuote: null,
    model: "gpt-4.1-mini",
    language: "en",
    analyzedAt: "2026-11-12T00:00:00Z",
    coverageNote: "Grounded in 1 Signal story",
  };

  const mockFetch = async (input, init = {}) => {
    calls.push({ input, init });
    if (input === "/api/auth/csrf") {
      assert.equal(init.credentials, "same-origin");
      return new Response(JSON.stringify({ token: "csrf-token-123" }), { status: 200 });
    }
    if (input === "/api/signal-bot/analyze") {
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.headers["X-XSRF-TOKEN"], "csrf-token-123");
      const body = JSON.parse(init.body);
      assert.equal(body.topic, "AI Chip Supply");
      assert.equal(body.prompt, "Summarize the bottleneck.");
      return new Response(JSON.stringify(fakeResponse), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${input}`);
  };

  const result = await analyzeNewsTopicWithSignalBot(
    { topic: "AI Chip Supply", prompt: "Summarize the bottleneck." },
    undefined,
    mockFetch,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.headline, fakeResponse.headline);
  assert.equal(result.citations.length, 1);
});

test("analyzeNewsTopicWithSignalBot surfaces server error messages cleanly", async () => {
  const mockFetch = async (input) => {
    if (input === "/api/auth/csrf") {
      return new Response(JSON.stringify({ token: "csrf-ok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "Microsoft Foundry has not been configured for Signal Bot yet." }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    () => analyzeNewsTopicWithSignalBot({ topic: "NZ Economy" }, undefined, mockFetch),
    /Microsoft Foundry has not been configured/,
  );
});

test("formatSignalBotMarkdown renders complete exportable intelligence digest", () => {
  assert.equal(sentimentBadgeMeta("bullish").toneClass, "sentiment-bullish");
  assert.equal(sentimentBadgeMeta("unknown").toneClass, "sentiment-neutral");

  const md = formatSignalBotMarkdown({
    available: true,
    topic: "Rocket Lab",
    headline: "Neutron cadence accelerates toward commercial milestone",
    analysis: "Launch readiness improved following test stand updates [S1].",
    keyDrivers: ["Test milestones hit schedule"],
    perspectives: ["Capital intensity remains under scrutiny"],
    watchNext: ["Next wet dress rehearsal date"],
    sentiment: "bullish",
    suggestedFollowUps: ["How does backlog compare YoY?"],
    citations: [
      {
        index: 1,
        url: "https://example.com/rklb",
        title: "Rocket Lab completes stage test",
        source: "SpaceNews",
        publishedAt: "2026-11-12T00:00:00Z",
        summary: "Summary",
      },
    ],
    marketQuote: {
      symbol: "RKLB",
      name: "Rocket Lab",
      exchange: "NASDAQ",
      currency: "USD",
      price: 21.5,
      change: 1.25,
      percentChange: 6.17,
      quoteTime: "2026-11-12",
    },
    model: "gpt-4.1-mini",
    language: "en",
    analyzedAt: "2026-11-12T00:00:00Z",
    coverageNote: "Grounded in 1 Signal story",
  });

  assert.match(md, /# Signal Bot: Rocket Lab/);
  assert.match(md, /Rocket Lab \(RKLB\) — USD 21\.50 \(\+1\.25, \+6\.17%\)/);
  assert.match(md, /\[S1\] \[Rocket Lab completes stage test\]\(https:\/\/example\.com\/rklb\)/);
});
