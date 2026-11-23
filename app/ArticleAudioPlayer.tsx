"use client";
import { useHandGestureTarget } from "./hand-gesture-actions";

import { useEffect, useMemo, useRef, useState } from "react";
import { recordedArticleNarrationSections, prepareHeadlineAudio, audioHeadlineIndex, preparedAudioCache, prepareArticleAudio, type ArticleNarrationSection, type PreparedHeadlineAudio, type ReadingVoicePreferences } from "./headline-audio";
import ReadingVoiceSelector, { useReadingVoices } from "./ReadingVoiceSelector";
import BrowserArticleAudioPlayer from "./BrowserArticleAudioPlayer";
import { openArticleAudioStream } from "./article-audio-stream";
import ContinueOnWatch, { type QueueTransferSource } from "./ContinueOnWatch";
import { useSharedListeningReporter } from "./SharedListening";

export type ArticleAudioPlaybackState = {
  active: boolean;
  playing: boolean;
  preparing: boolean;
  disabled?: boolean;
  label: string;
  timeLabel?: string;
  progress?: number;
  canSeek?: boolean;
  onSeek?: (ratio: number) => void;
  toggle: () => void;
};

function formatAudioClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export type ArticleAudioPlayerProps = { downloadedAudio?: PreparedHeadlineAudio; queueTransfer?: QueueTransferSource; onPlaybackComplete?: () => void; title: string; source: string; paragraphs: string[]; storyUrl?: string; storyImageUrl?: string; progressParts?: string[]; progressOffset?: number; onTransferLockChange?: (locked: boolean) => void; autoPrepare?: boolean; summaryOnly?: boolean; defaultMode?: "browser" | "recorded"; narrationSections?: ArticleNarrationSection[]; restoreCachedPosition?: boolean; onReadingSectionChange?: (section: ArticleNarrationSection | null, playing: boolean) => void; onPlaybackStateChange?: (state: ArticleAudioPlaybackState | null) => void };

export default function ArticleAudioPlayer(props: ArticleAudioPlayerProps) {
  const [speechSupported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
  const [mode, setMode] = useState(() => props.defaultMode ?? "recorded");
  const [transferLocked, setTransferLocked] = useState(false);
  useEffect(() => () => {
    props.onReadingSectionChange?.(null, false);
    props.onPlaybackStateChange?.(null);
  }, [props.onReadingSectionChange, props.onPlaybackStateChange]);
  function changeMode(nextMode: "browser" | "recorded") {
    if (nextMode === mode) return;
    props.onReadingSectionChange?.(null, false);
    props.onPlaybackStateChange?.(null);
    setMode(nextMode);
  }
  function lockChange(locked: boolean) { setTransferLocked(locked); props.onTransferLockChange?.(locked); }
  return <div className="article-narration">
    <div className="article-audio-mode" role="group" aria-label="Article audio mode">
      <span className="article-audio-mode-label" aria-hidden="true">Voice</span>
      <button type="button" aria-pressed={mode === "browser"} disabled={!speechSupported || transferLocked} onClick={() => changeMode("browser")}>Browser voice</button>
      <button type="button" aria-pressed={mode === "recorded"} disabled={transferLocked} onClick={() => changeMode("recorded")}>Recorded audio</button>
    </div>
    {mode === "browser" ? <BrowserArticleAudioPlayer {...props} onTransferLockChange={lockChange} onRecordedAudio={() => changeMode("recorded")} /> : <RecordedArticleAudioPlayer {...props} onTransferLockChange={lockChange} />}
  </div>;
}

function RecordedArticleAudioPlayer({ downloadedAudio, queueTransfer, onPlaybackComplete, title, source, paragraphs, storyUrl, storyImageUrl, progressParts, progressOffset, onTransferLockChange, autoPrepare = false, summaryOnly = false, onReadingSectionChange, onPlaybackStateChange, narrationSections, restoreCachedPosition = true }: ArticleAudioPlayerProps) {
  const readingVoices = useReadingVoices(!downloadedAudio);
  const narrationTitle = summaryOnly && paragraphs.length === 1 && paragraphs[0] === title ? "" : title;
  const sections = useMemo(() => { try { return narrationSections ?? recordedArticleNarrationSections(narrationTitle, paragraphs); } catch { return []; } }, [narrationTitle, paragraphs, readingVoices.loading, narrationSections]);
  const parts = useMemo(() => sections.length ? sections.map((section) => section.text) : null, [sections]);
  const shared = useSharedListeningReporter(summaryOnly || queueTransfer ? undefined : storyUrl, title, source, storyImageUrl, progressParts ?? parts ?? [], progressOffset);
  const [attempt, setAttempt] = useState(() => autoPrepare || (parts && preparedAudioCache.get(parts, 3, navigator.language, readingVoices.preferences)) ? 1 : 0);
  const [url, setUrl] = useState("");
  const [starts, setStarts] = useState<number[]>([]);
  const [preparing, setPreparing] = useState(autoPrepare);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState({ currentSec: 0, durationSec: 0 });
  const [readingSection, setReadingSection] = useState<ArticleNarrationSection | null>(null);
  const [useStream, setUseStream] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamComplete, setStreamComplete] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const resumePart = useRef(0);
  const resumePlayback = useRef(autoPrepare);
  const resumeTime = useRef<number | null>(null);
  const restorePosition = useRef(restoreCachedPosition);
  const recordingKey = useRef("");
  const restoredStreamPosition = useRef(false);
  const transferLock = useRef(false);
  const [transferLocked, setTransferLocked] = useState(false);
  const toggleRef = useRef<() => void>(() => {});
  const seekRef = useRef<(ratio: number) => void>(() => {});

  useHandGestureTarget(30, true, async (action) => {
    if (transferLock.current) return "Finish or cancel the watch transfer first.";
    if (action !== "pause" && action !== "resume" && action !== "toggle-playback") return undefined;
    if (action === "pause" || (action === "toggle-playback" && audio.current && !audio.current.paused)) { resumePlayback.current = false; audio.current?.pause(); return "Article narration paused."; }
    if (!url || !audio.current) return "Tap Read full news aloud to prepare audio first.";
    try { await audio.current.play(); return "Article narration resumed."; }
    catch { return "Your browser requires a tap. Tap Play to resume reading."; }
  });

  useEffect(() => {
    if (!attempt || !downloadedAudio && readingVoices.loading) return;
    const abort = new AbortController();
    preparation.current = abort;
    let recordingUrl = "";
    const ready = downloadedAudio ?? (parts ? preparedAudioCache.get(parts, 3, navigator.language, readingVoices.preferences) : undefined);
    const streamThisArticle = !ready && useStream && readingVoices.streaming && parts;
    recordingKey.current = (streamThisArticle ? "stream:" : "") + preparedAudioCache.key(parts ?? [], 3, navigator.language, readingVoices.preferences);
    setUrl("");
    setPlaying(false);
    setClock({ currentSec: 0, durationSec: 0 });
    setReadingSection(null);
    setError("");
    setMessage("");
    setProgress(0);
    setStarts([]);
    setPreparing(!ready);
    setStreaming(false);
    setStreamComplete(false);
    restoredStreamPosition.current = false;
    const useRecording = (recording: PreparedHeadlineAudio) => {
        if (abort.signal.aborted) return;
        resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
        restorePosition.current = true;
        recordingUrl = URL.createObjectURL(recording.blob);
        setUrl(recordingUrl);
        setStarts(recording.starts);
        setPreparing(false);
        setMessage(downloadedAudio ? "Playing downloaded audio from this device." : ready ? "Audio ready. Tap Play to resume reading." : "Ready. Tap Play if the audio does not start automatically.");
    };
    if (ready) useRecording(ready);
    else if (useStream && readingVoices.streaming && parts) {
      let streamUrl = "";
      let complete = false;
      setStreaming(true);
      resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
      restorePosition.current = true;
      void openArticleAudioStream(parts, navigator.language, readingVoices.preferences, abort.signal, (status) => {
        if (abort.signal.aborted) return;
        setStarts(status.starts);
        setProgress(status.complete ? 100 : Math.min(99, Math.round(status.starts.length / parts.length * 100)));
        setStreamComplete(status.complete);
        complete = status.complete;
        if (status.complete && streamUrl) {
          const element = audio.current;
          resumeTime.current = element?.ended ? 0 : element?.currentTime ?? 0;
          resumePlayback.current = !!element && !element.paused && !element.ended;
          restoredStreamPosition.current = false;
          setUrl(`${streamUrl}?ready=1`);
        }
        if (status.error) {
          audio.current?.pause(); audio.current?.removeAttribute("src"); audio.current?.load();
          setPlaying(false); setUrl(""); setError(status.error);
        }
      }).then((openedUrl) => {
        if (abort.signal.aborted) return;
        streamUrl = openedUrl;
        setUrl(complete ? `${openedUrl}?ready=1` : openedUrl); setPreparing(false);
        setMessage("Tap Play to start listening while the rest is generated.");
      }).catch((reason: unknown) => {
        if (!abort.signal.aborted) { setPreparing(false); setError(reason instanceof Error ? reason.message : "The audio stream could not be opened."); }
      });
    }
    else void Promise.resolve().then(() => {
      const progress = (done: number, total: number) => { if (!abort.signal.aborted) setProgress(Math.round(done / total * 100)); };
      return narrationSections && parts
        ? prepareHeadlineAudio(parts, 3, navigator.language, abort.signal, undefined, progress, 4000, readingVoices.preferences)
        : prepareArticleAudio(narrationTitle, paragraphs, navigator.language, abort.signal, undefined, progress, readingVoices.preferences);
    })
      .then(useRecording)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setPreparing(false);
        setError(reason instanceof Error ? reason.message : "The full article audio could not be prepared.");
      });
    return () => {
      abort.abort();
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      else if (useStream && readingVoices.streaming) { audio.current?.pause(); audio.current?.removeAttribute("src"); audio.current?.load(); }
    };
  }, [downloadedAudio, attempt, narrationTitle, paragraphs, parts, readingVoices.loading, readingVoices.preferences.en, readingVoices.preferences.zh, readingVoices.streaming, useStream]);

  useEffect(() => {
    if (!url || !audio.current) return;
    const element = audio.current;
    const key = recordingKey.current;
    // The user requested narration. Phones that require a fresh gesture still
    // have the native Play control after asynchronous preparation.
    if (resumePlayback.current) void element.play().catch(() => setMessage(summaryOnly ? "Summary ready. Tap Play to listen." : "Ready. Tap Play to read the full news aloud."));
    return () => {
      if (!streaming || element.getAttribute("src")) preparedAudioCache.savePosition(key, element.ended ? 0 : element.currentTime);
      element.pause();
    };
  }, [url]);

  function restoreStreamPosition() {
    const element = audio.current;
    if (!streaming || !element || restoredStreamPosition.current) return;
    const position = resumeTime.current ?? starts[resumePart.current];
    if (position === undefined) return;
    for (let index = 0; index < element.buffered.length; index++) {
      if (position >= element.buffered.start(index) && position <= element.buffered.end(index)) {
        element.currentTime = position;
        restoredStreamPosition.current = true;
        return;
      }
    }
  }

  useEffect(restoreStreamPosition, [starts, streamComplete]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate, url]);

  useEffect(() => {
    if (!url || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if ("MediaMetadata" in window) session.metadata = new MediaMetadata({ title, artist: source, album: summaryOnly ? "Article summary" : "Full news", artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }] });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { if (!transferLock.current) void audio.current?.play().catch(() => setMessage("Tap Play to resume reading.")); }],
      ["pause", () => audio.current?.pause()],
      ["stop", () => { if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; } setReadingSection(null); }],
      ["seekto", (details) => { if (!transferLock.current && audio.current && Number.isFinite(details.seekTime) && Number.isFinite(audio.current.duration)) audio.current.currentTime = Math.max(0, Math.min(audio.current.duration, details.seekTime!)); }],
    ];
    for (const [action, handler] of handlers) { try { session.setActionHandler(action, handler); } catch { /* Optional media controls. */ } }
    return () => {
      for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Optional media controls. */ } }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [url, title, source, summaryOnly]);

  useEffect(() => {
    onReadingSectionChange?.(readingSection, playing);
  }, [readingSection, playing, onReadingSectionChange]);

  function syncClock(element: HTMLAudioElement) {
    const currentSec = element.ended ? 0 : Math.max(0, Math.floor(element.currentTime || 0));
    const durationSec = Number.isFinite(element.duration) && element.duration > 0 ? Math.floor(element.duration) : 0;
    setClock((current) => current.currentSec === currentSec && current.durationSec === durationSec ? current : { currentSec, durationSec });
  }

  function updatePlayback(playing: boolean) {
    if (audio.current && starts.length) shared.track(audioHeadlineIndex(starts, audio.current.currentTime), playing);
    setPlaying(playing);
    setMessage(playing ? summaryOnly ? "Reading the summary aloud. You can turn off the screen." : "Reading full news aloud. You can turn off the screen." : "Reading paused.");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function updatePosition() {
    const element = audio.current;
    if (element) syncClock(element);
    if (element && starts.length) shared.track(audioHeadlineIndex(starts, element.currentTime), !element.paused && !element.ended);
    if (element) preparedAudioCache.savePosition(recordingKey.current, element.ended ? 0 : element.currentTime);
    if (element?.ended) setReadingSection(null);
    else if (element && starts.length && (!element.paused || readingSection)) {
      setReadingSection(sections[audioHeadlineIndex(starts, element.currentTime)] ?? null);
    }
    if (!element || !Number.isFinite(element.duration) || !("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
    try { navigator.mediaSession.setPositionState({ duration: element.duration, position: Math.min(element.currentTime, element.duration), playbackRate: element.playbackRate }); }
    catch { /* Native audio remains usable without position controls. */ }
  }

  function cancelPreparation() {
    preparation.current?.abort();
    setAttempt(0);
    setPreparing(false);
    setMessage("");
    setUrl("");
    setClock({ currentSec: 0, durationSec: 0 });
  }

  toggleRef.current = () => {
    if (transferLock.current || !audio.current) return;
    const element = audio.current;
    if (element.paused || element.ended) {
      if (element.ended) element.currentTime = 0;
      resumePlayback.current = true;
      void element.play()
        .then(() => {
          updatePlayback(true);
          updatePosition();
        })
        .catch(() => setMessage("Tap Play to resume reading."));
    } else {
      resumePlayback.current = false;
      element.pause();
      updatePlayback(false);
    }
  };

  seekRef.current = (ratio: number) => {
    if (transferLock.current || !audio.current) return;
    const element = audio.current;
    if (!Number.isFinite(element.duration) || element.duration <= 0) return;
    element.currentTime = Math.max(0, Math.min(element.duration, ratio * element.duration));
    updatePosition();
  };

  useEffect(() => {
    if (!preparing && !url) {
      onPlaybackStateChange?.(null);
      return;
    }
    const label = preparing && !url
      ? (streaming ? "Opening audio…" : `Preparing audio… ${progress}%`)
      : playing
        ? (summaryOnly ? "Reading summary" : "Reading article")
        : "Paused";
    const timeLabel = clock.durationSec > 0
      ? `${formatAudioClock(clock.currentSec)} / ${formatAudioClock(clock.durationSec)}`
      : clock.currentSec > 0
        ? formatAudioClock(clock.currentSec)
        : preparing ? `${progress}%` : undefined;
    const barProgress = clock.durationSec > 0
      ? Math.max(0, Math.min(1, clock.currentSec / clock.durationSec))
      : preparing ? progress / 100 : 0;
    onPlaybackStateChange?.({
      active: true,
      playing,
      preparing: preparing && !url,
      disabled: transferLocked || (preparing && !url),
      label,
      timeLabel,
      progress: barProgress,
      canSeek: Boolean(url) && !transferLocked && clock.durationSec > 0 && (!streaming || streamComplete),
      onSeek: (ratio) => seekRef.current(ratio),
      toggle: () => toggleRef.current(),
    });
  }, [preparing, url, playing, streaming, streamComplete, progress, transferLocked, summaryOnly, clock.currentSec, clock.durationSec, onPlaybackStateChange]);

  useEffect(() => () => onPlaybackStateChange?.(null), [onPlaybackStateChange]);

  function selectVoice(language: keyof ReadingVoicePreferences, id: string) {
    if (readingVoices.preferences[language] === id) return;
    if (audio.current) {
      resumePart.current = audio.current.ended ? 0 : audioHeadlineIndex(starts, audio.current.currentTime);
      resumePlayback.current = !audio.current.paused;
      audio.current.pause();
    }
    preparation.current?.abort();
    restorePosition.current = false;
    readingVoices.selectVoice(language, id);
  }

  return <section className="article-audio-player" aria-label={summaryOnly ? "Headline and summary narration" : "Full article narration"}>
    {storyUrl && !summaryOnly && <ContinueOnWatch queueTransfer={queueTransfer} partOffset={progressOffset} url={storyUrl} title={title} source={source} imageUrl={storyImageUrl}
      snapshot={() => audio.current && url && starts.length && parts && !audio.current.ended ? { parts, partIndex: audioHeadlineIndex(starts, audio.current.currentTime), session: recordingKey.current } : null}
      pause={() => { resumePlayback.current = false; audio.current?.pause(); setPlaying(false); updatePosition(); }}
      onLockChange={value => { transferLock.current = value; setTransferLocked(value); onTransferLockChange?.(value); }} />}
    <div className="article-audio-player-body" inert={transferLocked}>
    {downloadedAudio ? <p>Downloaded audio · saved recorded voice</p> : <ReadingVoiceSelector {...readingVoices} selectVoice={selectVoice} active={attempt > 0} playbackActive={playing}
      onPreviewStart={() => { resumePlayback.current = false; audio.current?.pause(); setPlaying(false); }} />}
    {!url && !preparing && <button type="button" onClick={() => { resumePlayback.current = true; setAttempt((current) => current + 1); }}>{error ? "Try audio again" : summaryOnly ? "Read headline and summary aloud" : "Read full news aloud"}</button>}
    {preparing && <>
      <p role="status">{streaming ? "Opening audio stream…" : `Preparing ${summaryOnly ? "summary" : "full article"} audio… ${progress}%`}</p>
      <p>{streaming ? "Playback can begin while the rest of the audio is generated." : "Keep Signal open until the recording is ready."}</p>
      <button type="button" className="article-audio-secondary" onClick={cancelPreparation}>Cancel audio preparation</button>
    </>}
    {url && <>
      <audio ref={audio} src={url} controls preload="auto" aria-label={`Read ${title} aloud`}
        onLoadedMetadata={() => {
          const element = audio.current;
          const position = resumeTime.current ?? starts[resumePart.current] ?? 0;
          if (element && (!streaming || streamComplete || position === 0)) element.currentTime = Math.min(position, element.duration);
          if (element) syncClock(element);
        }}
        onCanPlay={restoreStreamPosition} onProgress={restoreStreamPosition}
        onPlay={() => { updatePlayback(true); updatePosition(); }} onPause={() => updatePlayback(false)}
        onTimeUpdate={updatePosition} onSeeking={updatePosition}
        onEnded={() => { shared.complete(); onPlaybackComplete?.(); updatePlayback(false); setReadingSection(null); if (audio.current) syncClock(audio.current); setMessage(summaryOnly ? "Finished reading the summary." : "Finished reading this article."); }}
        onError={() => { setError("The recording could not be played. Try preparing the audio again."); setPlaying(false); setReadingSection(null); setUrl(""); setClock({ currentSec: 0, durationSec: 0 }); }} />
      <div className="article-audio-meta">
        <label>Speaking speed <select value={rate} onChange={(event) => setRate(Number(event.target.value))}>{[0.8, 1, 1.1, 1.2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        <p role="status">{message}</p>
      </div>
      {streaming && !streamComplete && !error && <p role="status">Streaming audio — {progress}% generated. You can keep listening.</p>}
    </>}
    {readingVoices.streaming && attempt > 0 && <button type="button" className="article-audio-secondary" onClick={() => {
      if (audio.current) {
        resumePart.current = audio.current.ended ? 0 : audioHeadlineIndex(starts, audio.current.currentTime);
        resumePlayback.current = !audio.current.paused;
        audio.current.pause();
      } else resumePlayback.current = true;
      restorePosition.current = false;
      setUseStream((current) => !current); setAttempt((current) => current + 1);
    }}>{useStream ? "Prepare recording instead" : "Stream audio instead"}</button>}
    {error && <p role="alert">{error}</p>}
    </div>
  </section>;
}
