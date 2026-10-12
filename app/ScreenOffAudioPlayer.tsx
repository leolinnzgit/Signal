"use client";

import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import { audioHeadlineIndex, preparedAudioCache, prepareHeadlineAudio, type PreparedHeadlineAudio, type ReadingVoicePreferences } from "./headline-audio";
import ReadingVoiceSelector, { useReadingVoices } from "./ReadingVoiceSelector";

export type ScreenOffAudioControls = { pause: () => void; toggle: () => void; move: (direction: number) => void };
type Props = {
  ref: Ref<ScreenOffAudioControls>;
  closeButton: Ref<HTMLButtonElement>;
  fullscreenControl: ReactNode;
  articles: FollowedArticle[];
  initialIndex: number;
  seconds: number;
  rate: number;
  onRateChange: (rate: number) => void;
  onArticleRead: (article: FollowedArticle) => void;
  onIndexChange: (index: number) => void;
  onOpenArticle: (article: FollowedArticle) => void;
  onListenArticle: (article: FollowedArticle) => void;
  onClose: () => void;
  onExit: () => void;
};

export default function ScreenOffAudioPlayer({ ref, closeButton, fullscreenControl, articles, initialIndex, seconds, rate, onRateChange, onArticleRead, onIndexChange, onOpenArticle, onListenArticle, onClose, onExit }: Props) {
  const [track, setTrack] = useState<{ url: string; starts: number[] } | null>(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(true);
  const [preparedCount, setPreparedCount] = useState(0);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const [index, setIndex] = useState(initialIndex);
  const audio = useRef<HTMLAudioElement>(null);
  const lastIndex = useRef(initialIndex);
  const initialPosition = useRef(initialIndex);
  const resumeTime = useRef<number | null>(null);
  const restorePosition = useRef(true);
  const recordingKey = useRef("");
  const actions = useRef<ScreenOffAudioControls | null>(null);
  const completed = index >= articles.length;
  const article = articles[index];
  const readingVoices = useReadingVoices();

  useEffect(() => {
    if (readingVoices.loading) return;
    const abort = new AbortController();
    let url = "";
    const titles = articles.map((item) => item.title);
    recordingKey.current = preparedAudioCache.key(titles, seconds, navigator.language, readingVoices.preferences);
    const ready = preparedAudioCache.get(titles, seconds, navigator.language, readingVoices.preferences);
    setError("");
    setTrack(null);
    setPreparedCount(0);
    const useRecording = (prepared: PreparedHeadlineAudio) => {
        if (abort.signal.aborted) return;
        resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
        restorePosition.current = true;
        url = URL.createObjectURL(prepared.blob);
        setTrack({ url, starts: prepared.starts });
    };
    if (ready) useRecording(ready);
    else void prepareHeadlineAudio(titles, seconds, navigator.language, abort.signal, undefined,
      (prepared) => { if (!abort.signal.aborted) setPreparedCount(prepared); }, 15_000, readingVoices.preferences)
      .then(useRecording)
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Audio could not be prepared.");
      });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [articles, seconds, preparationAttempt, readingVoices.loading, readingVoices.preferences.en, readingVoices.preferences.zh]);

  function selectVoice(language: keyof ReadingVoicePreferences, id: string) {
    if (readingVoices.preferences[language] === id) return;
    pause();
    initialPosition.current = Math.min(index, articles.length - 1);
    restorePosition.current = false;
    readingVoices.selectVoice(language, id);
  }

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate, track]);

  useEffect(() => {
    const element = audio.current;
    const key = recordingKey.current;
    return () => { if (element) preparedAudioCache.savePosition(key, element.ended ? 0 : element.currentTime); element?.pause(); };
  }, [track]);

  function pause() { audio.current?.pause(); setPaused(true); }
  function toggle() {
    const element = audio.current;
    if (!element || !track) return;
    if (!element.paused) pause();
    else void element.play().catch(() => { setError("Tap Play on the audio controls to start listening."); setPaused(true); });
  }
  function navigate(nextIndex: number) {
    if (!track || !audio.current) return;
    const next = Math.max(0, Math.min(articles.length - 1, nextIndex));
    lastIndex.current = next;
    audio.current.currentTime = track.starts[next];
    setIndex(next);
    onIndexChange(next);
  }
  function move(direction: number) { navigate(index + direction); }
  useImperativeHandle(ref, () => ({ pause, toggle, move }));
  useEffect(() => { actions.current = { pause, toggle, move }; });

  function syncPosition(seeking = false) {
    if (!track || !audio.current) return;
    preparedAudioCache.savePosition(recordingKey.current, audio.current.ended ? 0 : audio.current.currentTime);
    const next = audioHeadlineIndex(track.starts, audio.current.currentTime);
    const first = seeking || next < lastIndex.current ? next : lastIndex.current;
    // Metadata loading, restoring a position, and seeking while paused also
    // update the playhead. Only listening should consume unread stories.
    if (!audio.current.paused || audio.current.ended) {
      for (let heard = first; heard <= next; heard++) onArticleRead(articles[heard]);
    }
    lastIndex.current = next;
    const displayedIndex = audio.current.ended ? articles.length : next;
    setIndex(displayedIndex);
    onIndexChange(displayedIndex);
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && Number.isFinite(audio.current.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.current.duration, position: Math.min(audio.current.currentTime, audio.current.duration), playbackRate: audio.current.playbackRate }); }
      catch { /* Position controls are optional; the audio track keeps playing. */ }
    }
  }

  useEffect(() => {
    if (!track || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { if (audio.current?.paused) actions.current?.toggle(); }],
      ["pause", () => actions.current?.pause()],
      ["stop", () => actions.current?.pause()],
      ["nexttrack", () => actions.current?.move(1)],
      ["previoustrack", () => actions.current?.move(-1)],
      ["seekto", (details) => { if (audio.current && Number.isFinite(details.seekTime)) audio.current.currentTime = Math.max(0, Math.min(audio.current.duration, details.seekTime!)); }],
    ];
    for (const [action, handler] of handlers) {
      try { session.setActionHandler(action, handler); } catch { /* Some browsers support only play and pause. */ }
    }
    const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    const previousType = audioSession?.type;
    try { if (audioSession) audioSession.type = "playback"; } catch { /* Standard audio playback still works. */ }
    const element = audio.current;
    return () => {
      element?.pause();
      for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ } }
      session.metadata = null;
      session.playbackState = "none";
      try { if (audioSession && previousType) audioSession.type = previousType; } catch { /* Optional audio session. */ }
    };
  }, [track]);

  useEffect(() => {
    if (!track || !("mediaSession" in navigator)) return;
    if ("MediaMetadata" in window) navigator.mediaSession.metadata = new MediaMetadata({ title: article?.title ?? "Signal briefing complete", artist: article?.source ?? "Signal", album: "Unread headlines", artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }] });
    navigator.mediaSession.playbackState = paused ? "paused" : "playing";
  }, [article, paused, track]);

  return <>
    <header className="headline-player-header">
      <span className="headline-player-label"><span className="pulse" aria-hidden="true" /> Screen-off audio</span>
      <div className="headline-player-header-actions">
        <span>{Math.min(index + 1, articles.length)} / {articles.length}</span>
        {fullscreenControl}
        <button type="button" className="headline-player-back" onClick={onClose}>Back to news</button>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close headline playback" title="Close (Esc)">&#215;</button>
      </div>
    </header>
    <div className="headline-player-stage">
      {!track ? <div className="article-reader-state" role="status">
        {!error && <span className="article-reader-loader" aria-hidden="true" />}
        <strong>{error ? "Audio unavailable" : "Preparing your audio briefing"}</strong>
        {!error && <p>{preparedCount} of {articles.length} headlines prepared</p>}
        <p>{error || "Keep Signal open while the full briefing is prepared. You can turn off the screen after tapping Play."}</p>
        {error && <button type="button" onClick={() => setPreparationAttempt((attempt) => attempt + 1)}>Try again</button>}
      </div> : completed ? <div className="headline-player-complete"><h2>All caught up.</h2><p>You’ve reached the end of this audio briefing.</p></div> : <div className="headline-player-story">
        {article.imageUrl && (
          <img key={`${article.url}-${article.imageUrl}`} className="headline-player-image"
            src={article.imageUrl} alt="" decoding="async" referrerPolicy="no-referrer"
            onError={(event) => { event.currentTarget.hidden = true; }} />
        )}
        <h2 className={`headline-player-title${article.title.length > 100 ? " headline-player-title-long" : ""}`}>{article.title}</h2>
        <p className="headline-player-source">{article.source}</p>
        <div className="headline-player-story-actions">
          <button type="button" onClick={() => { pause(); onOpenArticle(article); }}>Read article</button>
          <button type="button" onClick={() => { pause(); onListenArticle(article); }}>Read full news aloud</button>
          <a href={article.url} target="_blank" rel="noreferrer" onClick={pause}>Open original &#8599;</a>
        </div>
      </div>}
    </div>
    <div className="screen-off-audio-controls">
      <ReadingVoiceSelector {...readingVoices} selectVoice={selectVoice} active playbackActive={!paused} onPreviewStart={pause} />
      {track && <>
        <p>Tap Play, then turn off the screen. Your phone’s media controls can pause or resume the briefing.</p>
        <audio ref={audio} src={track.url} controls preload="auto" aria-label="Screen-off audio briefing"
          onLoadedMetadata={() => { if (audio.current) audio.current.currentTime = Math.min(resumeTime.current ?? track.starts[initialPosition.current] ?? 0, audio.current.duration); }}
          onPlay={() => { setPaused(false); setError(""); syncPosition(); }} onPause={() => setPaused(true)}
          onTimeUpdate={() => syncPosition()} onSeeking={() => syncPosition(true)}
          onEnded={() => { syncPosition(); setIndex(articles.length); onIndexChange(articles.length); setPaused(true); }}
          onError={() => { setError("The audio could not be played. Try preparing it again."); setPaused(true); }} />
        {error && <p role="alert">{error}</p>}
        <div className="headline-player-transport">
          <button type="button" disabled={index === 0} onClick={() => move(-1)} aria-label="Previous headline">&#8592;</button>
          <button type="button" className="headline-player-toggle" onClick={toggle} aria-label={paused ? "Play audio briefing" : "Pause audio briefing"}>{paused ? "Play" : "Pause"}</button>
          <button type="button" disabled={index >= articles.length - 1} onClick={() => move(1)} aria-label="Next headline">&#8594;</button>
          <label>Speaking speed <select value={rate} onChange={(event) => onRateChange(Number(event.target.value))}>{Array.from(new Set([0.8, 0.95, 1, 1.1, 1.2, rate])).sort().map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        </div>
      </>}
      {/Android/i.test(navigator.userAgent) && <details className="screen-off-audio-help">
        <summary>Audio stops after pressing Home?</summary>
        <p>On Samsung phones, check Settings → Battery → Background usage limits. Remove Signal from Sleeping apps or Deep sleeping apps, and add it to Never sleeping apps. If Signal isn’t listed, check the browser you used to install it.</p>
        <a href="https://developer.samsung.com/mobile/app-management.html" target="_blank" rel="noreferrer">Samsung’s background app guidance &#8599;</a>
      </details>}
      <button type="button" onClick={onExit}>Use browser voice</button>
    </div>
  </>;
}
