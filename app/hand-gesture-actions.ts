import { useEffect, useRef } from "react";
import type { HandAction } from "./hand-gestures";

type Handler = (action: HandAction) => string | undefined | Promise<string | undefined>;
const targets = new Map<symbol, { priority: number; handle: Handler }>();

export function handGesturesBlocked() {
  return document.hidden || [...document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true'], dialog[open]")]
    .some((element) => !element.matches(".headline-player, .article-reader") && element.getClientRects().length > 0);
}

export function useHandGestureTarget(priority: number, active: boolean, handle: Handler) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    if (!active) return;
    const id = Symbol();
    targets.set(id, { priority, handle: (action) => latest.current(action) });
    return () => { targets.delete(id); };
  }, [active, priority]);
}

export async function runHandGestureAction(action: HandAction) {
  if (handGesturesBlocked()) return "Close the pop-up window before using reading gestures.";
  for (const target of [...targets.values()].sort((a, b) => b.priority - a.priority)) {
    const result = await target.handle(action);
    if (result !== undefined) return result;
  }
  return "Open a story or start headline playback to use this gesture.";
}
