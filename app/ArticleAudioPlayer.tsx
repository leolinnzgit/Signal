"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { recordedArticleNarrationSections, audioHeadlineIndex, preferBrowserArticleAudio, preparedAudioCache, prepareArticleAudio, type ArticleNarrationSection, type PreparedHeadlineAudio, type ReadingVoicePreferences } from "./headline-audio";
import ReadingVoiceSelector, { useReadingVoices } from "./ReadingVoiceSelector";
import BrowserArticleAudioPlayer from "./BrowserArticleAudioPlayer";

export type ArticleAudioPlayerProps = { title: string; source: string; paragraphs: string[]; autoPrepare?: boolean; summaryOnly?: boolean; onReadingSectionChange?: (section: ArticleNarrationSection | null, playing: boolean) => void };

export default function ArticleAudioPlayer(props: ArticleAudioPlayerProps) {
  const [speechSupported] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
  const [mode, setMode] = useState(() => preferBrowserArticleAudio(typeof navigator === "undefined" ? "" : navigator.userAgent, speechSupported) ? "browser" : "recorded");
  useEffect(() => () => props.onReadingSectionChange?.(null, false), [props.onReadingSectionChange]);
  function changeMode(nextMode: string) {
    if (nextMode === mode) return;
    props.onReadingSectionChange?.(null, false);
    setMode(nextMode);
  }
  return <div className="article-narration">
    <div className="article-audio-mode" role="group" aria-label="Article audio mode">
      <button type="button" aria-pressed={mode === "browser"} disabled={!speechSupported} onClick={() => changeMode("browser")}>Browser voice</button>
      <button type="button" aria-pressed={mode === "recorded"} onClick={() => changeMode("recorded")}>Recorded audio</button>
    </div>
    {mode === "browser" ? <BrowserArticleAudioPlayer {...props} onRecordedAudio={() => changeMode("recorded")} /> : <RecordedArticleAudioPlayer {...props} />}
  </div>;
}

function RecordedArticleAudioPlayer({ title, source, paragraphs, autoPrepare = false, summaryOnly = false, onReadingSectionChange }: ArticleAudioPlayerProps) {
  const readingVoices = useReadingVoices();
  const narrationTitle = summaryOnly && paragraphs.length === 1 && paragraphs[0] === title ? "" : title;
  const sections = useMemo(() => { try { return recordedArticleNarrationSections(narrationTitle, paragraphs); } catch { return []; } }, [narrationTitle, paragraphs, readingVoices.loading]);
  const parts = useMemo(() => sections.length ? sections.map((section) => section.text) : null, [sections]);
  const [attempt, setAttempt] = useState(() => autoPrepare || (parts && preparedAudioCache.get(parts, 3, navigator.language, readingVoices.preferences)) ? 1 : 0);
  const [url, setUrl] = useState("");
  const [starts, setStarts] = useState<number[]>([]);
  const [preparing, setPreparing] = useState(autoPrepare);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rate, setRate] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [readingSection, setReadingSection] = useState<ArticleNarrationSection | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const resumePart = useRef(0);
  const resumePlayback = useRef(autoPrepare);
  const resumeTime = useRef<number | null>(null);
  const restorePosition = useRef(true);
  const recordingKey = useRef("");

  useEffect(() => {
    if (!attempt || readingVoices.loading) return;
    const abort = new AbortController();
    preparation.current = abort;
    let recordingUrl = "";
    recordingKey.current = preparedAudioCache.key(parts ?? [], 3, navigator.language, readingVoices.preferences);
    const ready = parts ? preparedAudioCache.get(parts, 3, navigator.language, readingVoices.preferences) : undefined;
    setUrl("");
    setPlaying(false);
    setReadingSection(null);
    setError("");
    setMessage("");
    setProgress(0);
    setPreparing(!ready);
    const useRecording = (recording: PreparedHeadlineAudio) => {
        if (abort.signal.aborted) return;
        resumeTime.current = restorePosition.current ? preparedAudioCache.position(recordingKey.current) ?? null : null;
        restorePosition.current = true;
        recordingUrl = URL.createObjectURL(recording.blob);
        setUrl(recordingUrl);
        setStarts(recording.starts);
        setPreparing(false);
        setMessage(ready ? "Audio ready. Tap Play to resume reading." : "Ready. Tap Play if the audio does not start automatically.");
    };
    if (ready) useRecording(ready);
    else void Promise.resolve().then(() => prepareArticleAudio(narrationTitle, paragraphs, navigator.language, abort.signal, undefined,
      (done, total) => { if (!abort.signal.aborted) setProgress(Math.round(done / total * 100)); }, readingVoices.preferences))
      .then(useRecording)
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setPreparing(false);
        setError(reason instanceof Error ? reason.message : "The full article audio could not be prepared.");
      });
    return () => { abort.abort(); if (recordingUrl) URL.revokeObjectURL(recordingUrl); };
  }, [attempt, narrationTitle, paragraphs, parts, readingVoices.loading, readingVoices.preferences.en, readingVoices.preferences.zh]);

  useEffect(() => {
    if (!url || !audio.current) return;
    const element = audio.current;
    const key = recordingKey.current;
    // The user requested narration. Phones that require a fresh gesture still
    // have the native Play control after asynchronous preparation.
    if (resumePlayback.current) void element.play().catch(() => setMessage("Ready. Tap Play to read the full news aloud."));
    return () => { preparedAudioCache.savePosition(key, element.ended ? 0 : element.currentTime); element.pause(); };
  }, [url]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate, url]);

  useEffect(() => {
    if (!url || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if ("MediaMetadata" in window) session.metadata = new MediaMetadata({ title, artist: source, album: "Full news", artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }] });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { void audio.current?.play().catch(() => setMessage("Tap Play to resume reading.")); }],
      ["pause", () => audio.current?.pause()],
      ["stop", () => { if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; } setReadingSection(null); }],
      ["seekto", (details) => { if (audio.current && Number.isFinite(details.seekTime) && Number.isFinite(audio.current.duration)) audio.current.currentTime = Math.max(0, Math.min(audio.current.duration, details.seekTime!)); }],
    ];
    for (const [action, handler] of handlers) { try { session.setActionHandler(action, handler); } catch { /* Optional media controls. */ } }
    return () => {
      for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Optional media controls. */ } }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [url, title, source]);

  useEffect(() => {
    onReadingSectionChange?.(readingSection, playing);
  }, [readingSection, playing, onReadingSectionChange]);

  function updatePlayback(playing: boolean) {
    setPlaying(playing);
    setMessage(playing ? "Reading full news aloud. You can turn off the screen." : "Reading paused.");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function updatePosition() {
    const element = audio.current;
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
  }

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
    <ReadingVoiceSelector {...readingVoices} selectVoice={selectVoice} active={attempt > 0} playbackActive={playing}
      onPreviewStart={() => { resumePlayback.current = false; audio.current?.pause(); setPlaying(false); }} />
    {!url && !preparing && <button type="button" onClick={() => { resumePlayback.current = true; setAttempt((current) => current + 1); }}>{error ? "Try audio again" : summaryOnly ? "Read headline and summary aloud" : "Read full news aloud"}</button>}
    {preparing && <>
      <p role="status">Preparing full article audio… {progress}%</p>
      <p>Keep Signal open until the recording is ready.</p>
      <button type="button" onClick={cancelPreparation}>Cancel audio preparation</button>
    </>}
    {url && <>
      <audio ref={audio} src={url} controls preload="auto" aria-label={`Read ${title} aloud`}
        onLoadedMetadata={() => { if (audio.current) audio.current.currentTime = Math.min(resumeTime.current ?? starts[resumePart.current] ?? 0, audio.current.duration); }}
        onPlay={() => { updatePlayback(true); updatePosition(); }} onPause={() => updatePlayback(false)}
        onTimeUpdate={updatePosition} onSeeking={updatePosition}
        onEnded={() => { updatePlayback(false); setReadingSection(null); setMessage("Finished reading this article."); }}
        onError={() => { setError("The recording could not be played. Try preparing the audio again."); setPlaying(false); setReadingSection(null); setUrl(""); }} />
      <label>Speaking speed <select value={rate} onChange={(event) => setRate(Number(event.target.value))}>{[0.8, 1, 1.1, 1.2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
      <p role="status">{message}</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
