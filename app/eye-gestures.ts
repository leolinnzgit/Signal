import type { HandAction } from "./hand-gestures";

export type EyeFrame = { faceCount: number; left?: number; right?: number };
export type EyeTracking = "missing" | "multiple" | "calibrating" | "ready" | "left" | "right" | "both" | "reopen";
type Pose = "left" | "right" | "both";
const actionFor = (pose: Pose): HandAction => pose === "both" ? "toggle-playback" : pose === "right" ? "next" : "previous";

// Phone CPUs often deliver face results only every 200–800 ms, so timing
// windows are deliberately generous and holds are estimated between frames.
const FRAME_GAP_MS = 1000;      // a longer gap means we cannot know what the eyes did
const ARM_OPEN_MS = 400;        // both eyes open this long before a gesture can start
const WINK_MIN_MS = 400;        // ordinary blinks last roughly 100–300 ms
const BLINK_MIN_MS = 600;
const MAX_HOLD_MS = 3000;       // longer closures (resting eyes) cancel
const TRANSITION_MS = 800;      // half-closed frames tolerated while eyelids move
const MAX_BETWEEN_FRAMES = 2;   // ...but only briefly, so lingering squints cancel
const CONFIRM_OPEN_MS = 150;    // stay open briefly so a second closure can cancel
const COOLDOWN_MS = 1000;
const WINK_CONTRAST = 0.25;     // a wink's closed eye must be clearly more closed
const MAX_BASELINE = 0.4;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// Resting blink scores vary by person, glasses and camera angle (looking down
// at a phone raises them), so thresholds follow each eye's own open baseline.
const closedAt = (base: number) => clamp(base + 0.3, 0.5, 0.8);
const openAt = (base: number) => clamp(base + 0.12, 0.25, closedAt(base) - 0.15);

/** Unmirrored model scores refer to the user's own eyes. Require open eyes
 * before and after a sustained closure; ordinary blinks and tracking gaps cancel. */
export function createEyeGestureDetector() {
  let lastTime = -Infinity;
  let openSince: number | null = null;
  let armed = false;
  let candidate: { pose: Pose; since: number; lastClosed: number; between: number } | null = null;
  let pending: HandAction | undefined;
  let cooldownUntil = 0;
  let base: { left: number; right: number } | null = null;
  function clear() { openSince = null; armed = false; candidate = null; pending = undefined; }
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
      // Winking often squints the other eye, so compare the eyes rather than
      // demanding the open eye be fully relaxed.
      const pose: Pose | null = leftClosed && rightClosed ? "both"
        : leftClosed && left - right >= WINK_CONTRAST ? "left"
        : rightClosed && right - left >= WINK_CONTRAST ? "right" : null;
      if (!candidate && !leftClosed && !rightClosed) {
        // Settle quickly towards more-open readings and slowly towards squints.
        const follow = (current: number, score: number) =>
          Math.min(MAX_BASELINE, current + (score - current) * (score < current ? 0.3 : 0.05));
        base = { left: follow(base.left, left), right: follow(base.right, right) };
      }

      if (candidate) {
        const c = candidate;
        if (pose === c.pose) c.lastClosed = now;
        // Eyelids need not cross thresholds in the same frame: a wink may turn
        // into a long blink at onset, and a long blink may reopen one eye first.
        else if (pose === "both" && now - c.since <= 400) { c.pose = "both"; c.lastClosed = now; }
        else if (pose && c.pose !== "both") { candidate = null; armed = false; }
        else if (open) {
          const held = c.lastClosed - c.since + Math.min(200, (now - c.lastClosed) / 2);
          const minimum = c.pose === "both" ? BLINK_MIN_MS : WINK_MIN_MS;
          if (held >= minimum && held <= MAX_HOLD_MS) pending = actionFor(c.pose);
          candidate = null; armed = false; openSince = now;
          return { state: pending ? "reopen" : "calibrating" };
        } else if (++c.between > MAX_BETWEEN_FRAMES || now - c.lastClosed > TRANSITION_MS) { candidate = null; armed = false; }
        if (pose === c.pose) c.between = 0;
        return { state: candidate?.pose ?? "calibrating" };
      }

      if (open) {
        openSince ??= now;
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
      openSince = null;
      // A second closure during confirmation must not carry an earlier command.
      if (pending) {
        if (pose) { pending = undefined; armed = false; }
        return { state: pending ? "reopen" : "calibrating" };
      }
      if (armed && pose) { candidate = { pose, since: now, lastClosed: now, between: 0 }; armed = false; }
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
