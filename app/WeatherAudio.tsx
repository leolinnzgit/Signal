"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { articleNarrationParts } from "./headline-audio";
import { browserSpeechRequiresTap, createHeadlinePlayback, HEADLINE_SPEECH_PREFERENCES_KEY, normalizeHeadlineSpeechPreferences } from "./headline-playback";

const storageKey = "signal.weather-audio-on-open.v1";
type Status = "idle" | "starting" | "playing" | "finished" | "blocked" | "unavailable";

export function useWeatherAudio(text: string, suspended = false) {
  const [enabled, setEnabled] = useState(true);
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const playback = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const openingPending = useRef(true);
  const gesturePending = useRef(false);
  const sequence = useRef(0);
  const latest = useRef({ text, suspended, enabled });
  latest.current = { text, suspended, enabled };

  const stop = useCallback(() => {
    openingPending.current = gesturePending.current = false;
    sequence.current++;
    playback.current?.dispose();
    playback.current = null;
    setStatus("idle");
  }, []);

  const read = useCallback(() => {
    const { text, suspended } = latest.current;
    if (!text || suspended) return;
    stop();
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== "function") {
      setStatus("unavailable");
      return;
    }
    let preferences = normalizeHeadlineSpeechPreferences(null);
    try { preferences = normalizeHeadlineSpeechPreferences(JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null")); }
    catch { /* Use the device's default browser voice. */ }
    const parts = articleNarrationParts("", [text], 240);
    const run = sequence.current;
    setStatus("starting");
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
  }, [stop]);

  useEffect(() => {
    try { setEnabled(localStorage.getItem(storageKey) !== "false"); }
    catch { /* The setting still works without device storage. */ }
    setSupported(!!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === "function");
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
      sequence.current++;
      playback.current?.dispose();
      playback.current = null;
    };
  }, [ready, supported, text, read]);

  function changeEnabled(value: boolean) {
    setEnabled(value);
    try { localStorage.setItem(storageKey, String(value)); }
    catch { /* Applies for this opening when storage is unavailable. */ }
    if (!value) stop();
  }

  return { enabled, changeEnabled, read, stop, status, available: supported && !!text && !suspended };
}
