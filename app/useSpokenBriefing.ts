"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openArticleAudioStream } from "./article-audio-stream";
import {
  articleNarrationParts,
  normalizeReadingVoices,
  READING_VOICES_STORAGE_KEY,
} from "./headline-audio";
import {
  createHeadlinePlayback,
  HEADLINE_SPEECH_PREFERENCES_KEY,
  normalizeHeadlineSpeechPreferences,
} from "./headline-playback";

export type SpokenBriefingStatus = "idle" | "starting" | "playing" | "error";

/**
 * Reusable hook to narrate generated text (such as the Executive Daily Briefing,
 * News Pulse digest, or OCR text) using prewarmed Offline Pack neural audio blobs,
 * Signal's Azure Neural / server audio stream, or automatic browser speech fallback.
 */
export function useSpokenBriefing() {
  const [status, setStatus] = useState<SpokenBriefingStatus>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const sequenceRef = useRef(0);

  const releaseCloud = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.onplaying = null;
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {
        // Ignore revocation errors
      }
      objectUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    sequenceRef.current += 1;
    releaseCloud();
    playbackRef.current?.dispose();
    playbackRef.current = null;
    setStatus("idle");
  }, [releaseCloud]);

  const speak = useCallback(
    (rawText: string, targetLanguage?: string, offlineAudioBlob?: Blob | null) => {
      const clean = (rawText || "").trim();
      if (!clean && !(offlineAudioBlob && offlineAudioBlob.size > 44)) return;

      stop();
      const run = sequenceRef.current;
      setStatus("starting");

      let preferences = normalizeHeadlineSpeechPreferences(null);
      try {
        preferences = normalizeHeadlineSpeechPreferences(
          JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null"),
        );
      } catch {
        // Default speech rate & browser voice
      }

      const language =
        targetLanguage ||
        (typeof navigator !== "undefined" && navigator.language.startsWith("en")
          ? navigator.language
          : "en-NZ");

      const fallbackToBrowserSpeech = () => {
        if (run !== sequenceRef.current) return;
        releaseCloud();

        if (
          !clean ||
          typeof window === "undefined" ||
          !window.speechSynthesis ||
          typeof window.SpeechSynthesisUtterance !== "function"
        ) {
          setStatus("error");
          return;
        }

        const parts = articleNarrationParts("", [clean], 240);
        const speakPart = (index: number) => {
          if (run !== sequenceRef.current) return;
          if (index >= parts.length) {
            playbackRef.current = null;
            setStatus("idle");
            return;
          }

          const current = createHeadlinePlayback(
            {
              title: parts[index],
              seconds: 0,
              readAloud: true,
              rate: preferences.rate,
              preferredVoiceId: preferences.voices.en,
              onSpeechStart: () => {
                if (run === sequenceRef.current) setStatus("playing");
              },
              onAdvance: () => {
                current.dispose();
                speakPart(index + 1);
              },
              onSpeechError: () => {
                if (run !== sequenceRef.current) return;
                current.dispose();
                playbackRef.current = null;
                setStatus("error");
              },
            },
            {
              speech: window.speechSynthesis,
              createUtterance: (val) => new SpeechSynthesisUtterance(val),
              language,
              preferDeviceVoice: true,
              now: () => performance.now(),
              schedule: (cb, ms) => window.setTimeout(cb, ms),
              clear: (timer) => window.clearTimeout(timer),
            },
          );
          playbackRef.current = current;
          current.setPaused(false);
        };

        speakPart(0);
      };

      if (typeof window === "undefined" || typeof window.Audio !== "function") {
        fallbackToBrowserSpeech();
        return;
      }

      const abort = new AbortController();
      abortRef.current = abort;
      const element = new Audio();
      audioRef.current = element;
      element.playbackRate = preferences.rate;

      let started = false;
      element.onplaying = () => {
        if (run === sequenceRef.current) {
          started = true;
          setStatus("playing");
        }
      };
      element.onended = () => {
        if (run === sequenceRef.current) {
          releaseCloud();
          setStatus("idle");
        }
      };

      const startOnlineStream = () => {
        if (run !== sequenceRef.current || abort.signal.aborted) return;
        if (!clean || (typeof navigator !== "undefined" && navigator.onLine === false)) {
          fallbackToBrowserSpeech();
          return;
        }

        const onCloudFailed = () => {
          if (run !== sequenceRef.current || abort.signal.aborted) return;
          if (!started) fallbackToBrowserSpeech();
          else {
            releaseCloud();
            setStatus("error");
          }
        };
        element.onerror = onCloudFailed;

        let voices = normalizeReadingVoices(null);
        try {
          voices = normalizeReadingVoices(
            JSON.parse(localStorage.getItem(READING_VOICES_STORAGE_KEY) ?? "null"),
          );
        } catch {
          // Use server default neural voice
        }

        void openArticleAudioStream(
          articleNarrationParts("", [clean], 900),
          language,
          voices,
          abort.signal,
          (streamStatus) => {
            if (streamStatus.error) onCloudFailed();
          },
        )
          .then((url) => {
            if (run !== sequenceRef.current || abort.signal.aborted) return;
            element.src = url;
            void element.play().catch(onCloudFailed);
          })
          .catch(onCloudFailed);
      };

      // Fast-path: play prewarmed Offline Briefing Pack neural audio Blob immediately
      if (offlineAudioBlob && offlineAudioBlob.size > 44 && typeof URL.createObjectURL === "function") {
        try {
          const blobUrl = URL.createObjectURL(offlineAudioBlob);
          objectUrlRef.current = blobUrl;
          const onBlobFailed = () => {
            if (run !== sequenceRef.current || abort.signal.aborted) return;
            if (objectUrlRef.current) {
              try {
                URL.revokeObjectURL(objectUrlRef.current);
              } catch {
                // Ignore
              }
              objectUrlRef.current = null;
            }
            if (!started) startOnlineStream();
            else {
              releaseCloud();
              setStatus("error");
            }
          };
          element.onerror = onBlobFailed;
          element.src = blobUrl;
          void element.play().catch(onBlobFailed);
          return;
        } catch {
          // Fall through to online stream or browser speech
        }
      }

      startOnlineStream();
    },
    [releaseCloud, stop],
  );

  useEffect(() => {
    return () => {
      sequenceRef.current += 1;
      releaseCloud();
      playbackRef.current?.dispose();
      playbackRef.current = null;
    };
  }, [releaseCloud]);

  return {
    status,
    isActive: status === "starting" || status === "playing",
    speak,
    stop,
  };
}
