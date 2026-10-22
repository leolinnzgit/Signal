import { useCallback, useEffect, useRef, useState } from "react";
import { openArticleAudioStream } from "./article-audio-stream";
import { articleNarrationParts, normalizeReadingVoices, READING_VOICES_STORAGE_KEY } from "./headline-audio";

export function useEarthquakeAudio() {
  const [audioStatus, setAudioStatus] = useState("");
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const pendingText = useRef("");
  const blocked = useRef(false);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (startTimer.current) clearTimeout(startTimer.current);
    startTimer.current = null;
  }, []);

  const release = useCallback(() => {
    sequence.current++;
    clearTimer();
    request.current?.abort();
    request.current = null;
    if (audio.current) {
      audio.current.onplaying = audio.current.onended = audio.current.onerror = null;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = null;
    }
    pendingText.current = "";
    blocked.current = false;
  }, [clearTimer]);

  const stop = useCallback(() => { release(); setAudioStatus(""); }, [release]);

  const speak = useCallback((text: string) => {
    const fail = (run: number) => {
      if (run !== sequence.current) return;
      release();
      setAudioStatus("Azure voice is unavailable. Tap Read alert or Test voice to retry. The earthquake alert remains on screen.");
    };
    const startDeadline = (run: number) => {
      clearTimer();
      startTimer.current = setTimeout(() => fail(run), 30_000);
    };
    const play = (element: HTMLAudioElement, run: number) => {
      blocked.current = false;
      setAudioStatus("Starting Azure voice…");
      startDeadline(run);
      void element.play().catch((reason: unknown) => {
        if (run !== sequence.current) return;
        if (reason instanceof DOMException && reason.name === "NotAllowedError") {
          clearTimer();
          blocked.current = true;
          setAudioStatus("Tap Read alert or Test voice to allow Azure audio playback.");
        } else fail(run);
      });
    };
    // Reuse the prepared media and call play synchronously on the next user tap.
    if (blocked.current && pendingText.current === text && audio.current?.src) {
      play(audio.current, sequence.current);
      return;
    }
    stop();
    if (typeof window.Audio !== "function") {
      setAudioStatus("Azure audio playback is unavailable in this browser. Earthquake alerts still appear on screen.");
      return;
    }
    const run = sequence.current;
    const abort = new AbortController();
    request.current = abort;
    const element = new Audio();
    audio.current = element;
    pendingText.current = text;
    element.onplaying = () => {
      if (run !== sequence.current) return;
      clearTimer();
      setAudioStatus("Reading earthquake alert with Azure voice…");
    };
    element.onended = () => { if (run === sequence.current) stop(); };
    element.onerror = () => fail(run);
    let voices = normalizeReadingVoices(null);
    try { voices = normalizeReadingVoices(JSON.parse(localStorage.getItem(READING_VOICES_STORAGE_KEY) ?? "null")); }
    catch { /* Use the server's configured Azure voice. */ }
    setAudioStatus("Preparing Azure voice…");
    startDeadline(run);
    void openArticleAudioStream(articleNarrationParts("", [text], 900), "en-NZ", voices, abort.signal,
      status => { if (status.error) fail(run); })
      .then(url => {
        if (run !== sequence.current || abort.signal.aborted) return;
        element.src = url;
        play(element, run);
      })
      .catch(() => fail(run));
  }, [stop, release, clearTimer]);

  useEffect(() => release, [release]);
  return { audioStatus, speak, stop };
}
