import type { HandAction } from "./hand-gestures";
import type { HandPoint } from "./hand-gestures";

export type EyeFrame = { faceCount: number; left?: number; right?: number; points?: HandPoint[] };
export type EyeTracking = "missing" | "multiple" | "calibrating" | "ready" | "left" | "right" | "both" | "reopen";
type Pose = "left" | "right" | "both";
const actionFor = (pose: Pose): HandAction => pose === "both" ? "toggle-playback" : pose === "right" ? "next" : "previous";

// Phone CPUs often deliver face results only every 200–600 ms, so timing
// windows are deliberately generous and holds account for frame intervals.
const FRAME_GAP_MS = 1000;      // a longer gap means we cannot know what the eyes did
const ARM_OPEN_MS = 350;        // both eyes open this long before a gesture can start
const WINK_MIN_MS = 380;        // ordinary involuntary blinks last roughly 100–250 ms
const BLINK_MIN_MS = 400;
const MAX_HOLD_MS = 3000;       // longer closures (resting eyes) cancel
const TRANSITION_MS = 800;      // half-closed frames tolerated while eyelids move
const MAX_BETWEEN_FRAMES = 2;   // ...but only briefly, so lingering squints cancel
const CONFIRM_OPEN_MS = 100;    // stay open briefly so a second closure can cancel
const COOLDOWN_MS = 900;
const WINK_CONTRAST = 0.22;     // a wink's closed eye must close clearly more than the other
const MAX_BASELINE = 0.4;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// Resting blink scores vary by person, glasses and camera angle (looking down
// at a phone raises them), so thresholds follow each eye's own open baseline.
const closedAt = (base: number) => clamp(base + 0.25, 0.38, 0.72);
const openAt = (base: number) => clamp(base + 0.14, 0.28, closedAt(base) - 0.10);

/** Unmirrored model scores refer to the user's own eyes. Require open eyes
 * before and after a sustained closure; ordinary blinks and tracking gaps cancel. */
export function createEyeGestureDetector() {
  let lastTime = -Infinity;
  let openSince: number | null = null;
  let lastOpenAt = -Infinity;
  let armed = false;
  let candidate: { pose: Pose; since: number; lastClosed: number; lastOpenAt: number; frames: number; between: number } | null = null;
  let pending: HandAction | undefined;
  let cooldownUntil = 0;
  let base: { left: number; right: number } | null = null;
  function clear() { openSince = null; lastOpenAt = -Infinity; armed = false; candidate = null; pending = undefined; }
  return {
    reset() { clear(); lastTime = -Infinity; cooldownUntil = 0; base = null; },
    update(frame: EyeFrame, now: number): { state: EyeTracking; action?: HandAction } {
      const { left, right } = frame;
      if (!Number.isFinite(now)) { clear(); return { state: "calibrating" }; }
      if (now <= lastTime || now - lastTime > FRAME_GAP_MS) clear();
      lastTime = now;
      if (frame.faceCount !== 1 || left === undefined || right === undefined ||
          !Number.isFinite(left) || !Number.isFinite(right) || left < 0 || left > 1 || right < 0 || right > 1) {
        clear(); return { state: frame.faceCount > 1 ? "multiple" : "missing" };
      }
      base ??= { left: Math.min(left, MAX_BASELINE), right: Math.min(right, MAX_BASELINE) };
      const leftClosed = left >= closedAt(base.left);
      const rightClosed = right >= closedAt(base.right);
      const open = left <= openAt(base.left) && right <= openAt(base.right);
      const leftRise = left - base.left;
      const rightRise = right - base.right;
      // Winking often squints the other eye, so compare how far each eye rose
      // above its resting baseline. If one eye crosses closedAt and the other
      // also closes along with it (within WINK_CONTRAST), treat it as "both".
      const pose: Pose | null = leftClosed && leftRise - rightRise >= WINK_CONTRAST ? "left"
        : rightClosed && rightRise - leftRise >= WINK_CONTRAST ? "right"
        : (leftClosed && rightClosed) || ((leftClosed || rightClosed) && left > openAt(base.left) && right > openAt(base.right)) ? "both"
        : null;
      if (!candidate && !leftClosed && !rightClosed) {
        // Settle towards open readings without letting a single wide-eyed frame
        // pull the baseline so low that normal relaxed eyes stop counting as open.
        const follow = (current: number, score: number) =>
          Math.min(MAX_BASELINE, current + (score - current) * (score < current ? 0.15 : 0.08));
        base = { left: follow(base.left, left), right: follow(base.right, right) };
      }

      if (candidate) {
        const c = candidate;
        if (pose === c.pose) {
          c.lastClosed = now; c.frames++; c.between = 0;
        } else if (pose === "both" && now - c.since <= 500) {
          // Eyelids need not cross thresholds in the same frame at blink onset.
          c.pose = "both"; c.lastClosed = now; c.frames++; c.between = 0;
        } else if (c.pose === "both" && pose !== null && now - c.lastClosed <= 400) {
          // One eyelid reopening slightly before the other is still part of a blink.
          c.lastClosed = now; c.frames++; c.between = 0;
        } else if (pose && c.pose !== "both") {
          candidate = null; armed = false;
        } else if (open) {
          const onsetPad = Number.isFinite(c.lastOpenAt) ? Math.min(200, Math.max(0, (c.since - c.lastOpenAt - 100) / 2)) : 0;
          const releasePad = Math.min(200, Math.max(0, (now - c.lastClosed - 100) / 2));
          const held = c.lastClosed - c.since + onsetPad + releasePad;
          const minimum = c.pose === "both" ? BLINK_MIN_MS : WINK_MIN_MS;
          const rawHold = c.lastClosed - c.since;
          if (c.frames >= 2 && held >= minimum && rawHold <= MAX_HOLD_MS) {
            pending = actionFor(c.pose);
            armed = false;
          } else if (rawHold > MAX_HOLD_MS) {
            armed = false;
          } else if (now >= cooldownUntil) {
            // An ordinary short blink should not disarm ready state.
            armed = true;
          }
          candidate = null; openSince = now; lastOpenAt = now;
          return { state: pending ? "reopen" : armed ? "ready" : "calibrating" };
        } else {
          // A single transitional frame on a slow camera still extends the closure slightly.
          if (c.between === 0 && now - c.lastClosed <= 600) {
            c.lastClosed += Math.min(150, (now - c.lastClosed) / 2);
            c.frames++;
          }
          if (++c.between > MAX_BETWEEN_FRAMES || now - c.lastClosed > TRANSITION_MS) {
            candidate = null; armed = false;
          }
        }
        return { state: candidate?.pose ?? "calibrating" };
      }

      if (open) {
        openSince ??= now;
        lastOpenAt = now;
        // A short reopening confirms the gesture; keep looking normally before
        // arming another one, including after switching practice mode or views.
        if (pending && now - openSince >= CONFIRM_OPEN_MS) {
          const action = now >= cooldownUntil ? pending : undefined;
          pending = undefined; openSince = now;
          if (action) cooldownUntil = now + COOLDOWN_MS;
          return { state: "calibrating", action };
        }
        if (!pending && now - openSince >= ARM_OPEN_MS && now >= cooldownUntil) armed = true;
        return { state: pending ? "reopen" : armed ? "ready" : "calibrating" };
      }
      // A second closure during confirmation cancels the earlier command, but a
      // slight squint while keeping eyes open should not reset confirmation.
      if (pending) {
        if (pose || leftClosed || rightClosed) { pending = undefined; openSince = null; armed = false; return { state: "calibrating" }; }
        if (openSince !== null && now - openSince >= CONFIRM_OPEN_MS) {
          const action = now >= cooldownUntil ? pending : undefined;
          pending = undefined; openSince = now;
          if (action) cooldownUntil = now + COOLDOWN_MS;
          return { state: "calibrating", action };
        }
        return { state: "reopen" };
      }
      openSince = null;
      if (armed && pose) {
        candidate = { pose, since: now, lastClosed: now, lastOpenAt, frames: 1, between: 0 };
        armed = false;
      }
      return { state: candidate?.pose ?? (armed ? "ready" : "calibrating") };
    },
  };
}

export const EYE_TRACKING_LABELS: Record<EyeTracking, string> = {
  missing: "No face in view", multiple: "Show just one face",
  calibrating: "Look at the camera with both eyes open",
  ready: "Eyes ready · wink or long blink",
  left: "Left wink · hold, then open both eyes",
  right: "Right wink · hold, then open both eyes",
  both: "Long blink · hold, then open both eyes",
  reopen: "Keep both eyes open to confirm",
};
