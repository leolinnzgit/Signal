export type HandAction = "next" | "previous" | "scroll-up" | "scroll-down" | "pause" | "resume" | "bookmark" | "select";
export type HandPoint = { x: number; y: number; z?: number };
export type HandFrame = { landmarks: HandPoint[][]; gestures: { categoryName: string; score: number }[][] };
export const HAND_ACTION_LABELS: Record<HandAction, string> = {
  next: "Next topic / headline", previous: "Previous topic / headline", "scroll-up": "Scroll up", "scroll-down": "Scroll down",
  pause: "Pause reading", resume: "Resume reading", bookmark: "Bookmark article", select: "Select highlighted control",
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
  let pose = "";
  let poseSince = 0;
  let fired = false;
  let pinched = false;
  let anchor: HandPoint | null = null;
  let missingSince: number | null = null;
  function reset() {
    pose = ""; poseSince = 0; fired = false; pinched = false; anchor = null;
  }
  return {
    reset() { reset(); lastTime = -Infinity; cooldownUntil = 0; missingSince = null; },
    update(frame: HandFrame, now: number): { action?: HandAction; pointer?: HandPoint; tracking: boolean } {
      const points = frame.landmarks.length === 1 ? frame.landmarks[0] : null;
      if (!points || points.length < 21 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        missingSince ??= now;
        if (now - missingSince >= 300) reset();
        return { tracking: false };
      }
      if (now - lastTime > 300 || missingSince !== null) reset();
      lastTime = now; missingSince = null;
      const pointer = { x: Math.max(0, Math.min(1, 1 - points[8].x)), y: Math.max(0, Math.min(1, points[8].y)) };
      const distance = (a: HandPoint, b: HandPoint) => Math.hypot(a.x - b.x, a.y - b.y);
      const palmSize = distance(points[5], points[17]);
      const pinchRatio = palmSize > 0.035 ? distance(points[4], points[8]) / palmSize : Infinity;
      const category = frame.gestures[0]?.[0];
      const heldPose = category && category.score >= 0.75 && ["Closed_Fist", "Thumb_Up"].includes(category.categoryName);
      const wasPinched = pinched;
      // Folded fingers can touch a thumb. Keep confident fist/thumbs-up poses
      // from also activating whatever the pointer happens to cover.
      pinched = !heldPose && pinchRatio < (pinched ? 0.5 : 0.28);
      const nextPose = pinched ? "Pinch" : category && category.score >= 0.75 ? category.categoryName : "None";
      const center = { x: 1 - (points[0].x + points[9].x) / 2, y: (points[0].y + points[9].y) / 2 };
      if (pose !== nextPose) {
        pose = nextPose; poseSince = now; fired = false; anchor = center;
      }
      const emit = (action: HandAction) => {
        cooldownUntil = now + 1100; fired = true; anchor = center;
        return { action, pointer, tracking: true };
      };
      if (now < cooldownUntil) return { pointer, tracking: true };
      if (pinched && !wasPinched) return emit("select");
      if (pose === "Open_Palm" && anchor) {
        const dx = center.x - anchor.x;
        const dy = center.y - anchor.y;
        if (Math.abs(dx) >= 0.20 && Math.abs(dx) > Math.abs(dy) * 1.4 && now - poseSince < 1400) {
          return emit(dx < 0 ? "next" : "previous");
        }
        if (Math.abs(dy) >= 0.16 && Math.abs(dy) > Math.abs(dx) * 1.4 && now - poseSince < 1400) {
          return emit(dy < 0 ? "scroll-up" : "scroll-down");
        }
        // Restart the stillness timer whenever the hand moves appreciably.
        if (Math.abs(dx) > 0.045 || Math.abs(dy) > 0.045) {
          if (now - poseSince >= 1400) { anchor = center; poseSince = now; }
        } else if (!fired && now - poseSince >= 900) return emit("pause");
      }
      if (!fired && now - poseSince >= 650) {
        if (pose === "Closed_Fist") return emit("resume");
        if (pose === "Thumb_Up") return emit("bookmark");
      }
      return { pointer, tracking: true };
    },
  };
}
