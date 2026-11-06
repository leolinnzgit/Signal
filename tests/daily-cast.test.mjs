import test from "node:test";
import assert from "node:assert/strict";
import { getHostVoiceParams, formatPodcastShowNotes } from "../app/daily-cast.ts";

test("getHostVoiceParams assigns distinct audio pitch and rates per host", () => {
  const david = getHostVoiceParams("david");
  assert.ok(david.pitch < 1.0, "David should have lower pitch");
  assert.equal(david.accentColor, "#38bdf8");

  const sarah = getHostVoiceParams("sarah");
  assert.ok(sarah.pitch > 1.0, "Sarah should have higher pitch");
  assert.equal(sarah.accentColor, "#a855f7");
});

test("formatPodcastShowNotes formats full podcast show notes and transcript", () => {
  const mockCast = {
    episodeId: "macro-divergence",
    episodeTitle: "The Macro Divergence",
    showNotes: "David and Sarah debate central bank rates.",
    totalDurationSeconds: 65,
    chapters: [
      { timestampSeconds: 0, title: "Introduction" },
      { timestampSeconds: 25, title: "Hyperscaler Capex" },
    ],
    dialogTurns: [
      {
        turnIndex: 1,
        speaker: "david",
        speakerName: "David Vance",
        speakerRole: "Chief Macro Strategist",
        avatarEmoji: "🎙️",
        text: "Good morning and welcome to Signal Daily Cast.",
        durationSeconds: 10,
      },
      {
        turnIndex: 2,
        speaker: "sarah",
        speakerName: "Sarah Chen",
        speakerRole: "Geopolitical & Tech Lead",
        avatarEmoji: "🎧",
        text: "Physical cost of capital is stubbornly anchored.",
        durationSeconds: 12,
      },
    ],
    synthesizedAt: new Date().toISOString(),
  };

  const memo = formatPodcastShowNotes(mockCast);
  assert.ok(memo.includes("SIGNAL DAILY CAST: THE MACRO DIVERGENCE"));
  assert.ok(memo.includes("David Vance"));
  assert.ok(memo.includes("Sarah Chen"));
  assert.ok(memo.includes("[0:00] Introduction"));
  assert.ok(memo.includes("[0:25] Hyperscaler Capex"));
  assert.ok(memo.includes("Physical cost of capital is stubbornly anchored."));
});
