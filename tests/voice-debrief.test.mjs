import test from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_PRESETS,
  fetchDebriefPresets,
  sendVoiceDebriefQuery,
  fetchDebriefAudioBlob,
  getIntentBadgeColor,
  getIntentIcon,
  splitIntoSentences,
  formatDebriefDigest,
} from "../app/voice-debrief.ts";

test("fetchDebriefPresets returns server presets or FALLBACK_PRESETS on network failure", async () => {
  // Successful fetch
  const mockFetcherSuccess = async () => ({
    ok: true,
    json: async () => [
      { id: "custom", title: "Custom Preset", query: "Test query?", category: "Custom", icon: "⭐" },
    ],
  });
  const custom = await fetchDebriefPresets(mockFetcherSuccess);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].id, "custom");

  // Error fetch falls back to FALLBACK_PRESETS
  const mockFetcherFail = async () => ({ ok: false });
  const fallbacks = await fetchDebriefPresets(mockFetcherFail);
  assert.equal(fallbacks.length, FALLBACK_PRESETS.length);
  assert.equal(fallbacks[0].id, "risk-roundup");
});

test("sendVoiceDebriefQuery formats request and returns VoiceDebriefResponse", async () => {
  let calledUrl = "";
  let calledMethod = "";
  let calledBody = "";

  const mockFetcher = async (url, opts) => {
    calledUrl = url;
    calledMethod = opts.method;
    calledBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        available: true,
        query: calledBody.query,
        intentCategory: "Deep Tech & Silicon",
        spokenScript: "Signal Voice Debrief on semiconductor fabrication.",
        executiveSummary: "TSMC and ASML advance high-NA tooling.",
        keyTakeaways: ["High-NA EUV tooling operational.", "Yields improving ahead of baseline."],
        citations: [{ url: "https://example.com/art1", title: "ASML Update", source: "Semiconductor Daily" }],
        suggestedFollowUps: ["Check supply chain bottlenecks.", "Review US BIS export rules."],
        audioAvailable: true,
        generatedAt: "2026-11-06T00:00:00Z",
      }),
    };
  };

  const res = await sendVoiceDebriefQuery(
    {
      query: "What is ASML doing with high-NA EUV?",
      articles: [{ title: "ASML EUV Tooling", url: "https://example.com/art1", source: "Semiconductor Daily" }],
      marketContext: "Tech benchmark +1.2%",
    },
    mockFetcher,
  );

  assert.equal(calledUrl, "/api/voice-debrief/query");
  assert.equal(calledMethod, "POST");
  assert.equal(calledBody.query, "What is ASML doing with high-NA EUV?");
  assert.equal(res.available, true);
  assert.equal(res.intentCategory, "Deep Tech & Silicon");
  assert.equal(res.citations.length, 1);
  assert.equal(res.keyTakeaways.length, 2);
});

test("sendVoiceDebriefQuery rejects on HTTP error", async () => {
  const mockFetcherError = async () => ({
    ok: false,
    status: 500,
    text: async () => "Internal server error",
  });

  await assert.rejects(
    sendVoiceDebriefQuery({ query: "Test query" }, mockFetcherError),
    /Internal server error/,
  );
});

test("fetchDebriefAudioBlob calls /api/voice-debrief/speak and returns audio Blob", async () => {
  const fakeBlob = { size: 1024, type: "audio/wav" };
  const mockFetcher = async (url, opts) => {
    assert.equal(url, "/api/voice-debrief/speak");
    assert.equal(opts.method, "POST");
    return {
      ok: true,
      blob: async () => fakeBlob,
    };
  };

  const blob = await fetchDebriefAudioBlob("Test debrief speech text.", "en-NZ-MitchellNeural", "en-NZ", mockFetcher);
  assert.equal(blob.size, 1024);
  assert.equal(blob.type, "audio/wav");
});

test("getIntentBadgeColor and getIntentIcon return consistent category mappings", () => {
  assert.equal(getIntentIcon("Risk & Threats"), "🚨");
  assert.equal(getIntentIcon("Cyber Vulnerabilities"), "⚡");
  assert.equal(getIntentIcon("Macro & Markets"), "📊");
  assert.equal(getIntentIcon("Deep Tech & Silicon"), "🔬");
  assert.equal(getIntentIcon("Trade Chokepoints"), "🚢");
  assert.equal(getIntentIcon("General"), "🎙️");

  const riskColor = getIntentBadgeColor("Risk");
  assert.ok(riskColor.text.includes("f87171"));

  const marketColor = getIntentBadgeColor("Market");
  assert.ok(marketColor.text.includes("4ade80"));
});

test("splitIntoSentences accurately splits text into sentence units", () => {
  const text = "First sentence here. Second sentence starts now! What about the third? Yes, done.";
  const sentences = splitIntoSentences(text);
  assert.equal(sentences.length, 4);
  assert.equal(sentences[0], "First sentence here.");
  assert.equal(sentences[1], "Second sentence starts now!");
  assert.equal(sentences[2], "What about the third?");
  assert.equal(sentences[3], "Yes, done.");
});

test("formatDebriefDigest produces formatted executive memo", () => {
  const sample = {
    available: true,
    query: "Supply chain disruptions",
    intentCategory: "Risk & Threats",
    spokenScript: "Spoken script narration content.",
    executiveSummary: "Summary of maritime trade bottlenecks.",
    keyTakeaways: ["Red Sea rerouting adds 10 days.", "Fuel surcharges up 8%."],
    citations: [{ url: "https://example.com/ship", title: "Container Shipping Brief", source: "Maritime News" }],
    suggestedFollowUps: ["Check Baltic Dry index."],
    audioAvailable: true,
    generatedAt: "2026-11-06T00:00:00Z",
  };

  const digest = formatDebriefDigest(sample);
  assert.ok(digest.includes("SIGNAL EXECUTIVE VOICE DEBRIEF"));
  assert.ok(digest.includes("Inquiry: \"Supply chain disruptions\""));
  assert.ok(digest.includes("Red Sea rerouting adds 10 days."));
  assert.ok(digest.includes("Container Shipping Brief (Maritime News)"));
  assert.ok(digest.includes("Check Baltic Dry index."));
});
