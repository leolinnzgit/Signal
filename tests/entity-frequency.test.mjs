import test from "node:test";
import assert from "node:assert/strict";
import { calculateEntityFrequency } from "../app/entity-frequency.ts";

test("calculateEntityFrequency returns 7 empty points for blank entity or empty articles", () => {
  const ref = new Date("2026-10-31T12:00:00Z");
  const stats = calculateEntityFrequency("", [], 7, ref);

  assert.equal(stats.totalMentions, 0);
  assert.equal(stats.timeline.length, 7);
  assert.equal(stats.trend, "quiet");
  assert.equal(stats.timeline.every((p) => p.count === 0), true);
});

test("calculateEntityFrequency groups articles by publication date", () => {
  const ref = new Date("2026-10-31T12:00:00Z");
  const mockArticles = [
    { title: "Christopher Luxon announces new infrastructure fund", publishedAt: "2026-10-31T08:00:00Z" },
    { title: "Press briefing by Christopher Luxon in Auckland", publishedAt: "2026-10-31T10:00:00Z" },
    { title: "Opposition responds to Christopher Luxon speech", publishedAt: "2026-10-30T15:00:00Z" },
    { title: "Earlier remarks from Luxon on fiscal policy", summary: "Christopher Luxon discussed tax policy", publishedAt: "2026-10-27T09:00:00Z" },
  ];

  const stats = calculateEntityFrequency("Christopher Luxon", mockArticles, 7, ref);

  assert.equal(stats.totalMentions, 4);
  assert.equal(stats.timeline.length, 7);

  // Today (Oct 31) should have 2
  const todayPoint = stats.timeline[stats.timeline.length - 1];
  assert.equal(todayPoint.date, "2026-10-31");
  assert.equal(todayPoint.count, 2);

  // Yesterday (Oct 30) should have 1
  const yesterdayPoint = stats.timeline[stats.timeline.length - 2];
  assert.equal(yesterdayPoint.date, "2026-10-30");
  assert.equal(yesterdayPoint.count, 1);

  // Oct 27 should have 1
  const oct27Point = stats.timeline.find((p) => p.date === "2026-10-27");
  assert.ok(oct27Point);
  assert.equal(oct27Point.count, 1);
});

test("calculateEntityFrequency detects surging trend when recent mentions dominate", () => {
  const ref = new Date("2026-10-31T12:00:00Z");
  const mockArticles = [
    { title: "Breaking: OpenAI unveils new frontier model", publishedAt: "2026-10-31T02:00:00Z" },
    { title: "OpenAI partners with global institutions", publishedAt: "2026-10-31T04:00:00Z" },
    { title: "Tech reaction to OpenAI announcement", publishedAt: "2026-10-30T22:00:00Z" },
  ];

  const stats = calculateEntityFrequency("OpenAI", mockArticles, 7, ref);
  assert.equal(stats.totalMentions, 3);
  assert.equal(stats.trend, "surging");
  assert.ok(stats.trendLabel.includes("Surging"));
});

test("calculateEntityFrequency detects steady trend across week", () => {
  const ref = new Date("2026-10-31T12:00:00Z");
  const mockArticles = [
    { title: "Wellington council debates water budget", publishedAt: "2026-10-31T08:00:00Z" },
    { title: "Housing update in Wellington region", publishedAt: "2026-10-28T08:00:00Z" },
    { title: "New transit project for Wellington CBD", publishedAt: "2026-10-26T08:00:00Z" },
  ];

  const stats = calculateEntityFrequency("Wellington", mockArticles, 7, ref);
  assert.equal(stats.totalMentions, 3);
  assert.equal(stats.trend, "steady");
  assert.equal(stats.trendLabel, "Steady coverage");
});
