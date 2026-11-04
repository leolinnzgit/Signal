import test from "node:test";
import assert from "node:assert/strict";
import {
  formatClockDisplay,
  shouldAlarmTrigger,
  calculateSnoozeAlarmTime,
  calculateTimeUntilAlarm,
  CHIME_FREQUENCIES,
  playHarmonicChime,
  checkBedsideBriefingAudioCache,
  prewarmBedsideBriefingAudio,
} from "../app/bedside-clock.ts";

test("formatClockDisplay formats 24h and 12h times and pads zeros", () => {
  const morning = new Date(2026, 10, 2, 7, 5, 9);
  const morningDisplay = formatClockDisplay(morning);

  assert.equal(morningDisplay.hours24, "07");
  assert.equal(morningDisplay.minutes, "05");
  assert.equal(morningDisplay.seconds, "09");
  assert.equal(morningDisplay.hour12, 7);
  assert.equal(morningDisplay.ampm, "AM");
  assert.equal(morningDisplay.timeString24, "07:05");
  assert.ok(morningDisplay.dateFormatted.length > 0);

  const evening = new Date(2026, 10, 2, 19, 45, 0);
  const eveningDisplay = formatClockDisplay(evening);

  assert.equal(eveningDisplay.hours24, "19");
  assert.equal(eveningDisplay.minutes, "45");
  assert.equal(eveningDisplay.seconds, "00");
  assert.equal(eveningDisplay.hour12, 7);
  assert.equal(eveningDisplay.ampm, "PM");
  assert.equal(eveningDisplay.timeString24, "19:45");
});

test("shouldAlarmTrigger validates exact HH:MM match at 0th second and checks isEnabled", () => {
  assert.equal(shouldAlarmTrigger("07:00", 0, "07:00", false, true), true);
  assert.equal(shouldAlarmTrigger("07:00", 0, "07:00", false, false), false, "Must not trigger when alarm is disabled");
  assert.equal(shouldAlarmTrigger("07:00", 5, "07:00", false, true), false, "Must only trigger at second 0");
  assert.equal(shouldAlarmTrigger("07:00", 0, "07:00", true, true), false, "Must not re-trigger if already ringing");
  assert.equal(shouldAlarmTrigger("06:59", 0, "07:00", false, true), false, "Must not trigger when time does not match");
});

test("calculateTimeUntilAlarm calculates remaining hours and minutes correctly", () => {
  // Same day future alarm: 07:00 -> 08:30 (1h 30m)
  const morning = new Date(2026, 10, 2, 7, 0, 0);
  const res1 = calculateTimeUntilAlarm("08:30", morning);
  assert.equal(res1.hours, 1);
  assert.equal(res1.minutes, 30);
  assert.equal(res1.formatted, "in 1h 30m");

  // Overnight rollover alarm: 23:15 -> 07:00 (7h 45m)
  const night = new Date(2026, 10, 2, 23, 15, 0);
  const res2 = calculateTimeUntilAlarm("07:00", night);
  assert.equal(res2.hours, 7);
  assert.equal(res2.minutes, 45);
  assert.equal(res2.formatted, "in 7h 45m");

  // Less than 1 hour away: 06:40 -> 07:00 (20m)
  const close = new Date(2026, 10, 2, 6, 40, 0);
  const res3 = calculateTimeUntilAlarm("07:00", close);
  assert.equal(res3.hours, 0);
  assert.equal(res3.minutes, 20);
  assert.equal(res3.formatted, "in 20m");

  // Next day same time: 07:00 -> 07:00 (24h)
  const rightNow = new Date(2026, 10, 2, 7, 0, 0);
  const res4 = calculateTimeUntilAlarm("07:00", rightNow);
  assert.equal(res4.hours, 24);
  assert.equal(res4.formatted, "in 24h");

  // 1 minute away: 06:59 -> 07:00 (1m)
  const oneMin = new Date(2026, 10, 2, 6, 59, 0);
  const res5 = calculateTimeUntilAlarm("07:00", oneMin);
  assert.equal(res5.hours, 0);
  assert.equal(res5.minutes, 1);
  assert.equal(res5.formatted, "in 1m");
});

test("calculateSnoozeAlarmTime calculates rollover and pad zeros", () => {
  const base1 = new Date(2026, 10, 2, 6, 55, 0);
  assert.equal(calculateSnoozeAlarmTime(base1, 10), "07:05");

  const base2 = new Date(2026, 10, 2, 23, 55, 0);
  assert.equal(calculateSnoozeAlarmTime(base2, 15), "00:10");
});

test("playHarmonicChime constructs oscillators and gains for C-major arpeggio", () => {
  assert.deepEqual(CHIME_FREQUENCIES, [523.25, 659.25, 783.99, 1046.5]);

  const createdOscillators = [];
  const createdGains = [];

  const mockCtx = {
    currentTime: 100,
    state: "running",
    destination: {},
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: {
          setValueAtTime: (freq, t) => { osc.freqSet = { freq, t }; },
        },
        connect: (target) => { osc.connectedTo = target; },
        start: (t) => { osc.startTime = t; },
        stop: (t) => { osc.stopTime = t; },
      };
      createdOscillators.push(osc);
      return osc;
    },
    createGain() {
      const gain = {
        gain: {
          setValueAtTime: (val, t) => { gain.initialVal = val; gain.initialTime = t; },
          exponentialRampToValueAtTime: (val, t) => {
            gain.ramps = gain.ramps || [];
            gain.ramps.push({ val, t });
          },
        },
        connect: (target) => { gain.connectedTo = target; },
      };
      createdGains.push(gain);
      return gain;
    },
  };

  playHarmonicChime(mockCtx);

  assert.equal(createdOscillators.length, 4);
  assert.equal(createdGains.length, 4);
  assert.equal(createdOscillators[0].freqSet.freq, 523.25);
  assert.equal(createdOscillators[3].freqSet.freq, 1046.5);
  assert.equal(createdOscillators[0].connectedTo, createdGains[0]);
  assert.equal(createdGains[0].connectedTo, mockCtx.destination);
});

test("checkBedsideBriefingAudioCache detects cached audio blob in store", async () => {
  const fakeBlob = new Blob([new Uint8Array(1024)], { type: "audio/wav" });
  const store = {
    async get(id) {
      return fakeBlob;
    },
    async put() {},
    async clear() {},
  };

  const mockBriefing = {
    edition: "Morning",
    formattedDate: "Monday, 2 November 2026",
    spokenScript: "Executive morning briefing audio.",
    leadStories: [{ url: "https://example.com/story-1", title: "Story 1", source: "RNZ" }],
  };

  const res = await checkBedsideBriefingAudioCache(mockBriefing, "en-NZ", store);
  assert.equal(res.ready, true);
  assert.equal(res.status, "cached");
  assert.equal(res.audioBytes, 1024);
  assert.ok(res.message.includes("Offline audio ready"));
});

test("checkBedsideBriefingAudioCache reports unready when store is empty", async () => {
  const emptyStore = {
    async get() { return null; },
    async put() {},
    async clear() {},
  };

  const mockBriefing = {
    edition: "Morning",
    formattedDate: "Monday, 2 November 2026",
    spokenScript: "Executive morning briefing audio.",
    leadStories: [],
  };

  const res = await checkBedsideBriefingAudioCache(mockBriefing, "en-NZ", emptyStore);
  assert.equal(res.ready, false);
  assert.equal(res.status, "idle");
  assert.equal(res.audioBytes, 0);
});
