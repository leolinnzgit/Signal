"use client";

import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useHandGestureTarget } from "./hand-gesture-actions";
import type { FollowedArticle } from "./NewsDashboard";
import { audioHeadlineIndex, briefingNarrationTitles, preparedAudioCache, prepareHeadlineAudio, type PreparedHeadlineAudio, type ReadingVoicePreferences } from "./headline-audio";
import ReadingVoiceSelector, { useReadingVoices } from "./ReadingVoiceSelector";
import BriefingMarketPrice from "./BriefingMarketPrice";
import type { MarketQuote } from "./market-quote";
import { openArticleAudioStream } from "./article-audio-stream";

export type ScreenOffAudioControls = { pause: () => void; toggle: () => void; move: (direction: number) => void };
type Props = {
  ref: Ref<ScreenOffAudioControls>;
  closeButton: Ref<HTMLButtonElement>;
  fullscreenControl: ReactNode;
  articles: FollowedArticle[];
  marketQuote?: MarketQuote | null;
  initialIndex: number;
  suspended?: boolean;
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

export default function ScreenOffAudioPlayer({ ref, closeButton, fullscreenControl, articles, marketQuote, initialIndex, suspended = false, seconds, rate, onRateChange, onArticleRead, onIndexChange, onOpenArticle, onListenArticle, onClose, onExit }: Props) {
  const [track, setTrack] = useState<{ url: string; streaming: boolean } | null>(null);
  const [starts, setStarts] = useState<number[]>([]);
  const [streamComplete, setStreamComplete] = useState(false);
  const [useStream, setUseStream] = useState(true);
  const [, setBufferVersion] = useState(0);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(true);
  const [preparedCount, setPreparedCount] = useState(0);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const [index, setIndex] = useState(initialIndex);
  const audio = useRef<HTMLAudioElement>(null);
  const lastIndex = useRef(initialIndex);
  const initialPosition = useRef(initialIndex);
  const resumeTime = useRef<number | null>(null);
  const resumeAfterReader = useRef(false);
  const restorePosition = useRef(true);
  const recordingKey = useRef("");
  const positionRestored = useRef(false);
  const actions = useRef<ScreenOffAudioControls | null>(null);
  const completed = index >= articles.length;
  const article = articles[index];
  const readingVoices = useReadingVoices();

  useEffect(() => {
    if (readingVoices.loading) return;
    const abort = new AbortController();
    let url = "";
    // Include the closing announcement in the same track for screen-off playback.
    const titles = briefingNarrationTitles(articles.map((item) => item.title));
    recordingKey.current = preparedAudioCache.key(titles, seconds, navigator.language, readingVoices.preferences);
    const ready = preparedAudioCache.get(titles, seconds, navigator.language, readingVoices.preferences);
    setError("");
    setTrack(null);
    setStarts([]);
    setStreamComplete(false);
    setPaused(true);
    positionRestored.current = false;
    setPreparedCount(0);
    const useRecording = (prepared: PreparedHeadlineAudio) => {
        if (abort.signal.aborted) return;
        resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
        restorePosition.current = true;
        url = URL.createObjectURL(prepared.blob);
        setStarts(prepared.starts);
        setTrack({ url, streaming: false });
    };
    if (ready) useRecording(ready);
    else if (useStream && readingVoices.streaming && titles.length <= 2_001 && titles.join("").length <= 400_000) {
      // A single native media request keeps streaming with the screen locked.
      // Polling only supplies display timing; it never drives audio playback.
      recordingKey.current += ":stream";
      resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
      restorePosition.current = true;
      void openArticleAudioStream(titles, navigator.language, readingVoices.preferences, abort.signal, (status) => {
        if (abort.signal.aborted) return;
        setStarts(status.starts);
        setPreparedCount(Math.min(status.starts.length, articles.length));
        setStreamComplete(status.complete);
        if (status.error) {
          audio.current?.pause();
          setError(status.error);
          setPaused(true);
        }
      }, undefined, seconds).then((streamUrl) => {
        if (!abort.signal.aborted) setTrack({ url: streamUrl, streaming: true });
      }).catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "The audio stream could not be opened.");
      });
    }
    else void prepareHeadlineAudio(titles, seconds, navigator.language, abort.signal, undefined,
      (prepared) => { if (!abort.signal.aborted) setPreparedCount(Math.min(prepared, articles.length)); }, 15_000, readingVoices.preferences)
      .then(useRecording)
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Audio could not be prepared.");
      });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [articles, seconds, preparationAttempt, readingVoices.loading, readingVoices.preferences.en, readingVoices.preferences.zh, readingVoices.streaming, useStream]);

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
    return () => {
      if (!element) return;
      preparedAudioCache.savePosition(key, element.ended ? 0 : element.currentTime);
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [track]);

  function canSeek(time: number) {
    const element = audio.current;
    if (!element || !Number.isFinite(time)) return false;
    if (!track?.streaming) return Number.isFinite(element.duration) && time <= element.duration;
    for (let range = 0; range < element.buffered.length; range++) {
      if (time >= element.buffered.start(range) && time <= element.buffered.end(range)) return true;
    }
    return false;
  }

  function restorePlaybackPosition() {
    if (positionRestored.current || !audio.current) return;
    const position = resumeTime.current ?? (initialPosition.current === 0 ? 0 : starts[initialPosition.current]);
    if (position === undefined || !canSeek(position)) return;
    positionRestored.current = true;
    audio.current.currentTime = position;
  }
  function updateBuffer() { restorePlaybackPosition(); setBufferVersion((version) => version + 1); }
  useEffect(restorePlaybackPosition, [starts, streamComplete]);

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
    if (!canSeek(starts[next])) return;
    lastIndex.current = next;
    positionRestored.current = true;
    audio.current.currentTime = starts[next];
    setIndex(next);
    onIndexChange(next);
  }
  function move(direction: number) { navigate(index + direction); }
  useHandGestureTarget(25, !suspended, async (action) => {
    if (action === "bookmark") return undefined;
    if (!track || !audio.current) return "Prepare the recording and tap Play first.";
    if (action === "pause" || (action === "toggle-playback" && !audio.current.paused)) { pause(); return "Audio briefing paused."; }
    if (action === "resume" || action === "toggle-playback") {
      try { await audio.current.play(); return "Audio briefing resumed."; }
      catch { return "Your browser requires a tap. Tap Play to resume the briefing."; }
    }
    if (action === "next" || action === "previous") { move(action === "next" ? 1 : -1); return action === "next" ? "Next headline." : "Previous headline."; }
    return "Open the article to scroll its text.";
  });
  useImperativeHandle(ref, () => ({ pause, toggle, move }));
  useEffect(() => { actions.current = { pause, toggle, move }; });

  function syncPosition(seeking = false) {
    if (!track || !audio.current) return;
    if (!positionRestored.current || !starts.length) return;
    preparedAudioCache.savePosition(recordingKey.current, audio.current.ended ? 0 : audio.current.currentTime);
    const next = audioHeadlineIndex(starts, audio.current.currentTime);
    const first = seeking || next < lastIndex.current ? next : lastIndex.current;
    // Metadata loading, restoring a position, and seeking while paused also
    // update the playhead. Only listening should consume unread stories.
    if (!audio.current.paused || audio.current.ended) {
      for (let heard = first; heard <= next && heard < articles.length; heard++) onArticleRead(articles[heard]);
    }
    lastIndex.current = next;
    const displayedIndex = audio.current.ended ? articles.length : next;
    setIndex(displayedIndex);
    onIndexChange(displayedIndex);
    if (!suspended && "mediaSession" in navigator && navigator.mediaSession.setPositionState && Number.isFinite(audio.current.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.current.duration, position: Math.min(audio.current.currentTime, audio.current.duration), playbackRate: audio.current.playbackRate }); }
      catch { /* Position controls are optional; the audio track keeps playing. */ }
    }
  }

  useEffect(() => {
    if (suspended || !track || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { if (audio.current?.paused) actions.current?.toggle(); }],
      ["pause", () => actions.current?.pause()],
      ["stop", () => actions.current?.pause()],
      ["nexttrack", () => actions.current?.move(1)],
      ["previoustrack", () => actions.current?.move(-1)],
      ["seekto", (details) => { if (audio.current && Number.isFinite(details.seekTime) && canSeek(details.seekTime!)) audio.current.currentTime = Math.max(0, details.seekTime!); }],
    ];
    for (const [action, handler] of handlers) {
      try { session.setActionHandler(action, handler); } catch { /* Some browsers support only play and pause. */ }
    }
    const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    const previousType = audioSession?.type;
    try { if (audioSession) audioSession.type = "playback"; } catch { /* Standard audio playback still works. */ }
    return () => {
      for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Unsupported action. */ } }
      session.metadata = null;
      session.playbackState = "none";
      try { if (audioSession && previousType) audioSession.type = previousType; } catch { /* Optional audio session. */ }
    };
  }, [track, suspended]);

  useEffect(() => {
    if (suspended || !track || !("mediaSession" in navigator)) return;
    if ("MediaMetadata" in window) navigator.mediaSession.metadata = new MediaMetadata({ title: article?.title ?? "Signal briefing complete", artist: article?.source ?? "Signal", album: "Unread headlines", artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }] });
    navigator.mediaSession.playbackState = paused ? "paused" : "playing";
  }, [article, paused, track, suspended]);

  useEffect(() => {
    const element = audio.current;
    if (suspended) {
      resumeAfterReader.current = !!element && !element.paused && !element.ended;
      pause();
    } else if (resumeAfterReader.current) {
      resumeAfterReader.current = false;
      void element?.play().catch(() => {
        setError("Tap Play on the audio controls to resume listening.");
        setPaused(true);
      });
    }
  }, [suspended]);

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
    <BriefingMarketPrice quote={marketQuote} />
    <div className="headline-player-stage">
      {!track ? <div className="article-reader-state" role="status">
        {!error && <span className="article-reader-loader" aria-hidden="true" />}
        <strong>{error ? "Audio unavailable" : "Loading your audio briefing"}</strong>
        {!error && !useStream && <p>{preparedCount} of {articles.length} headlines ready</p>}
        <p>{error || (useStream && readingVoices.streaming ? "Opening your audio stream. Tap Play to listen while the remaining headlines are generated." : "Loading saved audio and preparing any new headlines. Keep Signal open until it is ready, then tap Play and turn off the screen.")}</p>
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
          <button type="button" onClick={() => onOpenArticle(article)}>Read article</button>
          <button type="button" onClick={() => onListenArticle(article)}>Read full news aloud</button>
          <a href={article.url} target="_blank" rel="noreferrer" onClick={pause}>Open original &#8599;</a>
        </div>
      </div>}
    </div>
    <div className="screen-off-audio-controls">
      <ReadingVoiceSelector {...readingVoices} selectVoice={selectVoice} active playbackActive={!paused} onPreviewStart={pause} />
      {track && <>
        <p>{track.streaming && !streamComplete ? "Tap Play to start listening while the rest of the briefing is generated. You can turn off the screen." : "Tap Play, then turn off the screen. Your phone’s media controls can pause or resume the briefing."}</p>
        <audio ref={audio} src={track.url} controls preload="auto" aria-label="Screen-off audio briefing"
          onLoadedMetadata={updateBuffer} onCanPlay={updateBuffer} onProgress={updateBuffer}
          onPlay={() => { setPaused(false); setError(""); syncPosition(); }} onPause={() => setPaused(true)}
          onTimeUpdate={() => syncPosition()} onSeeking={() => syncPosition(true)}
          onEnded={() => { syncPosition(); setIndex(articles.length); onIndexChange(articles.length); setPaused(true); }}
          onError={() => { setError("The audio could not be played. Try again or prepare a recording instead."); setPaused(true); }} />
        {track.streaming && !streamComplete && !error && <p role="status">Streaming audio · {preparedCount} of {articles.length} headlines generated. Skip controls become available as audio arrives.</p>}
        {error && <><p role="alert">{error}</p><button type="button" onClick={() => setPreparationAttempt((attempt) => attempt + 1)}>Try again</button></>}
        <div className="headline-player-transport">
          <button type="button" disabled={index === 0 || !canSeek(starts[index - 1])} onClick={() => move(-1)} aria-label="Previous headline">&#8592;</button>
          <button type="button" className="headline-player-toggle" onClick={toggle} aria-label={paused ? "Play audio briefing" : "Pause audio briefing"}>{paused ? "Play" : "Pause"}</button>
          <button type="button" disabled={index >= articles.length - 1 || !canSeek(starts[index + 1])} onClick={() => move(1)} aria-label="Next headline">&#8594;</button>
          <label>Speaking speed <select value={rate} onChange={(event) => onRateChange(Number(event.target.value))}>{Array.from(new Set([0.8, 0.95, 1, 1.1, 1.2, rate])).sort().map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        </div>
      </>}
      {readingVoices.streaming && <button type="button" onClick={() => {
        pause();
        initialPosition.current = Math.min(index, articles.length - 1);
        restorePosition.current = false;
        setUseStream((current) => !current);
      }}>{useStream ? "Prepare recording instead" : "Stream audio instead"}</button>}
      {/Android/i.test(navigator.userAgent) && <details className="screen-off-audio-help">
        <summary>Audio stops after pressing Home?</summary>
        <p>On Samsung phones, check Settings → Battery → Background usage limits. Remove Signal from Sleeping apps or Deep sleeping apps, and add it to Never sleeping apps. If Signal isn’t listed, check the browser you used to install it.</p>
        <a href="https://developer.samsung.com/mobile/app-management.html" target="_blank" rel="noreferrer">Samsung’s background app guidance &#8599;</a>
      </details>}
      <button type="button" onClick={onExit}>Use browser voice</button>
    </div>
  </>;
}
