"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FollowedArticle } from "./NewsDashboard";

type HeadlinePlayerProps = {
  articles: FollowedArticle[];
  onArticleRead: (article: FollowedArticle) => void;
  onClose: () => void;
};

export default function HeadlinePlayer({ articles, onArticleRead, onClose }: HeadlinePlayerProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(6);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const readUrls = useRef(new Set<string>());
  const completed = index >= articles.length;
  const article = articles[index];

  useEffect(() => {
    if (!article || readUrls.current.has(article.url)) return;
    readUrls.current.add(article.url);
    onArticleRead(article);
  }, [article, onArticleRead]);

  useEffect(() => {
    if (completed || paused || !pageVisible) return;
    const timeout = window.setTimeout(() => setIndex((current) => current + 1), seconds * 1_000);
    return () => window.clearTimeout(timeout);
  }, [completed, index, paused, pageVisible, seconds]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const scrollPosition = window.scrollY;
    const previousRootOverflow = document.documentElement.style.overflow;
    const previousBodyStyle = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    const background = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialog.current)
      .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    document.documentElement.style.overflow = "hidden";
    Object.assign(document.body.style, { overflow: "hidden", position: "fixed", top: `-${scrollPosition}px`, width: "100%" });
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      const target = event.target;
      const isControl = target instanceof HTMLElement && target.matches("button, select, input, textarea");
      if (event.key === " " && !isControl) {
        event.preventDefault();
        setPaused((current) => !current);
      }
      if (event.key === "ArrowRight" && !(target instanceof HTMLSelectElement)) {
        event.preventDefault();
        setIndex((current) => Math.min(articles.length, current + 1));
      }
      if (event.key === "ArrowLeft" && !(target instanceof HTMLSelectElement)) {
        event.preventDefault();
        setIndex((current) => Math.max(0, current - 1));
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select") ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKey);
    // Escape can be consumed by the browser when leaving native full screen.
    let wasFullscreen = Boolean(document.fullscreenElement);
    const handleFullscreen = () => {
      if (wasFullscreen && !document.fullscreenElement) onClose();
      wasFullscreen = Boolean(document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKey);
      document.removeEventListener("fullscreenchange", handleFullscreen);
      background.forEach(({ element, inert }) => { element.inert = inert; });
      document.documentElement.style.overflow = previousRootOverflow;
      Object.assign(document.body.style, previousBodyStyle);
      window.scrollTo(0, scrollPosition);
      trigger?.focus();
    };
  }, [articles.length, onClose]);

  return createPortal(
    <section ref={dialog} className="headline-player" role="dialog" aria-modal="true" aria-label="Unread headline playback">
      <header className="headline-player-header">
        <span className="headline-player-label"><span className="pulse" aria-hidden="true" /> Unread headlines</span>
        <div className="headline-player-header-actions">
          <span>{completed ? `${articles.length} / ${articles.length}` : `${index + 1} / ${articles.length}`}</span>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="Close headline playback" title="Close (Esc)">&#215;</button>
        </div>
      </header>
      <div className="headline-player-stage" aria-live="polite" aria-atomic="true">
        {completed ? (
          <div className="headline-player-complete">
            <span aria-hidden="true">&#10003;</span>
            <h2>All caught up.</h2>
            <p>You’ve seen all {articles.length} unread {articles.length === 1 ? "headline" : "headlines"} in this briefing.</p>
            <button type="button" onClick={onClose}>Back to news</button>
          </div>
        ) : <h2 key={article.url} className="headline-player-title">{article.title}</h2>}
      </div>
      {!completed && (
        <div className="headline-player-footer">
          <div className="headline-player-progress" role="progressbar" aria-label="Briefing progress" aria-valuemin={0} aria-valuemax={articles.length} aria-valuenow={index + 1}>
            <span style={{ width: `${((index + 1) / articles.length) * 100}%` }} />
          </div>
          <div className="headline-player-controls">
            <label>Seconds per title
              <select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
                <option value={3}>3 seconds</option>
                <option value={6}>6 seconds</option>
                <option value={10}>10 seconds</option>
                <option value={15}>15 seconds</option>
              </select>
            </label>
            <div className="headline-player-transport">
              <button type="button" disabled={index === 0} onClick={() => setIndex((current) => current - 1)} aria-label="Previous headline" title="Previous (←)">&#8592;</button>
              <button type="button" className="headline-player-toggle" onClick={() => setPaused((current) => !current)} aria-label={paused ? "Resume headline playback" : "Pause headline playback"}>{paused ? "Resume" : "Pause"}</button>
              <button type="button" onClick={() => setIndex((current) => current + 1)} aria-label={index === articles.length - 1 ? "Finish headline playback" : "Next headline"} title="Next (→)">&#8594;</button>
            </div>
            <span className="headline-player-status">{paused ? "Paused" : "Auto-playing"}</span>
          </div>
        </div>
      )}
    </section>,
    document.body,
  );
}
