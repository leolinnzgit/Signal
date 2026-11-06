import test from "node:test";
import assert from "node:assert/strict";
import {
  getGaugeColor,
  formatScorecardMemo,
} from "../app/board-sparring.ts";

test("getGaugeColor handles direct and inverted thresholds accurately", () => {
  // Direct score (higher is better)
  assert.equal(getGaugeColor(85), "#10b981", "High direct score should be green");
  assert.equal(getGaugeColor(55), "#f59e0b", "Medium direct score should be amber");
  assert.equal(getGaugeColor(25), "#ef4444", "Low direct score should be red");

  // Inverted score (lower is better, e.g. defensiveness, concession velocity)
  assert.equal(getGaugeColor(20, true), "#10b981", "Low inverted score should be green");
  assert.equal(getGaugeColor(50, true), "#f59e0b", "Medium inverted score should be amber");
  assert.equal(getGaugeColor(80, true), "#ef4444", "High inverted score should be red");
});

test("formatScorecardMemo formats an executive debrief report correctly", () => {
  const mockPersona = {
    id: "carl-vance",
    name: "Carl Vance",
    title: "Managing Partner",
    organization: "Ironcrest Capital",
    avatarEmoji: "🦈",
    archetype: "Activist Investor",
    pressurePoints: ["Capital allocation decay", "EBITDA margin lag"],
    openingStatement: "Explain why we shouldn't initiate a proxy contest.",
  };

  const mockScorecard = {
    personaId: "carl-vance",
    overallGrade: "A",
    executiveReadinessScore: 92,
    strengths: ["Maintained steady cadence", "Reinforced moats"],
    vulnerabilities: ["Allowed adversary to dictate agenda"],
    tacticalRecommendations: ["Open future confrontations with audited data"],
  };

  const mockTurns = [
    { sender: "adversary", text: "Explain why we shouldn't initiate a proxy contest." },
    { sender: "user", text: "Our ROIC hurdle is 18%, verified by independent audit." },
  ];

  const memo = formatScorecardMemo(mockPersona, mockScorecard, mockTurns);
  assert.ok(memo.includes("SIGNAL BOARDROOM SPARRING DEBRIEF"));
  assert.ok(memo.includes("Carl Vance"));
  assert.ok(memo.includes("Ironcrest Capital"));
  assert.ok(memo.includes("Overall Grade: A"));
  assert.ok(memo.includes("Executive Readiness Score: 92/100"));
  assert.ok(memo.includes("Maintained steady cadence"));
  assert.ok(memo.includes("Open future confrontations with audited data"));
  assert.ok(memo.includes("EXECUTIVE"));
});
