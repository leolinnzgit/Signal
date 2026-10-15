import type { HandAction, HandPoint } from "./hand-gestures";

export type EyeFrame = { faceCount: number; left?: number; right?: number; yaw?: number; points?: HandPoint[] };
export type EyeTracking = "missing" | "multiple" | "calibrating" | "ready" | "left" | "right" | "both" | "reopen" | "turn-left" | "turn-right";
type Pose = "left" | "right" | "both";
const actionFor = (pose: Pose): HandAction => pose === "both" ? "toggle-playback" : pose === "right" ? "next" : "previous";

// Phone CPUs often deliver face results only every 150–500 ms, so timing
// windows are responsive and holds account for frame intervals.
const FRAME_GAP_MS = 1000;      // a longer gap means we cannot know what the eyes did
const ARM_OPEN_MS = 250;        // both eyes open this long before a gesture can start
const WINK_MIN_MS = 220;        // ordinary involuntary blinks last roughly 80–150 ms
const BLINK_MIN_MS = 220;
const MAX_HOLD_MS = 3000;       // longer closures (resting eyes) cancel
const TRANSITION_MS = 800;      // half-closed frames tolerated while eyelids move
const MAX_BETWEEN_FRAMES = 2;   // ...but only briefly, so lingering squints cancel
const CONFIRM_OPEN_MS = 80;     // stay open briefly so a second closure can cancel
const COOLDOWN_MS = 650;
const WINK_CONTRAST = 0.18;     // a wink's closed eye must close clearly more than the other
const MAX_BASELINE = 0.4;
const HEAD_TURN_THRESHOLD = 0.10;
const HEAD_RESET_THRESHOLD = 0.055;
const HEAD_HOLD_MS = 90;
const MAX_YAW_BASE = 0.15;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// Resting blink scores vary by person, glasses and camera angle (looking down
// at a phone raises them), so thresholds follow each eye's own open baseline.
const closedAt = (base: number) => clamp(base + 0.18, 0.26, 0.68);
const openAt = (base: number) => clamp(base + 0.10, 0.18, closedAt(base) - 0.06);

/** Unmirrored model scores refer to the user's own eyes and head yaw.
 * Positive yaw is turning the head to the user's right; negative is left. */
export function createEyeGestureDetector() {
  let lastTime = -Infinity;
  let openSince: number | null = null;
  let lastOpenAt = -Infinity;
  let armed = false;
  let candidate: { pose: Pose; since: number; lastClosed: number; lastOpenAt: number; frames: number; between: number } | null = null;
  let pending: HandAction | undefined;
  let cooldownUntil = 0;
  let base: { left: number; right: number } | null = null;
  let yawBase: number | null = null;
  let headArmed = false;
  let headTurn: { dir: "left" | "right"; since: number } | null = null;
  function clear() {
    openSince = null; lastOpenAt = -Infinity; armed = false; candidate = null;
    pending = undefined; headArmed = false; headTurn = null;
  }
  return {
    reset() { clear(); lastTime = -Infinity; cooldownUntil = 0; base = null; yawBase = null; },
    update(frame: EyeFrame, now: number): { state: EyeTracking; action?: HandAction } {
      const { left, right, yaw } = frame;
      if (!Number.isFinite(now)) { clear(); return { state: "calibrating" }; }
      if (now <= lastTime || now - lastTime > FRAME_GAP_MS) clear();
      lastTime = now;
      if (frame.faceCount !== 1 || left === undefined || right === undefined ||
          !Number.isFinite(left) || !Number.isFinite(right) || left < 0 || left > 1 || right < 0 || right > 1) {
        clear(); return { state: frame.faceCount > 1 ? "multiple" : "missing" };
      }
      base ??= { left: Math.min(left, MAX_BASELINE), right: Math.min(right, MAX_BASELINE) };

      // Head-turn detection (yaw > 0 is user's right, yaw < 0 is user's left).
      let headTurning = false;
      if ( yaw !== undefined && Number.isFinite(yaw)) {
        yawBase ??= clamp(yaw, -MAX_YAW_BASE, MAX_YAW_BASE);
        const deltaYaw = yaw - yawBase;
        const absYaw = Math.abs(deltaYaw);
        if (absYaw <= HEAD_RESET_THRESHOLD) {
          yawBase = clamp(yawBase + deltaYaw * 0.08, -MAX_YAW_BASE, MAX_YAW_BASE);
          headTurn = null;
          if (now >= cooldownUntil) headArmed = true;
        } else if (absYaw >= HEAD_TURN_THRESHOLD) {
          headTurning = true;
          const dir: "left" | "right" = deltaYaw > 0 ? "right" : "left";
          // Turning the head foreshortens one eye; cancel any eye candidate so a
          // head turn cannot also queue a wink.
          candidate = null; pending = undefined;
          if (headArmed && now >= cooldownUntil) {
            if (!headTurn || headTurn.dir !== dir) headTurn = { dir, since: now };
            else if (now - headTurn.since >= HEAD_HOLD_MS) {
              headArmed = false; headTurn = null; armed = false; openSince = now;
              cooldownUntil = now + COOLDOWN_MS;
              return {
                state: dir === "right" ? "turn-right" : "turn-left",
                action: dir === "right" ? "next" : "previous",
              };
            }
          }
          return { state: dir === "right" ? "turn-right" : "turn-left" };
        }
      }

      const leftClosed = left >= closedAt(base.left);
      const rightClosed = right >= closedAt(base.right);
      const open = left <= openAt(base.left) && right <= openAt(base.right);
      const leftRise = left - base.left;
      const rightRise = right - base.right;
      // Winking often squints the other eye, so compare how far each eye rose
      // above its resting baseline. If one eye crosses closedAt and the other
      // also closes along with it (within WINK_CONTRAST), treat it as "both".
      const pose: Pose | null = headTurning ? null
        : leftClosed && leftRise - rightRise >= WINK_CONTRAST ? "left"
        : rightClosed && rightRise - leftRise >= WINK_CONTRAST ? "right"
        : (leftClosed && rightClosed) || ((leftClosed || rightClosed) && left > openAt(base.left) && right > openAt(base.right)) ? "both"
        : null;
      if (!candidate && !leftClosed && !rightClosed && !headTurning) {
        const follow = (current: number, score: number) =>
          Math.min(MAX_BASELINE, current + (score - current) * (score < current ? 0.15 : 0.08));
        base = { left: follow(base.left, left), right: follow(base.right, right) };
      }

      if (candidate) {
        const c = candidate;
        if (pose === c.pose) {
          c.lastClosed = now; c.frames++; c.between = 0;
        } else if (pose === "both" && now - c.since <= 500) {
          c.pose = "both"; c.lastClosed = now; c.frames++; c.between = 0;
        } else if (c.pose === "both" && pose !== null && now - c.lastClosed <= 400) {
          c.lastClosed = now; c.frames++; c.between = 0;
        } else if (pose && c.pose !== "both") {
          candidate = null; armed = false;
        } else if (open) {
          const onsetPad = Number.isFinite(c.lastOpenAt) ? Math.min(200, Math.max(0, (c.since - c.lastOpenAt - 80) / 2)) : 0;
          const releasePad = Math.min(200, Math.max(0, (now - c.lastClosed - 80) / 2));
          const held = c.lastClosed - c.since + onsetPad + releasePad;
          const minimum = c.pose === "both" ? BLINK_MIN_MS : WINK_MIN_MS;
          const rawHold = c.lastClosed - c.since;
          if (c.frames >= 2 && held >= minimum && rawHold <= MAX_HOLD_MS) {
            pending = actionFor(c.pose);
            armed = false;
          } else if (rawHold > MAX_HOLD_MS) {
            armed = false;
          } else if (now >= cooldownUntil) {
            armed = true;
          }
          candidate = null; openSince = now; lastOpenAt = now;
          return { state: pending ? "reopen" : armed ? "ready" : "calibrating" };
        } else {
          if (c.between === 0 && now - c.lastClosed <= 600) {
            c.lastClosed += Math.min(160, (now - c.lastClosed) / 2);
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
        if (pending && now - openSince >= CONFIRM_OPEN_MS) {
          const action = now >= cooldownUntil ? pending : undefined;
          pending = undefined; openSince = now;
          if (action) cooldownUntil = now + COOLDOWN_MS;
          return { state: "calibrating", action };
        }
        if (!pending && now - openSince >= ARM_OPEN_MS && now >= cooldownUntil) armed = true;
        return { state: pending ? "reopen" : armed ? "ready" : "calibrating" };
      }
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
  ready: "Eyes & head ready · blink, wink or turn head",
  left: "Left wink · hold, then open both eyes",
  right: "Right wink · hold, then open both eyes",
  both: "Long blink · hold, then open both eyes",
  reopen: "Keep both eyes open to confirm",
  "turn-left": "Head turned left · previous",
  "turn-right": "Head turned right · next",
};
