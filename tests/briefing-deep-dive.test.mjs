import assert from "node:assert/strict";
import { test } from "node:test";
import {
  synthesizeDeepDiveLocally,
  fetchBriefingDeepDive,
} from "../app/daily-briefing-deep-dive.ts";

test("synthesizeDeepDiveLocally produces alternating Anchor-Analyst dialogue", () => {
  const fakeBriefing = {
    title: "Executive Daily Briefing",
    priorityTopics: ["Artificial Intelligence"],
    leadStories: [
      {
        title: "Anthropic releases new enterprise agent benchmarks",
        source: "TechCrunch",
        url: "https://techcrunch.com/anthropic-agents",
        summary: "New benchmarks show autonomous models outperforming human baselines on multi-step reasoning.",
      },
      {
        title: "EU AI safety office raises oversight concerns over autonomous tool calling",
        source: "Reuters",
        url: "https://reuters.com/eu-ai-safety",
        summary: "European regulators warn of cascading risks from unsupervised execution.",
      },
    ],
  };

  const episode = synthesizeDeepDiveLocally({
    briefing: fakeBriefing,
    topic: "Enterprise AI Agents",
  });

  assert.ok(episode.available);
  assert.equal(episode.title, "Executive Deep Dive: Enterprise AI Agents");
  assert.ok(episode.turns.length >= 8);

  // Check turn alternation
  assert.equal(episode.turns[0].speaker, "Anchor");
  assert.equal(episode.turns[1].speaker, "Analyst");
  assert.equal(episode.turns[2].speaker, "Anchor");
  assert.equal(episode.turns[3].speaker, "Analyst");

  // Check voices are distinct
  assert.notEqual(episode.turns[0].voiceName, episode.turns[1].voiceName);

  // Check publisher citations
  assert.equal(episode.turns[1].citedSource, "TechCrunch");
  assert.equal(episode.turns[1].citedUrl, "https://techcrunch.com/anthropic-agents");
  assert.equal(episode.turns[2].citedSource, "Reuters");

  // Check chapters
  assert.ok(episode.chapters.length >= 4);
  assert.equal(episode.chapters[0].startTurnIndex, 0);

  // Estimated duration
  assert.ok(episode.estimatedDurationSeconds >= 45);
});

test("synthesizeDeepDiveLocally handles non-English language voice mappings", () => {
  const episodeZh = synthesizeDeepDiveLocally({
    topic: "Global Chip Market",
    language: "zh-Hans",
    articles: [
      {
        title: "TSMC expands 2nm production line",
        source: "Nikkei Asia",
        url: "https://asia.nikkei.com/tsmc",
        summary: "TSMC accelerates next-gen node fabrication.",
      },
    ],
  });

  assert.equal(episodeZh.language, "zh-Hans");
  assert.equal(episodeZh.turns[0].voiceName, "zh-CN-YunxiNeural");
  assert.equal(episodeZh.turns[1].voiceName, "zh-CN-XiaoxiaoNeural");
});

test("fetchBriefingDeepDive falls back cleanly when offline", async () => {
  const episode = await fetchBriefingDeepDive({
    topic: "Renewable Energy Transition",
    isOnline: false,
    articles: [
      {
        title: "Wind and solar grid integration surges in New Zealand",
        source: "RNZ",
        url: "https://rnz.co.nz/energy",
        summary: "Geothermal and wind generation meet 92% of peak demand.",
      },
    ],
  });

  assert.ok(episode.available);
  assert.ok(episode.title.includes("Renewable Energy Transition"));
  assert.ok(episode.turns.length >= 8);
  assert.equal(episode.turns[1].citedSource, "RNZ");
});
