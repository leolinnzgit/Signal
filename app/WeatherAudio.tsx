"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { articleNarrationParts, normalizeReadingVoices, READING_VOICES_STORAGE_KEY } from "./headline-audio";
import { openArticleAudioStream } from "./article-audio-stream";
import { browserSpeechRequiresTap, createHeadlinePlayback, HEADLINE_SPEECH_PREFERENCES_KEY, normalizeHeadlineSpeechPreferences } from "./headline-playback";

const storageKey = "signal.weather-audio-on-open.v1";
type Status = "idle" | "starting" | "playing" | "finished" | "blocked" | "unavailable";

export function useWeatherAudio(text: string, suspended = false) {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const playback = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const browserFallback = useRef(false);
  const openingPending = useRef(true);
  const gesturePending = useRef(false);
  const sequence = useRef(0);
  const latest = useRef({ text, suspended, enabled });
  latest.current = { text, suspended, enabled };

  const releaseCloud = useCallback(() => {
    request.current?.abort();
    request.current = null;
    if (audio.current) {
      audio.current.onplaying = audio.current.onended = audio.current.onerror = null;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = null;
    }
  }, []);

  const release = useCallback(() => {
    sequence.current++;
    gesturePending.current = false;
    releaseCloud();
    playback.current?.dispose();
    playback.current = null;
  }, [releaseCloud]);

  const stop = useCallback(() => {
    openingPending.current = gesturePending.current = false;
    release();
    setStatus("idle");
  }, [release]);

  const read = useCallback(() => {
    const { text, suspended } = latest.current;
    if (!text || suspended) return;
    const play = (element: HTMLAudioElement, run: number) => {
      gesturePending.current = false;
      setStatus("starting");
      void element.play().catch((reason: unknown) => {
        if (run !== sequence.current) return;
        gesturePending.current = reason instanceof DOMException && reason.name === "NotAllowedError";
        if (!gesturePending.current) release();
        setStatus(gesturePending.current ? "blocked" : "unavailable");
      });
    };
    // Retain the prepared Azure URL when autoplay is blocked. The next tap
    // calls play synchronously and does not request another synthesis.
    if (gesturePending.current && audio.current?.src) {
      play(audio.current, sequence.current);
      return;
    }
    stop();
    let preferences = normalizeHeadlineSpeechPreferences(null);
    try { preferences = normalizeHeadlineSpeechPreferences(JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null")); }
    catch { /* Use the device's default browser voice. */ }
    const run = sequence.current;
    setStatus("starting");
    const readBrowser = () => {
      if (run !== sequence.current) return;
      releaseCloud();
      if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
        setStatus("unavailable");
        return;
      }
      browserFallback.current = true;
      const parts = articleNarrationParts("", [text], 240);
      const speakPart = (index: number) => {
        if (run !== sequence.current) return;
        if (index === parts.length) { playback.current = null; setStatus("finished"); return; }
        const current = createHeadlinePlayback({
          title: parts[index], seconds: 0, readAloud: true,
          rate: preferences.rate, preferredVoiceId: preferences.voices.en,
          onSpeechStart: () => { if (run === sequence.current) setStatus("playing"); },
          onAdvance: () => { current.dispose(); speakPart(index + 1); },
          onSpeechError: (reason) => {
            if (run !== sequence.current) return;
            current.dispose();
            playback.current = null;
            gesturePending.current = reason === "not-allowed" || reason === "start-timeout";
            setStatus(gesturePending.current ? "blocked" : "unavailable");
          },
        }, {
          speech: window.speechSynthesis,
          createUtterance: (value) => new SpeechSynthesisUtterance(value),
          language: navigator.language.startsWith("en") ? navigator.language : "en-NZ",
          preferDeviceVoice: true,
          now: () => performance.now(),
          schedule: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
          clear: (timer) => window.clearTimeout(timer),
        });
        playback.current = current;
        current.setPaused(false);
      };
      speakPart(0);
    };
    if (browserFallback.current || typeof window.Audio !== "function") { readBrowser(); return; }
    const abort = new AbortController();
    request.current = abort;
    const element = new Audio();
    audio.current = element;
    element.playbackRate = preferences.rate;
    let started = false;
    element.onplaying = () => { if (run === sequence.current) { started = true; setStatus("playing"); } };
    element.onended = () => { if (run === sequence.current) { release(); setStatus("finished"); } };
    const failed = () => {
      if (run !== sequence.current || abort.signal.aborted) return;
      if (!started) readBrowser();
      else { release(); setStatus("unavailable"); }
    };
    element.onerror = failed;
    let voices = normalizeReadingVoices(null);
    try { voices = normalizeReadingVoices(JSON.parse(localStorage.getItem(READING_VOICES_STORAGE_KEY) ?? "null")); }
    catch { /* Use the server's configured Azure voice. */ }
    const language = navigator.language.startsWith("en") ? navigator.language : "en-NZ";
    void openArticleAudioStream(articleNarrationParts("", [text], 900), language, voices, abort.signal,
      (status) => { if (status.error) failed(); })
      .then((url) => {
        if (run !== sequence.current || abort.signal.aborted) return;
        element.src = url;
        play(element, run);
      })
      .catch(failed);
  }, [stop, release, releaseCloud]);

  useEffect(() => {
    try { setEnabled(localStorage.getItem(storageKey) !== "false"); }
    catch { /* The setting still works without device storage. */ }
    setSupported(typeof window.Audio === "function" || (!!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function"));
    setReady(true);
  }, []);

  useEffect(() => {
    if (suspended || !enabled) stop();
  }, [suspended, enabled, stop]);

  useEffect(() => {
    if (!ready || !supported || !text) return;
    setStatus("idle");
    const canRead = () => latest.current.enabled && !latest.current.suspended
      && !!latest.current.text && document.visibilityState !== "hidden";
    const onInteraction = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".weather-speech-settings")) return;
      if (event instanceof KeyboardEvent && (event.ctrlKey || event.altKey || event.metaKey || ["Shift", "Control", "Alt", "Meta"].includes(event.key))) return;
      if (canRead() && (openingPending.current || gesturePending.current)) read();
    };
    const tryAutomatic = () => {
      if (canRead() && openingPending.current && !browserSpeechRequiresTap(navigator.userAgent, navigator.maxTouchPoints)) read();
    };
    // Defer one task so StrictMode's setup/cleanup cannot cancel the only opening reading.
    const timer = window.setTimeout(tryAutomatic, 0);
    document.addEventListener("pointerdown", onInteraction, true);
    document.addEventListener("keydown", onInteraction, true);
    document.addEventListener("visibilitychange", tryAutomatic);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onInteraction, true);
      document.removeEventListener("keydown", onInteraction, true);
      document.removeEventListener("visibilitychange", tryAutomatic);
      release();
    };
  }, [ready, supported, text, read, release]);

  function changeEnabled(value: boolean) {
    setEnabled(value);
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* Applies for this opening when storage is unavailable. */ }
    if (!value) stop();
  }

  return { enabled, changeEnabled, read, stop, status, available: supported && !!text && !suspended };
}
