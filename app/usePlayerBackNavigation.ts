"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

const STATE_KEY = "signalPlayerNavigation";
type View = "headlines" | "reader";
type Entry = { session: string; views: View[] };

// Give overlay pages real history entries, including a reader above a briefing.
// Closing with a button consumes the same entry as the phone's Back button.
export function usePlayerBackNavigation(views: View[], onBack: (remaining: View[]) => void) {
  const session = useRef<string>(null);
  const current = useRef<View[]>([]);
  const desired = useRef(views);
  const closing = useRef(false);
  const back = useRef(onBack);

  useLayoutEffect(() => {
    desired.current = views;
    back.current = onBack;
  });

  const sync = useCallback(() => {
    if (closing.current) return;
    if (!session.current) {
      if (!desired.current.length) return;
      session.current = crypto.randomUUID();
      window.history.replaceState({ ...window.history.state, [STATE_KEY]: { session: session.current, views: [] } }, "");
    }
    let common = 0;
    while (common < current.current.length && current.current[common] === desired.current[common]) common++;
    if (common < current.current.length) {
      closing.current = true;
      window.history.go(common - current.current.length);
      return;
    }
    while (current.current.length < desired.current.length) {
      current.current = desired.current.slice(0, current.current.length + 1);
      const entry: Entry = { session: session.current, views: current.current };
      window.history.pushState({ ...window.history.state, [STATE_KEY]: entry }, "");
    }
  }, []);

  useLayoutEffect(() => {
    function pop(event: PopStateEvent) {
      if (!session.current) return;
      const entry = event.state?.[STATE_KEY] as Entry | undefined;
      current.current = entry?.session === session.current ? entry.views : [];
      if (closing.current) {
        closing.current = false;
      } else {
        // Forward must never restart a player that has already been closed.
        desired.current = desired.current.filter((view, index) => current.current[index] === view);
        back.current(desired.current);
      }
      sync();
    }
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [sync]);

  useLayoutEffect(sync);
}
