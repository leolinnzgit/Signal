"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observeListeningBreak, watchListeningAudio } from "./listening-break";
import "./listening-break.css";

export default function ListeningBreak() {
  const [host, setHost] = useState<Element | null>(null);
  const [until, setUntil] = useState(0);
  const [minutes, setMinutes] = useState(0);

  useEffect(() => {
    const unwatch = watchListeningAudio();
    const unsubscribe = observeListeningBreak(setUntil);
    return () => {
      unsubscribe();
      unwatch();
    };
  }, []);

  useEffect(() => {
    const updateHost = () => {
      const modal = [...document.querySelectorAll("dialog[open], .headline-player[aria-modal='true']")]
        .findLast((element) => element.getClientRects().length > 0);
      setHost(modal ?? document.fullscreenElement ?? document.body);
    };
    updateHost();
    if (!until) return;
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "aria-modal", "style"] });
    document.addEventListener("fullscreenchange", updateHost);
    const update = () => setMinutes(Math.max(1, Math.ceil((until - Date.now()) / 60_000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("fullscreenchange", updateHost);
      observer.disconnect();
    };
  }, [until]);

  if (!host) return null;
  return createPortal(<div role="status" className="listening-break-status">
    {until > 0 && <div className="listening-break-notice">
      <strong>Listening break</strong>
      <span>Signal paused after 60 minutes of listening. Press Play after your ears have had 10 minutes of rest.</span>
      {minutes > 0 && <small aria-hidden="true">{minutes} {minutes === 1 ? "minute" : "minutes"} remaining</small>}
    </div>}
  </div>, host);
}
