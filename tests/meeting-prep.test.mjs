import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchMeetingPrep,
  synthesizeMeetingPrepLocally,
  formatMeetingPrepClipboard,
} from "../app/meeting-prep.ts";

test("synthesizeMeetingPrepLocally produces tailored flash briefing", () => {
  const articles = [
    {
      title: "Fonterra lifts forecast milk payout on resilient Asian demand",
      source: "RNZ News",
      url: "https://rnz.co.nz/story/fonterra-payout",
      summary: "Co-operative increases farmgate price band to $9.00-$9.50/kgMS.",
    },
    {
      title: "Fonterra balance sheet audit confirms capital return plan",
      source: "NZ Herald",
      url: "https://nzherald.co.nz/story/fonterra-audit",
      summary: "Consumer division divestment on track for stakeholder approval.",
    },
  ];

  const prep = synthesizeMeetingPrepLocally("Fonterra", articles);

  assert.equal(prep.available, true);
  assert.equal(prep.entity, "Fonterra");
  assert.ok(prep.strategicPoints.length >= 2);
  assert.equal(prep.strategicPoints[0].source, "RNZ News");
  assert.ok(prep.talkingPoints.length === 3);
  assert.ok(prep.talkingPoints[0].questionToAsk.length > 0);
  assert.ok(prep.rapidFireAudioScript.includes("Fonterra"));
});

test("fetchMeetingPrep calls server endpoint and parses response", async () => {
  const mockFetcher = async (url) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "mock-token" }) };
    }
    if (url === "/api/meeting-prep/generate") {
      return {
        ok: true,
        json: async () => ({
          available: true,
          entity: "Reserve Bank",
          sentimentTrajectory: "Hawkish vigilance",
          sentimentTone: "Assertive",
          strategicPoints: [
            { category: "Monetary Policy", description: "Rates held steady.", source: "Signal Desk" },
          ],
          leadershipQuotes: [
            { speaker: "Adrian Orr", stance: "Assertive", quote: "Inflation is heading back to target.", context: "Speech" },
          ],
          talkingPoints: [
            { dimension: "Rate Path", talkingPoint: "Acknowledge policy stance.", questionToAsk: "What is your core timeline?" },
          ],
          rapidFireAudioScript: "Reserve bank briefing script.",
          generatedAt: new Date().toISOString(),
        }),
      };
    }
    return { ok: false };
  };

  const res = await fetchMeetingPrep("Reserve Bank", [], 30, undefined, mockFetcher);

  assert.equal(res.available, true);
  assert.equal(res.entity, "Reserve Bank");
  assert.equal(res.sentimentTone, "Assertive");
  assert.equal(res.leadershipQuotes.length, 1);
});

test("formatMeetingPrepClipboard formats flash card with talking points and questions", () => {
  const prep = synthesizeMeetingPrepLocally("Spark NZ", []);
  const text = formatMeetingPrepClipboard(prep);

  assert.ok(text.includes("1-MINUTE MEETING PREP FLASH BRIEF: SPARK NZ"));
  assert.ok(text.includes("STRATEGIC INTELLIGENCE POINTS:"));
  assert.ok(text.includes("BOARDROOM QUESTIONS & TALKING POINTS:"));
  assert.ok(text.includes("👉 ASK:"));
});
