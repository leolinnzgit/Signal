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

export interface SpeakChaptersOptions {
  startIndex?: number;
  targetLanguage?: string;
  offlineAudioBlob?: Blob | null;
  onComplete?: () => void;
}

/**
 * Reusable hook to narrate generated text or chaptered briefings (such as the
 * Executive Daily Briefing, News Pulse digest, or OCR text) using prewarmed Offline Pack
 * neural audio blobs, Signal's Azure Neural / server audio stream, or automatic browser speech fallback.
 */
export function useSpokenBriefing() {
  const [status, setStatus] = useState<SpokenBriefingStatus>("idle");
  const [activeChapterIndex, setActiveChapterIndex] = useState<number | null>(null);
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
      audioRef.current.ontimeupdate = null;
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
    setActiveChapterIndex(null);
    setStatus("idle");
  }, [releaseCloud]);

  const speakChapters = useCallback(
    (
      chaptersInput: ReadonlyArray<{ text: string }>,
      options: SpeakChaptersOptions = {},
    ) => {
      const validChapters = chaptersInput
        .map((ch) => ({ text: (ch?.text || "").trim() }))
        .filter((ch) => ch.text.length > 0);

      const offlineAudioBlob = options.offlineAudioBlob;
      if (validChapters.length === 0 && !(offlineAudioBlob && offlineAudioBlob.size > 44)) {
        return;
      }

      const startIndex = Math.max(
        0,
        Math.min(Math.max(0, validChapters.length - 1), options.startIndex ?? 0),
      );
      const remainingChapters = validChapters.slice(startIndex);
      const clean = remainingChapters.map((ch) => ch.text).join(" ").trim();
      const canUseOfflineFullBlob =
        startIndex === 0 && Boolean(offlineAudioBlob && offlineAudioBlob.size > 44);

      if (!clean && !canUseOfflineFullBlob) return;

      stop();
      const run = sequenceRef.current;
      setStatus("starting");
      setActiveChapterIndex(validChapters.length > 0 ? startIndex : null);

      let preferences = normalizeHeadlineSpeechPreferences(null);
      try {
        preferences = normalizeHeadlineSpeechPreferences(
          JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null"),
        );
      } catch {
        // Default speech rate & browser voice
      }

      const language =
        options.targetLanguage ||
        (typeof navigator !== "undefined" && navigator.language.startsWith("en")
          ? navigator.language
          : "en-NZ");

      // Build cumulative character fractions across remainingChapters so cloud/blob audio
      // updates activeChapterIndex smoothly as playback progresses.
      const totalChars = Math.max(
        1,
        remainingChapters.reduce((sum, ch) => sum + ch.text.length, 0),
      );
      const cumulativeEndRatios: number[] = [];
      let runningChars = 0;
      for (const ch of remainingChapters) {
        runningChars += ch.text.length;
        cumulativeEndRatios.push(runningChars / totalChars);
      }

      const updateChapterFromProgress = (currentTimeSec: number, durationSec: number) => {
        if (run !== sequenceRef.current || remainingChapters.length <= 1) return;
        const estimatedTotalSec =
          Number.isFinite(durationSec) && durationSec > 0.5
            ? durationSec
            : Math.max(2, totalChars / (14.5 * Math.max(0.5, preferences.rate)));
        const ratio = Math.max(0, Math.min(0.9999, currentTimeSec / estimatedTotalSec));
        let relIdx = remainingChapters.length - 1;
        for (let i = 0; i < cumulativeEndRatios.length; i++) {
          if (ratio <= cumulativeEndRatios[i]) {
            relIdx = i;
            break;
          }
        }
        setActiveChapterIndex(startIndex + relIdx);
      };

      const fallbackToBrowserSpeech = () => {
        if (run !== sequenceRef.current) return;
        releaseCloud();

        if (
          remainingChapters.length === 0 ||
          typeof window === "undefined" ||
          !window.speechSynthesis ||
          typeof window.SpeechSynthesisUtterance !== "function"
        ) {
          setActiveChapterIndex(null);
          setStatus("error");
          return;
        }

        const speakChapterAt = (relChapterIdx: number) => {
          if (run !== sequenceRef.current) return;
          if (relChapterIdx >= remainingChapters.length) {
            playbackRef.current = null;
            setActiveChapterIndex(null);
            setStatus("idle");
            options.onComplete?.();
            return;
          }

          setActiveChapterIndex(startIndex + relChapterIdx);
          const parts = articleNarrationParts(
            "",
            [remainingChapters[relChapterIdx].text],
            240,
          );

          const speakPart = (partIdx: number) => {
            if (run !== sequenceRef.current) return;
            if (partIdx >= parts.length) {
              speakChapterAt(relChapterIdx + 1);
              return;
            }

            const current = createHeadlinePlayback(
              {
                title: parts[partIdx],
                seconds: 0,
                readAloud: true,
                rate: preferences.rate,
                preferredVoiceId: preferences.voices.en,
                onSpeechStart: () => {
                  if (run === sequenceRef.current) setStatus("playing");
                },
                onAdvance: () => {
                  current.dispose();
                  speakPart(partIdx + 1);
                },
                onSpeechError: () => {
                  if (run !== sequenceRef.current) return;
                  current.dispose();
                  playbackRef.current = null;
                  setActiveChapterIndex(null);
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

        speakChapterAt(0);
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
      element.ontimeupdate = () => {
        updateChapterFromProgress(element.currentTime, element.duration);
      };
      element.onended = () => {
        if (run === sequenceRef.current) {
          releaseCloud();
          setActiveChapterIndex(null);
          setStatus("idle");
          options.onComplete?.();
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
            setActiveChapterIndex(null);
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

      // Fast-path: play prewarmed Offline Briefing Pack neural audio Blob immediately when starting from Chapter 0
      if (canUseOfflineFullBlob && offlineAudioBlob && typeof URL.createObjectURL === "function") {
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
              setActiveChapterIndex(null);
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

  const speak = useCallback(
    (
      rawText: string,
      targetLanguage?: string,
      offlineAudioBlob?: Blob | null,
      onComplete?: () => void,
    ) => {
      speakChapters([{ text: rawText }], {
        startIndex: 0,
        targetLanguage,
        offlineAudioBlob,
        onComplete,
      });
    },
    [speakChapters],
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return {
    status,
    isActive: status === "starting" || status === "playing",
    isSpeaking: status === "starting" || status === "playing",
    activeChapterIndex,
    speak,
    speakChapters,
    stop,
  };
}
