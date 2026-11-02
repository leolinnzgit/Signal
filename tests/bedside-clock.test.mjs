import test from "node:test";
import assert from "node:assert/strict";
import {
  formatClockDisplay,
  shouldAlarmTrigger,
  calculateSnoozeAlarmTime,
  CHIME_FREQUENCIES,
  playHarmonicChime,
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

test("shouldAlarmTrigger validates exact HH:MM match at 0th second", () => {
  assert.equal(shouldAlarmTrigger("07:00", 0, "07:00", false), true);
  assert.equal(shouldAlarmTrigger("07:00", 5, "07:00", false), false, "Must only trigger at second 0");
  assert.equal(shouldAlarmTrigger("07:00", 0, "07:00", true), false, "Must not re-trigger if already ringing");
  assert.equal(shouldAlarmTrigger("06:59", 0, "07:00", false), false, "Must not trigger when time does not match");
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
