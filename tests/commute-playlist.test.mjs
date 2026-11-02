import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommutePlaylist,
  formatCommuteTime,
  setupMediaSession,
} from "../app/commute-playlist.ts";

test("buildCommutePlaylist compiles full multi-chapter executive playlist", () => {
  const briefing = {
    edition: "Morning",
    formattedDate: "Monday, November 2, 2026",
    weatherGlance: { temperature: 18, condition: "Partly Cloudy", location: "Wellington" },
    leadStories: [
      {
        title: "Reserve Bank Holds OCR Steady at 4.25%",
        source: "RNZ News",
        url: "https://rnz.co.nz/story/rbnz-rate",
        summary: "Monetary policy committee maintains rate while observing core inflation.",
      },
      {
        title: "Port Logistics Upgrade Commences Operations",
        source: "NZ Herald",
        url: "https://nzherald.co.nz/story/ports",
        summary: "Automated container terminals clear Auckland import backlogs.",
      },
    ],
  };

  const marketSentiment = {
    macroHeadline: "Equities hold firm following wholesale rate statement",
    assets: [
      { symbol: "NZ50", name: "NZX 50", price: 12450.5, changePercent: 0.65, sentimentTone: "bullish" },
      { symbol: "NZDUSD", name: "NZD / USD", price: 0.605, changePercent: -0.2, sentimentTone: "bearish" },
    ],
  };

  const playlist = buildCommutePlaylist(briefing, marketSentiment);

  assert.ok(playlist.id.startsWith("commute-"));
  assert.equal(playlist.edition, "Morning");
  assert.ok(playlist.chapters.length >= 4);

  // Chapter 1: Intro / Weather
  assert.equal(playlist.chapters[0].category, "weather");
  assert.equal(playlist.chapters[0].startTimeSeconds, 0);
  assert.ok(playlist.chapters[0].narrationText.includes("18 degrees and Partly Cloudy in Wellington"));

  // Chapter 2: Macro Market
  assert.equal(playlist.chapters[1].category, "macro_market");
  assert.ok(playlist.chapters[1].narrationText.includes("Macro financial pulse: Equities hold firm"));

  // Chapters 3 & 4: Lead Stories
  assert.equal(playlist.chapters[2].category, "lead_story");
  assert.equal(playlist.chapters[2].title, "Reserve Bank Holds OCR Steady at 4.25%");
  assert.equal(playlist.chapters[3].category, "lead_story");
  assert.equal(playlist.chapters[3].title, "Port Logistics Upgrade Commences Operations");

  // Final Chapter: Forward Watch
  const lastChapter = playlist.chapters[playlist.chapters.length - 1];
  assert.equal(lastChapter.category, "forward_watch");
  assert.ok(lastChapter.narrationText.includes("Forward horizon"));

  // Total duration matches sum of chapters
  const total = playlist.chapters.reduce((sum, ch) => sum + ch.durationSeconds, 0);
  assert.equal(playlist.totalDurationSeconds, total);
});

test("buildCommutePlaylist creates safe fallback playlist when inputs are empty", () => {
  const playlist = buildCommutePlaylist(null, null);

  assert.ok(playlist.chapters.length >= 2);
  assert.equal(playlist.chapters[0].category, "weather");
  assert.equal(playlist.chapters[playlist.chapters.length - 1].category, "forward_watch");
  assert.ok(playlist.totalDurationSeconds > 0);
});

test("formatCommuteTime formats mm:ss correctly", () => {
  assert.equal(formatCommuteTime(0), "0:00");
  assert.equal(formatCommuteTime(9), "0:09");
  assert.equal(formatCommuteTime(65), "1:05");
  assert.equal(formatCommuteTime(600), "10:00");
  assert.equal(formatCommuteTime(815), "13:35");
});

test("setupMediaSession configures media handlers without throwing in Node environment", () => {
  const playlist = buildCommutePlaylist(null, null);
  assert.doesNotThrow(() => {
    setupMediaSession(playlist, 0, {
      onPlay: () => {},
      onPause: () => {},
      onPrevious: () => {},
      onNext: () => {},
      onSeekTo: () => {},
    });
  });
});
