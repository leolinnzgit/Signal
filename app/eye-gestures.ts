import type { HandAction } from "./hand-gestures";

export type EyeFrame = { faceCount: number; left?: number; right?: number };
export type EyeTracking = "missing" | "multiple" | "calibrating" | "ready" | "left" | "right" | "both" | "reopen";
type Pose = "left" | "right" | "both";
const actionFor = (pose: Pose): HandAction => pose === "both" ? "toggle-playback" : pose === "right" ? "next" : "previous";

/** Unmirrored model scores refer to the user's own eyes. Require open eyes
 * before and after a sustained closure; ordinary blinks and tracking gaps cancel. */
export function createEyeGestureDetector() {
  let lastTime = -Infinity;
  let openSince: number | null = null;
  let armed = false;
  let candidate: { pose: Pose; since: number; lastClosed: number } | null = null;
  let pending: HandAction | undefined;
  let cooldownUntil = 0;
  function clear() { openSince = null; armed = false; candidate = null; pending = undefined; }
  return {
    reset() { clear(); lastTime = -Infinity; cooldownUntil = 0; },
    update(frame: EyeFrame, now: number): { state: EyeTracking; action?: HandAction } {
      const { left, right } = frame;
      if (!Number.isFinite(now)) { clear(); return { state: "calibrating" }; }
      if (now <= lastTime || now - lastTime > 600) clear();
      lastTime = now;
      if (frame.faceCount !== 1 || left === undefined || right === undefined ||
          !Number.isFinite(left) || !Number.isFinite(right) || left < 0 || left > 1 || right < 0 || right > 1) {
        clear(); return { state: frame.faceCount > 1 ? "multiple" : "missing" };
      }
      const open = left <= 0.3 && right <= 0.3;
      if (open) {
        if (candidate) {
          const held = candidate.lastClosed - candidate.since;
          const minimum = candidate.pose === "both" ? 1000 : 650;
          if (held >= minimum && held <= 2500 && now - candidate.lastClosed <= 300) pending = actionFor(candidate.pose);
          candidate = null; armed = false;
        }
        openSince ??= now;
        // A short reopening confirms the gesture; keep looking normally before
        // arming another one, including after switching practice mode or views.
        if (pending && now - openSince >= 250) {
          const action = now >= cooldownUntil ? pending : undefined;
          pending = undefined; openSince = now;
          if (action) cooldownUntil = now + 1200;
          return { state: "calibrating", action };
        }
        if (now - openSince >= 600 && now >= cooldownUntil) armed = true;
        return { state: pending ? "reopen" : armed ? "ready" : "calibrating" };
      }
      openSince = null;
      // A second closure during confirmation must not carry an earlier command.
      if (pending) { pending = undefined; armed = false; }
      const pose: Pose | null = left >= 0.65 && right >= 0.65 ? "both"
        : left >= 0.65 && right <= 0.3 ? "left"
        : right >= 0.65 && left <= 0.3 ? "right" : null;
      if (candidate) {
        if (pose === candidate.pose) candidate.lastClosed = now;
        // Eyelids need not cross thresholds in the same frame. Allow a short
        // stagger at the start of a bilateral blink and while reopening.
        else if (pose === "both" && candidate.pose !== "both" && now - candidate.since <= 250) {
          candidate = { pose, since: now, lastClosed: now };
        } else if (now - candidate.lastClosed > 250) { candidate = null; armed = false; }
      } else if (armed && pose) { candidate = { pose, since: now, lastClosed: now }; armed = false; }
      return { state: candidate?.pose ?? "calibrating" };
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
