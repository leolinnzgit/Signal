import assert from "node:assert/strict";
import test from "node:test";
import { createHandGestureDetector, handGestureTopic } from "../app/hand-gestures.ts";

function frame(pose = "Open_Palm", { x = 0.5, y = 0.5, score = 0.99, pinch = false } = {}) {
  const points = Array.from({ length: 21 }, () => ({ x: 1 - x, y }));
  points[0].y += 0.15;
  points[9].y -= 0.05;
  points[5].x -= 0.10;
  points[17].x += 0.10;
  points[8] = { x: 1 - x + 0.08, y: y - 0.25 };
  points[4] = pinch ? { ...points[8], x: points[8].x + 0.02 } : { x: 1 - x - 0.15, y: y - 0.15 };
  return { landmarks: [points], gestures: [[{ categoryName: pose, score }]] };
}

function hold(detector, value, start, duration) {
  const actions = [];
  for (let time = start; time <= start + duration; time += 100) {
    const { action } = detector.update(value, time);
    if (action) actions.push(action);
  }
  return actions;
}

test("feed gestures choose followed topics from All topics and wrap in either direction", () => {
  const topics = ["Science", "New Zealand", "Technology"];
  assert.equal(handGestureTopic(topics, "All topics", 1), "Science");
  assert.equal(handGestureTopic(topics, "All topics", -1), "Technology");
  assert.equal(handGestureTopic(topics, "Science", 1), "New Zealand");
  assert.equal(handGestureTopic(topics, "Science", -1), "Technology");
  assert.equal(handGestureTopic(topics, "technology", 1), "Science");
  assert.equal(handGestureTopic(["Science"], "Science", 1), "Science");
  assert.equal(handGestureTopic([], "All topics", 1), null);
});

test("palm, fist and thumbs-up require a deliberate hold and fire only once", () => {
  for (const [pose, action] of [["Open_Palm", "pause"], ["Closed_Fist", "resume"], ["Thumb_Up", "bookmark"]]) {
    const detector = createHandGestureDetector();
    assert.deepEqual(hold(detector, frame(pose), 0, 400), []);
    assert.deepEqual(hold(detector, frame(pose), 500, 3000), [action]);
  }
});

test("short or uncertain poses and ordinary tracking noise do not trigger commands", () => {
  const detector = createHandGestureDetector();
  assert.deepEqual(hold(detector, frame("Thumb_Up", { score: 0.4 }), 0, 2000), []);
  assert.deepEqual(hold(detector, frame("Thumb_Up"), 2100, 300), []);
  assert.deepEqual(hold(detector, frame("None"), 2500, 900), []);
});

test("mirrored palm swipes map left to next, right to previous, and vertical movement to scrolling", () => {
  for (const [options, action] of [[{ x: 0.25 }, "next"], [{ x: 0.75 }, "previous"], [{ y: 0.3 }, "scroll-up"], [{ y: 0.7 }, "scroll-down"]]) {
    const detector = createHandGestureDetector();
    detector.update(frame(), 0);
    assert.equal(detector.update(frame("Open_Palm", options), 150).action, action);
    assert.deepEqual(hold(detector, frame("Open_Palm", options), 250, 2000), [], "a swipe must not also pause");
  }
});

test("diagonal motion does not accidentally navigate or scroll", () => {
  const detector = createHandGestureDetector();
  detector.update(frame(), 0);
  assert.equal(detector.update(frame("Open_Palm", { x: 0.75, y: 0.75 }), 150).action, undefined);
});

test("pinch activates once until released, uses palm-relative distance and returns a mirrored pointer", () => {
  const detector = createHandGestureDetector();
  const first = detector.update(frame("None", { pinch: true }), 0);
  assert.equal(first.action, "select");
  assert.equal(first.pointer.x, 0.42000000000000004);
  assert.deepEqual(hold(detector, frame("None", { pinch: true }), 100, 2000), []);
  detector.update(frame("None"), 2200);
  assert.equal(detector.update(frame("None", { pinch: true }), 2300).action, "select");
});

test("cooldown prevents another pose from immediately issuing a different command", () => {
  const detector = createHandGestureDetector();
  hold(detector, frame("Thumb_Up"), 0, 700);
  assert.deepEqual(hold(detector, frame("Closed_Fist"), 800, 800), []);
  assert.equal(detector.update(frame("Closed_Fist"), 1800).action, "resume");
});

test("a fist or thumbs-up cannot accidentally pinch-select with folded fingertips", () => {
  for (const [pose, action] of [["Closed_Fist", "resume"], ["Thumb_Up", "bookmark"]]) {
    const detector = createHandGestureDetector();
    assert.deepEqual(hold(detector, frame(pose, { pinch: true }), 0, 1500), [action]);
  }
});

test("a missing hand, two hands, or a long gap resets the hold timer", () => {
  for (const missing of [{ landmarks: [], gestures: [] }, { landmarks: [frame().landmarks[0], frame().landmarks[0]], gestures: [] }]) {
    const detector = createHandGestureDetector();
    hold(detector, frame("Thumb_Up"), 0, 500);
    assert.equal(detector.update(missing, 600).tracking, false);
    assert.deepEqual(hold(detector, frame("Thumb_Up"), 700, 500), []);
    assert.equal(detector.update(frame("Thumb_Up"), 1400).action, "bookmark");
  }
  const detector = createHandGestureDetector();
  hold(detector, frame("Thumb_Up"), 0, 500);
  assert.equal(detector.update(frame("Thumb_Up"), 2000).action, undefined);
});

test("reset clears a held gesture and malformed landmarks cannot cause commands", () => {
  const detector = createHandGestureDetector();
  hold(detector, frame("Thumb_Up"), 0, 700);
  detector.reset();
  assert.equal(detector.update(frame("Thumb_Up"), 1000).action, undefined);
  const invalid = frame(); invalid.landmarks[0][0].x = NaN;
  assert.equal(detector.update(invalid, 1100).tracking, false);
});
