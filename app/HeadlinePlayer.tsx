"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FollowedArticle } from "./NewsDashboard";
import ScreenOffAudioPlayer, { type ScreenOffAudioControls } from "./ScreenOffAudioPlayer";
import { BRIEFING_COMPLETE_MESSAGE } from "./headline-audio";
import {
  createHeadlinePlayback,
  DEVICE_DEFAULT_SPEECH_VOICE,
  findPreferredHeadlineVoice,
  HEADLINE_SPEECH_PREFERENCES_KEY,
  headlineSpeechLanguage,
  headlineVoiceId,
  normalizeHeadlineSpeechPreferences,
  rankHeadlineVoices,
  selectHeadlineVoice,
  shouldPauseHeadlinePlayback,
} from "./headline-playback";

type HeadlinePlayerProps = {
  articles: FollowedArticle[];
  startWithScreenOffAudio?: boolean;
  suspended?: boolean;
  onArticleRead: (article: FollowedArticle) => void;
  onOpenArticle: (article: FollowedArticle) => void;
  onListenArticle: (article: FollowedArticle) => void;
  onClose: () => void;
};

export default function HeadlinePlayer({ articles, startWithScreenOffAudio = false, suspended = false, onArticleRead, onOpenArticle, onListenArticle, onClose }: HeadlinePlayerProps) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(6);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [speechSupported] = useState(() => "speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
  const [readAloud, setReadAloud] = useState(speechSupported);
  const [speechError, setSpeechError] = useState(false);
  const [screenOffAudio, setScreenOffAudio] = useState(startWithScreenOffAudio);
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement);
  const [expanded, setExpanded] = useState(false);
  const mounted = useRef(true);
  const screenOffControls = useRef<ScreenOffAudioControls>(null);
  const [speechPreferences, setSpeechPreferences] = useState(() => {
    try { return normalizeHeadlineSpeechPreferences(JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null")); }
    catch { return normalizeHeadlineSpeechPreferences(null); }
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => speechSupported ? window.speechSynthesis.getVoices() : []);
  const [voicesReady, setVoicesReady] = useState(!speechSupported);
  const playback = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const readUrls = useRef(new Set<string>());
  const completed = index >= articles.length;
  const article = articles[index];
  const title = completed && articles.length ? BRIEFING_COMPLETE_MESSAGE : article?.title;
  const speechLanguage = headlineSpeechLanguage(title ?? "", navigator.language);
  const languageKey = speechLanguage.split("-")[0].toLowerCase();
  const preferredVoiceId = speechPreferences.voices[languageKey] ?? "";
  const availableVoices = useMemo(() => rankHeadlineVoices(voices, speechLanguage), [voices, speechLanguage]);
  const automaticVoice = selectHeadlineVoice(voices, speechLanguage);
  const preferredVoice = findPreferredHeadlineVoice(availableVoices, preferredVoiceId);

  function pausePlayback() {
    screenOffControls.current?.pause();
    playback.current?.setPaused(true);
    setPaused(true);
  }

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    const updateFullscreen = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => {
      mounted.current = false;
      document.removeEventListener("fullscreenchange", updateFullscreen);
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) { void document.exitFullscreen().catch(() => {}); return; }
    if (expanded) { setExpanded(false); return; }
    const element = dialog.current;
    if (!element?.requestFullscreen || !document.fullscreenEnabled) { setExpanded(true); return; }
    void element.requestFullscreen().then(() => {
      if (!mounted.current && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    }).catch(() => { if (mounted.current) setExpanded(true); });
  }

  useEffect(() => {
    // The reader lives outside this dialog, so leave its native fullscreen view.
    if (suspended && document.fullscreenElement === dialog.current) {
      void document.exitFullscreen().catch(() => {});
    }
  }, [suspended]);

  useEffect(() => {
    if (!speechSupported) return;
    const synth = window.speechSynthesis;
    const updateVoices = () => setVoices(synth.getVoices());
    synth.addEventListener("voiceschanged", updateVoices);
    // Give asynchronously loaded browser voices a chance to arrive before choosing.
    const timeout = window.setTimeout(() => { updateVoices(); setVoicesReady(true); }, 500);
    return () => { window.clearTimeout(timeout); synth.removeEventListener("voiceschanged", updateVoices); };
  }, [speechSupported]);

  useEffect(() => {
    try { localStorage.setItem(HEADLINE_SPEECH_PREFERENCES_KEY, JSON.stringify(speechPreferences)); }
    catch { /* Voice controls remain usable when device storage is unavailable. */ }
  }, [speechPreferences]);

  useEffect(() => {
    // Recorded playback owns read tracking: preparing or previewing its title
    // must not remove an unheard story from the next unread briefing.
    if (suspended || screenOffAudio || !article || readUrls.current.has(article.url)) return;
    readUrls.current.add(article.url);
    onArticleRead(article);
  }, [article, onArticleRead, screenOffAudio, suspended]);

  useEffect(() => {
    if (suspended || screenOffAudio || !title || (completed && !readAloud)) return;
    const current = createHeadlinePlayback({
      title,
      seconds: completed ? 0 : 6,
      readAloud,
      preferredVoiceId,
      rate: speechPreferences.rate,
      onAdvance: () => { if (!completed) setIndex((currentIndex) => currentIndex + 1); },
      onSpeechError: () => { setSpeechError(true); setReadAloud(false); },
    }, {
      speech: speechSupported ? window.speechSynthesis : undefined,
      createUtterance: speechSupported ? (text) => new SpeechSynthesisUtterance(text) : undefined,
      language: navigator.language,
      now: () => performance.now(),
      schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      clear: (id) => window.clearTimeout(id),
    });
    playback.current = current;
    return () => { current.dispose(); playback.current = null; };
  }, [completed, index, preferredVoiceId, readAloud, screenOffAudio, speechPreferences.rate, speechSupported, title, suspended]);

  useEffect(() => {
    playback.current?.setPaused(shouldPauseHeadlinePlayback({ paused, pageVisible, readAloud, voicesReady }));
    playback.current?.setSeconds(seconds);
  }, [completed, index, preferredVoiceId, readAloud, seconds, speechPreferences.rate, paused, pageVisible, title, voicesReady, suspended]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    if (suspended) return;
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
        // Escape first returns to the windowed player; narration keeps running.
        if (document.fullscreenElement) return;
        if (dialog.current?.classList.contains("headline-player-expanded")) {
          event.preventDefault();
          setExpanded(false);
          return;
        }
        event.preventDefault();
        onClose();
      }
      const target = event.target;
      const isControl = target instanceof HTMLElement && target.matches("button, a, select, input, textarea, audio");
      if (event.key === " " && !isControl) {
        event.preventDefault();
        if (screenOffControls.current) screenOffControls.current.toggle();
        else setPaused((current) => !current);
      }
      if (event.key === "ArrowRight" && !(target instanceof HTMLSelectElement)) {
        event.preventDefault();
        if (screenOffControls.current) screenOffControls.current.move(1);
        else setIndex((current) => Math.min(articles.length, current + 1));
      }
      if (event.key === "ArrowLeft" && !(target instanceof HTMLSelectElement)) {
        event.preventDefault();
        if (screenOffControls.current) screenOffControls.current.move(-1);
        else setIndex((current) => Math.max(0, current - 1));
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], select:not(:disabled), audio[controls]") ?? []);
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
    // Minimizing can exit native fullscreen before visibilitychange arrives.
    // Fullscreen changes must never close the player or dispose its narration.
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKey);
      background.forEach(({ element, inert }) => { element.inert = inert; });
      document.documentElement.style.overflow = previousRootOverflow;
      Object.assign(document.body.style, previousBodyStyle);
      window.scrollTo(0, scrollPosition);
      trigger?.focus();
    };
  }, [articles.length, onClose, suspended]);

  const fullscreenControl = <button type="button" className="headline-player-fullscreen" aria-pressed={fullscreen || expanded}
    aria-label={fullscreen || expanded ? "Exit full screen" : "Enter full screen"} onClick={toggleFullscreen}>
    {fullscreen || expanded ? "Exit full screen" : "Full screen"}
  </button>;
  const playerClass = `headline-player${fullscreen || expanded ? " headline-player-expanded" : ""}`;

  if (screenOffAudio) return createPortal(
    <><div className="headline-player-backdrop" aria-hidden="true" style={suspended ? { display: "none" } : undefined} />
    <section ref={dialog} className={playerClass} style={suspended ? { display: "none" } : undefined} role="dialog" aria-modal="true" aria-label="Unread headline playback">
      <ScreenOffAudioPlayer ref={screenOffControls} closeButton={closeButton} articles={articles}
        suspended={suspended}
        fullscreenControl={fullscreenControl}
        initialIndex={Math.min(index, articles.length - 1)} seconds={seconds} rate={speechPreferences.rate}
        onRateChange={(rate) => setSpeechPreferences((current) => ({ ...current, rate }))}
        onArticleRead={(item) => { if (!readUrls.current.has(item.url)) { readUrls.current.add(item.url); onArticleRead(item); } }}
        onIndexChange={setIndex} onOpenArticle={onOpenArticle} onListenArticle={onListenArticle} onClose={onClose}
        onExit={() => { pausePlayback(); setScreenOffAudio(false); }} />
    </section></>, document.body,
  );

  return createPortal(
    <><div className="headline-player-backdrop" aria-hidden="true" style={suspended ? { display: "none" } : undefined} />
    <section ref={dialog} className={playerClass} style={suspended ? { display: "none" } : undefined} role="dialog" aria-modal="true" aria-label="Unread headline playback">
      <header className="headline-player-header">
        <span className="headline-player-label"><span className="pulse" aria-hidden="true" /> Unread headlines</span>
        <div className="headline-player-header-actions">
          <span>{completed ? `${articles.length} / ${articles.length}` : `${index + 1} / ${articles.length}`}</span>
          {fullscreenControl}
          <button type="button" className="headline-player-back" onClick={onClose}>Back to news</button>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="Close headline playback" title="Close (Esc)">&#215;</button>
        </div>
      </header>
      <div className="headline-player-stage" aria-live={readAloud && !speechError ? "off" : "polite"} aria-atomic="true">
        {completed ? (
          <div className="headline-player-complete">
            <span aria-hidden="true">&#10003;</span>
            <h2>All caught up.</h2>
            <p>You’ve seen all {articles.length} unread {articles.length === 1 ? "headline" : "headlines"} in this briefing.</p>
            <button type="button" onClick={onClose}>Back to news</button>
          </div>
        ) : (
          <div className="headline-player-story">
            {article.imageUrl && (
              <img key={`${article.url}-${article.imageUrl}`} className="headline-player-image"
                src={article.imageUrl} alt="" decoding="async" referrerPolicy="no-referrer"
                onError={(event) => { event.currentTarget.hidden = true; }} />
            )}
            <h2 key={article.url} className={`headline-player-title${article.title.length > 100 ? " headline-player-title-long" : ""}`}>{article.title}</h2>
            <p className="headline-player-source">{article.source}</p>
            <div className="headline-player-story-actions">
              <button type="button" onClick={() => onOpenArticle(article)}>Read article</button>
              <button type="button" onClick={() => onListenArticle(article)}>Read full news aloud</button>
              <a href={article.url} target="_blank" rel="noreferrer" onClick={pausePlayback}>Open original <span aria-hidden="true">&#8599;</span></a>
            </div>
          </div>
        )}
      </div>
      <label className="headline-player-picker">Choose a headline
        <select
          value={index}
          onFocus={pausePlayback}
          onChange={(event) => { pausePlayback(); setIndex(Number(event.target.value)); }}
        >
          {articles.map((item, articleIndex) => (
            <option key={item.url} value={articleIndex}>{articleIndex + 1}. {item.title} — {item.source}</option>
          ))}
          {completed && <option value={articles.length} disabled>All caught up</option>}
        </select>
      </label>
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
            <div className="headline-player-audio">
              <button type="button" onClick={() => { pausePlayback(); setScreenOffAudio(true); }}>Screen-off audio</button>
              <button
                type="button"
                disabled={!speechSupported}
                aria-pressed={readAloud}
                aria-label={readAloud ? "Mute headline read-aloud" : "Enable headline read-aloud"}
                onClick={() => { setSpeechError(false); setReadAloud((current) => !current); }}
              >
                {speechSupported ? readAloud ? "Voice on" : "Voice off" : "Voice unavailable"}
              </button>
              <span className="headline-player-status" role="status">
                {paused ? "Paused" : speechError ? "Voice unavailable · continuing silently" : readAloud && !voicesReady ? "Preparing voice" : readAloud ? "Reading aloud" : "Auto-playing"}
              </span>
            </div>
          </div>
          <details className="reading-voice-disclosure">
            <summary>Reading voice <span className="reading-voice-show">Show</span><span className="reading-voice-hide">Hide</span></summary>
            <div className="headline-player-voice-settings">
              <label>Reading voice
                <select
                  value={preferredVoiceId === DEVICE_DEFAULT_SPEECH_VOICE ? DEVICE_DEFAULT_SPEECH_VOICE : preferredVoice ? headlineVoiceId(preferredVoice) : ""}
                  disabled={!speechSupported || !voicesReady}
                  onChange={(event) => {
                    const voiceId = event.target.value;
                    setSpeechError(false);
                    setSpeechPreferences((current) => ({ ...current, voices: { ...current.voices, [languageKey]: voiceId } }));
                  }}
                >
                  <option value="">Automatic{automaticVoice ? ` — ${automaticVoice.name}` : " — browser default"}</option>
                  <option value={DEVICE_DEFAULT_SPEECH_VOICE}>Device default — compatibility</option>
                  {availableVoices.map((voice) => <option key={headlineVoiceId(voice)} value={headlineVoiceId(voice)}>{voice.name} ({voice.lang})</option>)}
                </select>
              </label>
              <label>Speaking speed
                <select
                  value={speechPreferences.rate}
                  disabled={!speechSupported}
                  onChange={(event) => setSpeechPreferences((current) => ({ ...current, rate: Number(event.target.value) }))}
                >
                  {Array.from(new Set([0.8, 0.95, 1, 1.1, 1.2, speechPreferences.rate])).sort((left, right) => left - right)
                    .map((rate) => <option key={rate} value={rate}>{rate}×{rate === 0.95 ? " — relaxed" : rate === 1 ? " — normal" : ""}</option>)}
                </select>
              </label>
            </div>
          </details>
        </div>
      )}
    </section></>,
    document.body,
  );
}
