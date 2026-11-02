import test from "node:test";
import assert from "node:assert/strict";
import {
  drawAudiogramCard,
  copyAudiogramText,
} from "../app/audiogram-generator.ts";

test("copyAudiogramText formats soundbite citation and copies via clipboard API", async () => {
  let clipboardText = "";
  const mockNav = {
    clipboard: {
      writeText: async (text) => {
        clipboardText = text;
      },
    },
  };

  const success = await copyAudiogramText(
    "Key Interest Rates Lowered",
    "Inflation expectations have firmly anchored within the target range.",
    "Central Bank Wire",
    "https://example.com/rates",
    mockNav,
  );

  assert.equal(success, true);
  assert.ok(clipboardText.includes("“Inflation expectations have firmly anchored within the target range.”"));
  assert.ok(clipboardText.includes("— Reporting by Central Bank Wire"));
  assert.ok(clipboardText.includes("https://example.com/rates"));
  assert.ok(clipboardText.includes("Via Signal Executive Intelligence"));
});

test("copyAudiogramText falls back to title when quote is empty", async () => {
  let clipboardText = "";
  const mockNav = {
    clipboard: {
      writeText: async (text) => {
        clipboardText = text;
      },
    },
  };

  const success = await copyAudiogramText(
    "Emergency Maritime Corridor Established",
    "",
    "RNZ News",
    undefined,
    mockNav,
  );

  assert.equal(success, true);
  assert.ok(clipboardText.includes("“Emergency Maritime Corridor Established”"));
  assert.ok(clipboardText.includes("— Reporting by RNZ News"));
});

test("drawAudiogramCard renders background, typography, and waveform bars on canvas context", () => {
  const drawnTexts = [];
  const fills = [];

  const mockCtx = {
    fillStyle: "",
    font: "",
    lineWidth: 0,
    strokeStyle: "",
    fillRect: (x, y, w, h) => {
      fills.push({ x, y, w, h });
    },
    strokeRect: () => {},
    fillText: (text, x, y) => {
      drawnTexts.push({ text, x, y });
    },
    measureText: (text) => ({ width: text.length * 8 }),
    createRadialGradient: () => ({
      addColorStop: () => {},
    }),
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {},
  };

  const mockCanvas = {
    width: 800,
    height: 450,
    getContext: (type) => (type === "2d" ? mockCtx : null),
  };

  drawAudiogramCard(mockCanvas, {
    title: "Breakthrough In Fusion Energy",
    quote: "Net energy gain achieved consecutively for seventy-two hours.",
    source: "MIT Technology Review",
    timestamp: "Nov 2, 2026 • Morning Edition",
    waveformFractions: [0.3, 0.7, 0.9, 0.4, 0.8],
  });

  assert.ok(drawnTexts.some((t) => t.text.includes("SIGNAL INTELLIGENCE BRIEFING")));
  assert.ok(drawnTexts.some((t) => t.text.includes("Reported by MIT Technology Review")));
  assert.ok(drawnTexts.some((t) => t.text.includes("Net energy gain")));
  assert.ok(drawnTexts.some((t) => t.text.includes("Nov 2, 2026 • Morning Edition")));
});
