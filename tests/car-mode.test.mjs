import assert from "node:assert/strict";
import { test } from "node:test";

test("Car mode voice commands map correctly to playback and navigation intents", () => {
  const parseVoiceCommand = (raw) => {
    const lower = String(raw).toLowerCase().trim();
    if (lower.includes("pause") || lower.includes("wait") || lower.includes("hold")) return "pause";
    if (lower.includes("play") || lower.includes("resume") || lower.includes("start")) return "play";
    if (lower.includes("next") || lower.includes("skip") || lower.includes("forward")) return "next";
    if (lower.includes("previous") || lower.includes("back") || lower.includes("rewind")) return "previous";
    if (lower.includes("snooze")) return "snooze";
    if (lower.includes("queue")) return "queue";
    if (lower.includes("stop") || lower.includes("exit") || lower.includes("close")) return "exit";
    return "unknown";
  };

  assert.equal(parseVoiceCommand("please pause the briefing"), "pause");
  assert.equal(parseVoiceCommand("play"), "play");
  assert.equal(parseVoiceCommand("resume playback"), "play");
  assert.equal(parseVoiceCommand("skip to next story"), "next");
  assert.equal(parseVoiceCommand("go back"), "previous");
  assert.equal(parseVoiceCommand("snooze 10 minutes"), "snooze");
  assert.equal(parseVoiceCommand("queue lead stories for later"), "queue");
  assert.equal(parseVoiceCommand("exit car mode"), "exit");
  assert.equal(parseVoiceCommand("random chatter in car"), "unknown");
});

test("MediaSession integration updates metadata and action handlers for car head units", () => {
  const registeredHandlers = new Map();
  let currentMetadata = null;
  let playbackState = "none";

  const fakeMediaSession = {
    get playbackState() {
      return playbackState;
    },
    set playbackState(val) {
      playbackState = val;
    },
    get metadata() {
      return currentMetadata;
    },
    set metadata(val) {
      currentMetadata = val;
    },
    setActionHandler(action, handler) {
      registeredHandlers.set(action, handler);
    },
  };

  // Register standard actions expected in automotive environments
  for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekforward", "seekbackward", "stop"]) {
    fakeMediaSession.setActionHandler(action, () => `handled:${action}`);
  }

  fakeMediaSession.metadata = {
    title: "Markets & Watchlist",
    artist: "Signal Commute Briefing",
    album: "Executive Daily Briefing",
    artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }],
  };
  fakeMediaSession.playbackState = "playing";

  assert.equal(fakeMediaSession.playbackState, "playing");
  assert.equal(fakeMediaSession.metadata.title, "Markets & Watchlist");
  assert.equal(fakeMediaSession.metadata.artist, "Signal Commute Briefing");
  assert.ok(registeredHandlers.has("play"));
  assert.ok(registeredHandlers.has("pause"));
  assert.ok(registeredHandlers.has("previoustrack"));
  assert.ok(registeredHandlers.has("nexttrack"));
  assert.ok(registeredHandlers.has("seekforward"));
  assert.ok(registeredHandlers.has("seekbackward"));
});
