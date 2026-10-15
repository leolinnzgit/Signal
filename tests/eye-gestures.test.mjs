import assert from "node:assert/strict";
import test from "node:test";
import { createEyeGestureDetector } from "../app/eye-gestures.ts";

const open = { faceCount: 1, left: 0.05, right: 0.05 };
const left = { ...open, left: 0.9 };
const right = { ...open, right: 0.9 };
const both = { ...left, right: 0.9 };
function frames(detector, frame, from, to, step = 100) {
  const actions = [];
  for (let now = from; now <= to; now += step) {
    const result = detector.update(frame, now);
    if (result.action) actions.push(result.action);
  }
  return actions;
}
function ready() {
  const detector = createEyeGestureDetector();
  assert.deepEqual(frames(detector, open, 0, 600), []);
  return detector;
}

test("held winks use the user's own left/right and confirm only after reopening", () => {
  for (const [frame, action] of [[left, "previous"], [right, "next"], [both, "toggle-playback"]]) {
    const detector = ready();
    assert.deepEqual(frames(detector, frame, 700, 1900), []);
    assert.deepEqual(frames(detector, open, 2000, 2300), [action]);
    assert.deepEqual(frames(detector, open, 2400, 5000), []);
  }
});

test("normal blinks and brief winks never navigate or change playback", () => {
  for (const frame of [both, left, right]) {
    const detector = ready();
    assert.deepEqual(frames(detector, frame, 700, 800), []);
    assert.deepEqual(frames(detector, open, 900, 2000), []);
  }
});

test("starting with eyes closed cannot issue a command", () => {
  const detector = createEyeGestureDetector();
  assert.deepEqual(frames(detector, both, 0, 1500), []);
  assert.deepEqual(frames(detector, open, 1600, 2500), []);
});

test("long closures cancel rather than issue an action on reopening", () => {
  const detector = ready();
  assert.deepEqual(frames(detector, both, 700, 4000), []);
  assert.deepEqual(frames(detector, open, 4100, 5000), []);
});

test("face loss, multiple faces, malformed scores, or a frame gap cancel a closure", () => {
  for (const invalid of [{ faceCount: 0 }, { ...both, faceCount: 2 }, { ...both, left: NaN }, { ...both, right: 2 }, { faceCount: 1 }]) {
    const detector = ready();
    frames(detector, both, 700, 1800);
    detector.update(invalid, 1900);
    assert.deepEqual(frames(detector, open, 2000, 3000), []);
  }
  const detector = ready();
  frames(detector, both, 700, 1800);
  assert.deepEqual(frames(detector, open, 2900, 3900), []);
});

test("uncertain eye scores do not arm controls or build a hold", () => {
  const detector = createEyeGestureDetector();
  const uncertain = { faceCount: 1, left: 0.6, right: 0.6 };
  frames(detector, uncertain, 0, 1000);
  frames(detector, both, 1100, 2200);
  assert.deepEqual(frames(detector, open, 2300, 3200), []);
  frames(detector, both, 3300, 3900);
  frames(detector, { faceCount: 1, left: 0.22, right: 0.22 }, 4000, 4500);
  assert.deepEqual(frames(detector, open, 4600, 5500), []);
});

test("a second closure interrupts confirmation and held eyes never auto-repeat", () => {
  const detector = ready();
  frames(detector, right, 700, 1600);
  detector.update(open, 1700);
  frames(detector, right, 1800, 3000);
  assert.deepEqual(frames(detector, open, 3100, 4000), []);
});

test("reset on practice/view changes discards a pending command", () => {
  const detector = ready();
  frames(detector, both, 700, 1800);
  detector.update(open, 1900);
  detector.reset();
  assert.deepEqual(frames(detector, open, 2000, 3000), []);
});

test("a deliberate command can repeat after cooldown and fresh open-eye readiness", () => {
  const detector = ready();
  frames(detector, right, 700, 1500);
  assert.deepEqual(frames(detector, open, 1600, 2000), ["next"]);
  frames(detector, left, 2100, 2900);
  assert.deepEqual(frames(detector, open, 3000, 4100), []);
  frames(detector, left, 4200, 5000);
  assert.deepEqual(frames(detector, open, 5100, 5500), ["previous"]);
});

test("phone frames 300 ms apart still recognise a deliberate long blink", () => {
  const detector = createEyeGestureDetector();
  frames(detector, open, 0, 900, 300);
  frames(detector, both, 1200, 2400, 300);
  assert.deepEqual(frames(detector, open, 2700, 3300, 300), ["toggle-playback"]);
});

test("briefly staggered eyelids at blink onset and reopening still confirm one long blink", () => {
  const detector = ready();
  detector.update(left, 700);
  frames(detector, both, 800, 1900);
  detector.update(right, 2000);
  assert.deepEqual(frames(detector, open, 2100, 2500), ["toggle-playback"]);
});

test("switching the closed eye without reopening cancels instead of changing direction", () => {
  const detector = ready();
  frames(detector, left, 700, 1600);
  frames(detector, right, 1700, 2200);
  assert.deepEqual(frames(detector, open, 2300, 3300), []);
});

test("a wink that squints the other eye is still a wink, not a long blink", () => {
  const detector = ready();
  frames(detector, { faceCount: 1, left: 0.42, right: 0.8 }, 700, 1300);
  assert.deepEqual(frames(detector, open, 1400, 1700), ["next"]);
});

test("higher resting scores from looking down at a phone still arm and recognise winks", () => {
  const detector = createEyeGestureDetector();
  const resting = { faceCount: 1, left: 0.42, right: 0.38 };
  assert.deepEqual(frames(detector, resting, 0, 600), []);
  assert.equal(detector.update(resting, 700).state, "ready");
  frames(detector, { faceCount: 1, left: 0.92, right: 0.45 }, 800, 1500);
  assert.deepEqual(frames(detector, resting, 1600, 1900), ["previous"]);
});

test("slow frames with a half-open frame while reopening still confirm", () => {
  const detector = createEyeGestureDetector();
  frames(detector, open, 0, 1000, 500);
  frames(detector, right, 1500, 2000, 500);
  detector.update({ faceCount: 1, left: 0.1, right: 0.4 }, 2500);
  assert.deepEqual(frames(detector, open, 3000, 3600, 600), ["next"]);
});

test("ordinary blinks seen on slow frames are ignored", () => {
  const detector = createEyeGestureDetector();
  frames(detector, open, 0, 1000, 500);
  detector.update(both, 1500);
  assert.deepEqual(frames(detector, open, 2000, 4000, 500), []);
});

test("asymmetric bilateral blinks and softer closures still confirm a long blink", () => {
  const detector = ready();
  frames(detector, { faceCount: 1, left: 0.28, right: 0.24 }, 700, 1000);
  assert.deepEqual(frames(detector, open, 1100, 1300), ["toggle-playback"]);
});

test("an ordinary short blink does not disarm an immediately following deliberate blink", () => {
  const detector = ready();
  detector.update(both, 700);
  assert.equal(detector.update(open, 800).state, "ready");
  frames(detector, both, 900, 1200);
  assert.deepEqual(frames(detector, open, 1300, 1500), ["toggle-playback"]);
});

test("turning head right or left navigates once and requires returning to centre before repeating", () => {
  const detector = createEyeGestureDetector();
  assert.deepEqual(frames(detector, { ...open, yaw: 0 }, 0, 400), []);
  assert.deepEqual(frames(detector, { ...open, yaw: 0.16 }, 500, 900), ["next"]);
  assert.deepEqual(frames(detector, { ...open, yaw: 0.16 }, 1000, 2000), []);
  assert.deepEqual(frames(detector, { ...open, yaw: 0 }, 2100, 2300), []);
  assert.deepEqual(frames(detector, { ...open, yaw: -0.16 }, 2400, 2800), ["previous"]);
});
