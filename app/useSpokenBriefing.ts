"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openArticleAudioStream } from "./article-audio-stream";
import {
  articleNarrationParts,
} from "./headline-audio";
import {
  createHeadlinePlayback,
  HEADLINE_SPEECH_PREFERENCES_KEY,
  normalizeHeadlineSpeechPreferences,
} from "./headline-playback";

export type SpokenBriefingStatus = "idle" | "starting" | "playing" | "paused" | "error";

export interface SpeakChaptersOptions {
  startIndex?: number;
  targetLanguage?: string;
  voiceName?: string;
  offlineAudioBlob?: Blob | null;
  title?: string;
  chapterTitles?: readonly string[];
  onComplete?: () => void;
}

/**
 * Reusable hook to narrate generated text or chaptered briefings (such as the
 * Executive Daily Briefing, News Pulse digest, or OCR text) using prewarmed Offline Pack
 * neural audio blobs, Signal's Azure Neural / server audio stream, or automatic browser speech fallback.
 * Includes complete Media Session API lock-screen / automotive integration and car controls.
 */
export function useSpokenBriefing() {
  const [status, setStatus] = useState<SpokenBriefingStatus>("idle");
  const [activeChapterIndex, setActiveChapterIndex] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const sequenceRef = useRef(0);

  const currentChaptersRef = useRef<ReadonlyArray<{ text: string; label?: string }>>([]);
  const currentOptionsRef = useRef<SpeakChaptersOptions>({});
  const currentChapterIndexRef = useRef<number | null>(null);

  const syncMediaSession = useCallback(
    (newStatus: SpokenBriefingStatus, chapterIdx: number | null) => {
      if (typeof window === "undefined" || typeof navigator === "undefined" || !("mediaSession" in navigator)) {
        return;
      }
      const session = navigator.mediaSession;

      if (newStatus === "idle" || newStatus === "error") {
        session.playbackState = "none";
        return;
      }

      session.playbackState = newStatus === "playing" ? "playing" : "paused";

      const chs = currentChaptersRef.current;
      const idx = chapterIdx ?? 0;
      const currentChapter = chs[idx];
      const customTitle = currentOptionsRef.current.chapterTitles?.[idx] || currentOptionsRef.current.title;
      const chapterTitle =
        customTitle ||
        currentChapter?.label ||
        (currentChapter?.text ? currentChapter.text.slice(0, 50) + "..." : "Executive Daily Briefing");

      if ("MediaMetadata" in window) {
        session.metadata = new MediaMetadata({
          title: chapterTitle,
          artist: "Signal Commute Briefing",
          album: "Executive Daily Briefing",
          artwork: [
            { src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/signal-medallion-192.png", sizes: "192x192", type: "image/png" },
          ],
        });
      }
    },
    [],
  );

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
    currentChapterIndexRef.current = null;
    setActiveChapterIndex(null);
    setStatus("idle");
    syncMediaSession("idle", null);
  }, [releaseCloud, syncMediaSession]);

  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    if (playbackRef.current) {
      playbackRef.current.setPaused(true);
    }
    setStatus("paused");
    syncMediaSession("paused", currentChapterIndexRef.current);
  }, [syncMediaSession]);

  const resume = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.play().catch(() => {});
    }
    if (playbackRef.current) {
      playbackRef.current.setPaused(false);
    }
    setStatus("playing");
    syncMediaSession("playing", currentChapterIndexRef.current);
  }, [syncMediaSession]);

  const toggle = useCallback(() => {
    if (status === "playing") {
      pause();
    } else if (status === "paused") {
      resume();
    }
  }, [status, pause, resume]);

  const seekRelative = useCallback((seconds: number) => {
    if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
      audioRef.current.currentTime = Math.max(
        0,
        Math.min(audioRef.current.duration, audioRef.current.currentTime + seconds),
      );
    }
  }, []);

  const speakChapters = useCallback(
    (
      chaptersInput: ReadonlyArray<{ text: string; label?: string }>,
      options: SpeakChaptersOptions = {},
    ) => {
      const validChapters = chaptersInput
        .map((ch) => ({ text: (ch?.text || "").trim(), label: ch?.label }))
        .filter((ch) => ch.text.length > 0);

      const offlineAudioBlob = options.offlineAudioBlob;
      if (validChapters.length === 0 && !(offlineAudioBlob && offlineAudioBlob.size > 44)) {
        return;
      }

      currentChaptersRef.current = validChapters;
      currentOptionsRef.current = options;

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
      const activeIdx = validChapters.length > 0 ? startIndex : null;
      currentChapterIndexRef.current = activeIdx;
      setActiveChapterIndex(activeIdx);
      syncMediaSession("playing", activeIdx);

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
        const newIdx = startIndex + relIdx;
        if (currentChapterIndexRef.current !== newIdx) {
          currentChapterIndexRef.current = newIdx;
          setActiveChapterIndex(newIdx);
          syncMediaSession("playing", newIdx);
        }
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
          currentChapterIndexRef.current = null;
          setActiveChapterIndex(null);
          setStatus("error");
          syncMediaSession("error", null);
          return;
        }

        const speakChapterAt = (relChapterIdx: number) => {
          if (run !== sequenceRef.current) return;
          if (relChapterIdx >= remainingChapters.length) {
            playbackRef.current = null;
            currentChapterIndexRef.current = null;
            setActiveChapterIndex(null);
            setStatus("idle");
            syncMediaSession("idle", null);
            options.onComplete?.();
            return;
          }

          const chapterIdx = startIndex + relChapterIdx;
          currentChapterIndexRef.current = chapterIdx;
          setActiveChapterIndex(chapterIdx);
          syncMediaSession("playing", chapterIdx);

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
                  currentChapterIndexRef.current = null;
                  setActiveChapterIndex(null);
                  setStatus("error");
                  syncMediaSession("error", null);
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

      element.onplaying = () => {
        if (run === sequenceRef.current) {
          setStatus("playing");
          syncMediaSession("playing", currentChapterIndexRef.current);
        }
      };
      element.ontimeupdate = () => {
        updateChapterFromProgress(element.currentTime, element.duration);
      };
      element.onended = () => {
        if (run === sequenceRef.current) {
          releaseCloud();
          currentChapterIndexRef.current = null;
          setActiveChapterIndex(null);
          setStatus("idle");
          syncMediaSession("idle", null);
          options.onComplete?.();
        }
      };

      const startOnlineStream = () => {
        if (run !== sequenceRef.current || abort.signal.aborted) return;
        if (!clean || (typeof navigator !== "undefined" && navigator.onLine === false)) {
          fallbackToBrowserSpeech();
          return;
        }

        const readingVoice = options.voiceName || preferences.voices.en || "en-NZ-MollyNeural";
        const zhVoice = options.voiceName || preferences.voices.zh || "zh-CN-XiaoxiaoNeural";
        openArticleAudioStream(
          [clean],
          language,
          { en: readingVoice, zh: zhVoice },
          abort.signal,
          (streamStatus) => {
            if (run !== sequenceRef.current || abort.signal.aborted) return;
            if (streamStatus.error) {
              fallbackToBrowserSpeech();
            }
          },
        )
          .then((streamUrl) => {
            if (run !== sequenceRef.current || abort.signal.aborted) return;
            if (!streamUrl) {
              fallbackToBrowserSpeech();
              return;
            }
            element.src = streamUrl;
            element.play().catch(() => {
              fallbackToBrowserSpeech();
            });
          })
          .catch(() => {
            fallbackToBrowserSpeech();
          });
      };

      if (canUseOfflineFullBlob && offlineAudioBlob) {
        try {
          const blobUrl = URL.createObjectURL(offlineAudioBlob);
          objectUrlRef.current = blobUrl;
          element.src = blobUrl;
          element.play().catch(() => {
            fallbackToBrowserSpeech();
          });
          return;
        } catch {
          // If blob URL creation fails, fall back to online stream
        }
      }

      startOnlineStream();
    },
    [releaseCloud, stop, syncMediaSession],
  );

  const nextChapter = useCallback(() => {
    const chs = currentChaptersRef.current;
    const cur = currentChapterIndexRef.current ?? 0;
    if (cur + 1 < chs.length) {
      speakChapters(chs, { ...currentOptionsRef.current, startIndex: cur + 1 });
    }
  }, [speakChapters]);

  const previousChapter = useCallback(() => {
    const chs = currentChaptersRef.current;
    const cur = currentChapterIndexRef.current ?? 0;
    if (cur > 0) {
      speakChapters(chs, { ...currentOptionsRef.current, startIndex: cur - 1 });
    }
  }, [speakChapters]);

  // Wire lock-screen & car head unit media session action handlers
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;

    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => resume()],
      ["pause", () => pause()],
      ["previoustrack", () => previousChapter()],
      ["nexttrack", () => nextChapter()],
      ["seekforward", (details) => seekRelative(details?.seekOffset ?? 15)],
      ["seekbackward", (details) => seekRelative(-(details?.seekOffset ?? 15))],
      ["stop", () => stop()],
    ];

    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not all browsers support all media actions
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [resume, pause, previousChapter, nextChapter, seekRelative, stop]);

  const speak = useCallback(
    (
      rawText: string,
      targetLanguage?: string,
      offlineAudioBlob?: Blob | null,
      onComplete?: () => void,
      voiceName?: string,
    ) => {
      speakChapters([{ text: rawText }], {
        startIndex: 0,
        targetLanguage,
        voiceName,
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
    isActive: status === "starting" || status === "playing" || status === "paused",
    isSpeaking: status === "starting" || status === "playing",
    isPaused: status === "paused",
    isPlaying: status === "playing",
    activeChapterIndex,
    pause,
    resume,
    toggle,
    nextChapter,
    previousChapter,
    seekRelative,
    speak,
    speakChapters,
    stop,
  };
}
