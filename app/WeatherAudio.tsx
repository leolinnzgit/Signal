"use client";

import { useEffect, useRef, useState } from "react";
import { prepareHeadlineAudio } from "./headline-audio";
import { useReadingVoices } from "./ReadingVoiceSelector";

const storageKey = "signal.weather-audio-on-open.v1";
type Status = "preparing" | "ready" | "playing" | "finished" | "blocked" | "error";

export default function WeatherAudio({ text, suspended = false }: { text: string; suspended?: boolean }) {
  const voices = useReadingVoices();
  const [enabled, setEnabled] = useState(true);
  const [settingsReady, setSettingsReady] = useState(false);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<Status>("preparing");
  const [attempt, setAttempt] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const autoPending = useRef(true);
  const retryPending = useRef(false);
  const playSequence = useRef(0);

  useEffect(() => {
    try { setEnabled(localStorage.getItem(storageKey) !== "false"); }
    catch { /* Audio still works without device storage. */ }
    setSettingsReady(true);
  }, []);

  useEffect(() => {
    if (!settingsReady || !text || voices.loading) return;
    const abort = new AbortController();
    let recordingUrl = "";
    setUrl("");
    setStatus("preparing");
    void prepareHeadlineAudio([text], 3, "en-NZ", abort.signal, undefined, undefined, 15_000, voices.preferences)
      .then((recording) => {
        if (abort.signal.aborted) return;
        recordingUrl = URL.createObjectURL(recording.blob);
        setUrl(recordingUrl);
        setStatus("ready");
      })
      .catch(() => { if (!abort.signal.aborted) setStatus("error"); });
    const element = audio.current;
    return () => {
      abort.abort();
      playSequence.current++;
      element?.pause();
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    };
  }, [text, settingsReady, voices.loading, voices.preferences.en, voices.preferences.zh, attempt]);

  useEffect(() => {
    if (!suspended) return;
    autoPending.current = false;
    retryPending.current = false;
    playSequence.current++;
    audio.current?.pause();
  }, [suspended]);

  useEffect(() => {
    const tryOpeningAudio = () => {
      if (!url || suspended || document.visibilityState === "hidden"
        || !(retryPending.current || (enabled && autoPending.current))) return;
      autoPending.current = false;
      play();
    };
    tryOpeningAudio();
    document.addEventListener("visibilitychange", tryOpeningAudio);
    return () => document.removeEventListener("visibilitychange", tryOpeningAudio);
  }, [url, enabled, suspended]);

  function play() {
    const element = audio.current;
    if (!element || suspended) return;
    autoPending.current = false;
    retryPending.current = false;
    const sequence = ++playSequence.current;
    if (element.ended) element.currentTime = 0;
    void element.play().catch(() => {
      if (sequence === playSequence.current) setStatus("blocked");
    });
  }

  function stop() {
    autoPending.current = false;
    retryPending.current = false;
    playSequence.current++;
    audio.current?.pause();
    if (audio.current) audio.current.currentTime = 0;
    if (url) setStatus("ready");
  }

  function changeEnabled(value: boolean) {
    setEnabled(value);
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* The choice applies for this opening. */ }
    if (!value) stop();
  }

  if (!text) return null;
  const message = status === "preparing" ? "Preparing weather audio…"
    : status === "blocked" ? "Tap Play weather to allow audio."
    : status === "error" ? "Weather audio is unavailable. Try again."
    : status === "playing" ? "Reading current weather and today's forecast."
    : status === "finished" ? "Weather briefing finished." : "Current weather and today's forecast.";
  return <div className="weather-audio" aria-label="Weather audio">
    <audio ref={audio} src={url || undefined} preload="auto"
      onPlay={() => setStatus("playing")}
      onPause={() => setStatus((current) => current === "playing" ? "ready" : current)}
      onEnded={() => setStatus("finished")}
      onError={() => { if (url) setStatus("error"); }} />
    <div className="weather-audio-controls">
      <button type="button" disabled={suspended || status === "preparing"}
        onClick={() => {
          if (status === "error") { retryPending.current = true; setAttempt((value) => value + 1); }
          else play();
        }}>{status === "error" ? "Retry weather audio" : "Play weather"}</button>
      <button type="button" onClick={stop}>Stop weather</button>
      <label><input type="checkbox" checked={enabled} onChange={(event) => changeEnabled(event.target.checked)} />Read weather on opening</label>
    </div>
    <p role="status">{message}</p>
  </div>;
}
