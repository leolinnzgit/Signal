"use client";

import { useEffect, useRef, useState } from "react";
import { audioHeadlineIndex, prepareArticleAudio, type ReadingVoicePreferences } from "./headline-audio";
import ReadingVoiceSelector, { useReadingVoices } from "./ReadingVoiceSelector";

type Props = { title: string; source: string; paragraphs: string[]; autoPrepare?: boolean };

export default function ArticleAudioPlayer({ title, source, paragraphs, autoPrepare = false }: Props) {
  const [attempt, setAttempt] = useState(autoPrepare ? 1 : 0);
  const [url, setUrl] = useState("");
  const [starts, setStarts] = useState<number[]>([]);
  const [preparing, setPreparing] = useState(autoPrepare);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [rate, setRate] = useState(1);
  const audio = useRef<HTMLAudioElement>(null);
  const preparation = useRef<AbortController | null>(null);
  const resumePart = useRef(0);
  const resumePlayback = useRef(true);
  const readingVoices = useReadingVoices();

  useEffect(() => {
    if (!attempt) return;
    const abort = new AbortController();
    preparation.current = abort;
    let recordingUrl = "";
    setUrl("");
    setError("");
    setMessage("");
    setProgress(0);
    setPreparing(true);
    void prepareArticleAudio(title, paragraphs, navigator.language, abort.signal, undefined,
      (done, total) => { if (!abort.signal.aborted) setProgress(Math.round(done / total * 100)); }, readingVoices.preferences)
      .then((recording) => {
        if (abort.signal.aborted) return;
        recordingUrl = URL.createObjectURL(recording.blob);
        setUrl(recordingUrl);
        setStarts(recording.starts);
        setPreparing(false);
        setMessage("Ready. Tap Play if the audio does not start automatically.");
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setPreparing(false);
        setError(reason instanceof Error ? reason.message : "The full article audio could not be prepared.");
      });
    return () => { abort.abort(); if (recordingUrl) URL.revokeObjectURL(recordingUrl); };
  }, [attempt, title, paragraphs, readingVoices.preferences.en, readingVoices.preferences.zh]);

  useEffect(() => {
    if (!url || !audio.current) return;
    const element = audio.current;
    // The user requested narration. Phones that require a fresh gesture still
    // have the native Play control after asynchronous preparation.
    if (resumePlayback.current) void element.play().catch(() => setMessage("Ready. Tap Play to read the full news aloud."));
    return () => { element.pause(); };
  }, [url]);

  useEffect(() => { if (audio.current) audio.current.playbackRate = rate; }, [rate, url]);

  useEffect(() => {
    if (!url || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if ("MediaMetadata" in window) session.metadata = new MediaMetadata({ title, artist: source, album: "Full news", artwork: [{ src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" }] });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { void audio.current?.play().catch(() => setMessage("Tap Play to resume reading.")); }],
      ["pause", () => audio.current?.pause()],
      ["stop", () => { if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; } }],
      ["seekto", (details) => { if (audio.current && Number.isFinite(details.seekTime) && Number.isFinite(audio.current.duration)) audio.current.currentTime = Math.max(0, Math.min(audio.current.duration, details.seekTime!)); }],
    ];
    for (const [action, handler] of handlers) { try { session.setActionHandler(action, handler); } catch { /* Optional media controls. */ } }
    return () => {
      for (const [action] of handlers) { try { session.setActionHandler(action, null); } catch { /* Optional media controls. */ } }
      session.metadata = null;
      session.playbackState = "none";
    };
  }, [url, title, source]);

  function updatePlayback(playing: boolean) {
    setMessage(playing ? "Reading full news aloud. You can turn off the screen." : "Reading paused.");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  function updatePosition() {
    const element = audio.current;
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
    readingVoices.selectVoice(language, id);
  }

  return <section className="article-audio-player" aria-label="Full article narration">
    <ReadingVoiceSelector {...readingVoices} selectVoice={selectVoice} active={attempt > 0} />
    {!url && !preparing && <button type="button" onClick={() => { resumePlayback.current = true; setAttempt((current) => current + 1); }}>{error ? "Try audio again" : "Read full news aloud"}</button>}
    {preparing && <>
      <p role="status">Preparing full article audio… {progress}%</p>
      <p>Keep Signal open until the recording is ready.</p>
      <button type="button" onClick={cancelPreparation}>Cancel audio preparation</button>
    </>}
    {url && <>
      <audio ref={audio} src={url} controls preload="auto" aria-label={`Read ${title} aloud`}
        onLoadedMetadata={() => { if (audio.current) audio.current.currentTime = starts[resumePart.current] ?? 0; }}
        onPlay={() => updatePlayback(true)} onPause={() => updatePlayback(false)}
        onTimeUpdate={updatePosition} onSeeking={updatePosition}
        onEnded={() => setMessage("Finished reading this article.")}
        onError={() => { setError("The recording could not be played. Try preparing the audio again."); setUrl(""); }} />
      <label>Speaking speed <select value={rate} onChange={(event) => setRate(Number(event.target.value))}>{[0.8, 1, 1.1, 1.2].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
      <p role="status">{message}</p>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
