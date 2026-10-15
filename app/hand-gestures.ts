export type HandAction = "next" | "previous" | "scroll-up" | "scroll-down" | "pause" | "resume" | "toggle-playback" | "bookmark" | "select";
export type HandPoint = { x: number; y: number; z?: number };
export type HandFrame = { landmarks: HandPoint[][]; gestures: { categoryName: string; score: number }[][] };
export type HandTracking = "missing" | "multiple" | "tracking";
export const HAND_ACTION_LABELS: Record<HandAction, string> = {
  next: "Next topic / headline", previous: "Previous topic / headline", "scroll-up": "Scroll up", "scroll-down": "Scroll down",
  pause: "Pause reading", resume: "Resume reading", "toggle-playback": "Pause / resume reading", bookmark: "Bookmark article", select: "Select highlighted control",
};

export function handGestureTopic(topics: readonly string[], current: string, direction: 1 | -1): string | null {
  if (!topics.length) return null;
  const index = topics.findIndex((topic) => topic.toLowerCase() === current.toLowerCase());
  if (index < 0) return direction === 1 ? topics[0] : topics[topics.length - 1];
  return topics[(index + direction + topics.length) % topics.length];
}

/** Recognition is deliberately temporal: held poses fire once, and a moving palm
 * never also pauses playback. Coordinates match the mirrored selfie preview. */
export function createHandGestureDetector() {
  let lastTime = -Infinity;
  let cooldownUntil = 0;
  let motionCooldownUntil = 0;
  let pose = "";
  let poseSince = 0;
  let fired = false;
  let pinched = false;
  let anchor: HandPoint | null = null;
  let missingSince: number | null = null;
  let lastOpenAt = -Infinity;
  let motion: { x: number; y: number; time: number; size: number }[] = [];
  function reset() {
    pose = ""; poseSince = 0; fired = false; pinched = false; anchor = null;
    motion = []; lastOpenAt = -Infinity;
  }
  return {
    reset() { reset(); lastTime = -Infinity; cooldownUntil = 0; motionCooldownUntil = 0; missingSince = null; },
    update(frame: HandFrame, now: number): { action?: HandAction; pointer?: HandPoint; tracking: boolean; state: HandTracking } {
      const points = frame.landmarks.length === 1 ? frame.landmarks[0] : null;
      if (!points || points.length < 21 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        missingSince ??= now;
        // A lost frame breaks a held pose, but a short tracking dropout need
        // not discard the motion already observed during a deliberate swipe.
        pose = ""; poseSince = 0; fired = false; anchor = null; pinched = false;
        if (frame.landmarks.length > 1 || now - missingSince >= 650) reset();
        return { tracking: false, state: frame.landmarks.length > 1 ? "multiple" : "missing" };
      }
      // Phone inference can take several hundred milliseconds per frame.
      // Time windows describe gestures, rather than assuming a desktop FPS.
      if (now - lastTime > 1800 || (missingSince !== null && now - missingSince >= 650)) reset();
      else if (now - lastTime > 700) { pose = ""; poseSince = 0; fired = false; anchor = null; pinched = false; }
      lastTime = now; missingSince = null;
      const tracked = { tracking: true, state: "tracking" as const };
      const pointer = { x: Math.max(0, Math.min(1, 1 - points[8].x)), y: Math.max(0, Math.min(1, points[8].y)) };
      const distance = (a: HandPoint, b: HandPoint) => Math.hypot(a.x - b.x, a.y - b.y);
      const palmSize = distance(points[5], points[17]);
      const pinchRatio = palmSize > 0.035 ? distance(points[4], points[8]) / palmSize : Infinity;
      const category = frame.gestures[0]?.[0];
      const heldPose = category && category.score >= 0.65 && ["Closed_Fist", "Thumb_Up"].includes(category.categoryName);
      const wasPinched = pinched;
      // Folded fingers can touch a thumb. Keep confident fist/thumbs-up poses
      // from also activating whatever the pointer happens to cover.
      pinched = !heldPose && pinchRatio < (pinched ? 0.5 : 0.28);
      const extendedFingers = [[8, 6], [12, 10], [16, 14], [20, 18]]
        .filter(([tip, joint]) => distance(points[tip], points[0]) > distance(points[joint], points[0]) * 1.12).length;
      const open = !pinched && !heldPose && ((category?.categoryName === "Open_Palm" && category.score >= 0.5) || extendedFingers >= 3);
      if (open) lastOpenAt = now;
      const nextPose = pinched ? "Pinch" : open ? "Open_Palm" : category && category.score >= 0.65 ? category.categoryName : "None";
      const center = { x: 1 - (points[0].x + points[9].x) / 2, y: (points[0].y + points[9].y) / 2 };
      if (pose !== nextPose) {
        pose = nextPose; poseSince = now; fired = false; anchor = center;
      }
      const emit = (action: HandAction) => {
        cooldownUntil = now + 1100; fired = true; anchor = center;
        if (action !== "pause") { motionCooldownUntil = now + 900; motion = []; }
        return { action, pointer, ...tracked };
      };
      const movingOpenHand = !pinched && !heldPose && now - lastOpenAt <= 900;
      if (movingOpenHand) {
        motion = motion.filter((sample) => now - sample.time <= 1800);
        motion.push({ ...center, time: now, size: palmSize });
        if (now < motionCooldownUntil) motion = motion.slice(-1);
        const first = motion[0];
        const dx = center.x - first.x;
        const dy = center.y - first.y;
        // A swipe needs roughly a palm's width, capped for close-up hands.
        const threshold = Math.max(0.10, Math.min(0.18, (first.size + palmSize) * 0.45));
        if (now >= motionCooldownUntil && now - first.time >= 80) {
          if (Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.3) return emit(dx < 0 ? "next" : "previous");
          if (Math.abs(dy) >= threshold && Math.abs(dy) > Math.abs(dx) * 1.3) return emit(dy < 0 ? "scroll-up" : "scroll-down");
        }
      } else motion = [];
      if (now < cooldownUntil) return { pointer, ...tracked };
      if (pinched && !wasPinched) return emit("select");
      if (pose === "Open_Palm" && anchor) {
        if (distance(center, anchor) > 0.035) { anchor = center; poseSince = now; }
        else if (!fired && now - poseSince >= 900) return emit("pause");
      }
      if (!fired && now - poseSince >= 650) {
        if (pose === "Closed_Fist") return emit("resume");
        if (pose === "Thumb_Up") return emit("bookmark");
      }
      return { pointer, ...tracked };
    },
  };
}
