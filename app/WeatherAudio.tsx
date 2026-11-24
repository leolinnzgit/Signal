"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { articleNarrationParts, normalizeReadingVoices, resolveUserReadingVoice, READING_VOICES_STORAGE_KEY } from "./headline-audio";
import { openArticleAudioStream } from "./article-audio-stream";
import { canStartListening, createListeningAudio, listeningSpeech } from "./listening-break";
import { browserSpeechRequiresTap, createHeadlinePlayback, HEADLINE_SPEECH_PREFERENCES_KEY, normalizeHeadlineSpeechPreferences } from "./headline-playback";
import { shouldAutoReadWeather } from "./weather-briefing";

const storageKey = "signal.weather-audio-on-open.v1";
export const WEATHER_AUDIO_REPORTED_CONDITION_STORAGE_KEY = "signal.weather-audio-reported-condition.v1";
type Status = "idle" | "starting" | "playing" | "paused" | "finished" | "blocked" | "unavailable";

function readReportedCondition(): string {
  try {
    return localStorage.getItem(WEATHER_AUDIO_REPORTED_CONDITION_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeReportedCondition(key: string): void {
  if (!key) return;
  try {
    localStorage.setItem(WEATHER_AUDIO_REPORTED_CONDITION_STORAGE_KEY, key);
  } catch {
    /* Persistence is optional; the in-memory ref still deduplicates this session. */
  }
}

export function useWeatherAudio(text: string, suspended = false, conditionKey?: string) {
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
  const pausedRef = useRef(false);
  const lastReportedCondition = useRef("");
  const sequence = useRef(0);
  const latest = useRef({ text, suspended, enabled, conditionKey });
  latest.current = { text, suspended, enabled, conditionKey };

  const getLastReportedCondition = useCallback(
    () => readReportedCondition() || lastReportedCondition.current,
    [],
  );

  const markConditionReported = useCallback((key: string) => {
    if (!key) return;
    lastReportedCondition.current = key;
    writeReportedCondition(key);
  }, []);

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
    pausedRef.current = false;
    releaseCloud();
    playback.current?.dispose();
    playback.current = null;
  }, [releaseCloud]);

  const stop = useCallback(() => {
    openingPending.current = gesturePending.current = pausedRef.current = false;
    release();
    setStatus("idle");
  }, [release]);

  const togglePause = useCallback(() => {
    const element = audio.current;
    if (element) {
      if (!element.paused) {
        element.pause();
        pausedRef.current = true;
        setStatus("paused");
      } else {
        pausedRef.current = false;
        setStatus("starting");
        void element.play().then(() => setStatus("playing")).catch((reason: unknown) => {
          gesturePending.current = reason instanceof DOMException && reason.name === "NotAllowedError";
          if (!gesturePending.current) release();
          setStatus(gesturePending.current ? "blocked" : "unavailable");
        });
      }
      return;
    }
    if (playback.current) {
      const nextPaused = !pausedRef.current;
      pausedRef.current = nextPaused;
      playback.current.setPaused(nextPaused);
      setStatus(nextPaused ? "paused" : "playing");
    }
  }, [release]);

  const read = useCallback(() => {
    const { text, suspended, conditionKey: readConditionKey = "" } = latest.current;
    if (!text || suspended) return;
    if (!canStartListening()) {
      openingPending.current = gesturePending.current = false;
      return;
    }
    let reported = false;
    const recordReported = () => {
      if (reported || !readConditionKey) return;
      reported = true;
      markConditionReported(readConditionKey);
    };
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
          onSpeechStart: () => { if (run === sequence.current) { recordReported(); setStatus("playing"); } },
          onAdvance: () => { current.dispose(); speakPart(index + 1); },
          onSpeechError: (reason) => {
            if (run !== sequence.current) return;
            current.dispose();
            playback.current = null;
            gesturePending.current = reason === "not-allowed" || reason === "start-timeout";
            setStatus(gesturePending.current ? "blocked" : "unavailable");
          },
        }, {
          speech: listeningSpeech(stop),
          createUtterance: (value) => new SpeechSynthesisUtterance(value),
          language: navigator.language.startsWith("en") ? navigator.language : "en-NZ",
          preferDeviceVoice: true,
          restartOnResume: /Android/i.test(navigator.userAgent),
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
    const element = createListeningAudio(undefined, stop);
    audio.current = element;
    element.playbackRate = preferences.rate;
    let started = false;
    element.onplaying = () => { if (run === sequence.current) { started = true; recordReported(); setStatus("playing"); } };
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
    const effectiveVoices = {
      en: voices.en || resolveUserReadingVoice(),
      zh: voices.zh || "zh-TW-HsiaoChenNeural",
    };
    const language = navigator.language.startsWith("en") ? navigator.language : "en-NZ";
    void openArticleAudioStream(articleNarrationParts("", [text], 900), language, effectiveVoices, abort.signal,
      (status) => { if (status.error) failed(); })
      .then((url) => {
        if (run !== sequence.current || abort.signal.aborted) return;
        element.src = url;
        play(element, run);
      })
      .catch(failed);
  }, [stop, release, releaseCloud, markConditionReported]);

  useEffect(() => {
    try { setEnabled(localStorage.getItem(storageKey) !== "false"); }
    catch { /* The setting still works without device storage. */ }
    setSupported(typeof window.Audio === "function" || (!!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function"));
    setReady(true);
  }, []);

  useEffect(() => {
    if (suspended || !enabled) stop();
  }, [suspended, enabled, stop]);

  const hasText = Boolean(text);
  const hasConditionKey = conditionKey !== undefined;
  const effectiveKey = hasConditionKey ? conditionKey : (hasText ? "__opening__" : "");

  useEffect(() => {
    if (!ready || !supported) return;
    if (!hasText || !effectiveKey) {
      openingPending.current = false;
      setStatus("idle");
      return;
    }
    setStatus("idle");
    const needsReport = !hasConditionKey
      ? openingPending.current
      : shouldAutoReadWeather(effectiveKey, getLastReportedCondition());
    openingPending.current = needsReport && latest.current.enabled && !latest.current.suspended;
    const canRead = () => latest.current.enabled && !latest.current.suspended
      && !!latest.current.text && document.visibilityState !== "hidden";
    const isStillUnreported = () => !hasConditionKey
      || shouldAutoReadWeather(latest.current.conditionKey ?? "", getLastReportedCondition());
    const onInteraction = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".weather-speech-settings")) return;
      if (event instanceof KeyboardEvent && (event.ctrlKey || event.altKey || event.metaKey || ["Shift", "Control", "Alt", "Meta"].includes(event.key))) return;
      if (!canRead()) return;
      if (gesturePending.current) {
        read();
        return;
      }
      if (openingPending.current) {
        if (!isStillUnreported()) {
          openingPending.current = false;
          return;
        }
        read();
      }
    };
    const tryAutomatic = () => {
      if (!canRead() || !openingPending.current || browserSpeechRequiresTap(navigator.userAgent, navigator.maxTouchPoints)) return;
      if (!isStillUnreported()) {
        openingPending.current = false;
        return;
      }
      read();
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
  }, [ready, supported, hasText, effectiveKey, hasConditionKey, read, release, getLastReportedCondition]);

  function changeEnabled(value: boolean) {
    setEnabled(value);
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* Applies for this opening when storage is unavailable. */ }
    if (!value) stop();
  }

  return { enabled, changeEnabled, read, stop, togglePause, status, available: supported && !!text && !suspended };
}
