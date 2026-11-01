"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { DeepDiveEpisode, DeepDiveTurn, DeepDiveChapter } from "./daily-briefing-deep-dive";
import { openArticleAudioStream } from "./article-audio-stream";
import {
  createHeadlinePlayback,
  HEADLINE_SPEECH_PREFERENCES_KEY,
  normalizeHeadlineSpeechPreferences,
} from "./headline-playback";

export interface DeepDivePodcastPlayerProps {
  episode: DeepDiveEpisode;
  onClose: () => void;
  targetLanguage?: string;
}

export default function DeepDivePodcastPlayer({
  episode,
  onClose,
  targetLanguage = "en",
}: DeepDivePodcastPlayerProps) {
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<ReturnType<typeof createHeadlinePlayback> | null>(null);
  const turnIndexRef = useRef(0);
  const isPlayingRef = useRef(false);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  const turns: DeepDiveTurn[] = episode.turns || [];
  const chapters: DeepDiveChapter[] = episode.chapters || [];
  const currentTurn = turns[currentTurnIndex] || turns[0];
  const activeSpeaker = currentTurn?.speaker || "Anchor";

  // Keep refs in sync
  useEffect(() => {
    turnIndexRef.current = currentTurnIndex;
  }, [currentTurnIndex]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Scroll active turn into view
  useEffect(() => {
    const activeEl = document.getElementById(`deep-dive-turn-${currentTurnIndex}`);
    if (activeEl && transcriptScrollRef.current) {
      activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentTurnIndex]);

  const stopCurrentAudio = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch {}
      objectUrlRef.current = null;
    }
    playbackRef.current?.dispose();
    playbackRef.current = null;
  }, []);

  const playTurn = useCallback(
    async (turnIdx: number) => {
      if (turnIdx >= turns.length) {
        setIsPlaying(false);
        setCurrentTurnIndex(0);
        return;
      }

      stopCurrentAudio();
      setCurrentTurnIndex(turnIdx);
      setIsPlaying(true);
      setAudioError(null);

      const turn = turns[turnIdx];
      if (!turn) return;

      // Update MediaSession
      if (typeof window !== "undefined" && typeof navigator !== "undefined" && "mediaSession" in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: `${turn.speakerName}: ${turn.text.slice(0, 60)}...`,
            artist: "Signal Executive Deep Dive",
            album: episode.title,
            artwork: [
              { src: "/icons/signal-medallion-512.png", sizes: "512x512", type: "image/png" },
              { src: "/icons/signal-medallion-192.png", sizes: "192x192", type: "image/png" },
            ],
          });
          navigator.mediaSession.playbackState = "playing";
        } catch {}
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // Try streaming cloud neural audio using the turn's distinct voice
      try {
        const streamUrl = await openArticleAudioStream(
          [turn.text],
          targetLanguage,
          {
            en: turn.voiceName || (turn.speaker === "Anchor" ? "en-US-AndrewMultilingualNeural" : "en-US-AvaMultilingualNeural"),
            zh: turn.voiceName || (turn.speaker === "Anchor" ? "zh-CN-YunxiNeural" : "zh-CN-XiaoxiaoNeural"),
          },
          controller.signal,
          () => {},
        );

        if (controller.signal.aborted) return;

        if (streamUrl) {
          const audio = new Audio(streamUrl);
          audioRef.current = audio;

          audio.onended = () => {
            if (turnIndexRef.current === turnIdx && isPlayingRef.current) {
              playTurn(turnIdx + 1);
            }
          };

          audio.onerror = () => {
            fallbackSpeech(turnIdx);
          };

          await audio.play();
          return;
        }
      } catch {
        // Fall back to browser speech synthesis
      }

      fallbackSpeech(turnIdx);
    },
    [turns, targetLanguage, episode.title, stopCurrentAudio],
  );

  const fallbackSpeech = useCallback(
    (turnIdx: number) => {
      stopCurrentAudio();
      const turn = turns[turnIdx];
      if (!turn) return;

      if (
        typeof window === "undefined" ||
        !window.speechSynthesis ||
        typeof window.SpeechSynthesisUtterance !== "function"
      ) {
        setAudioError("Audio playback not supported in this browser.");
        setIsPlaying(false);
        return;
      }

      const utterance = new SpeechSynthesisUtterance(turn.text);
      let preferences = normalizeHeadlineSpeechPreferences(null);
      try {
        preferences = normalizeHeadlineSpeechPreferences(
          JSON.parse(localStorage.getItem(HEADLINE_SPEECH_PREFERENCES_KEY) ?? "null"),
        );
      } catch {}

      utterance.rate = preferences.rate || 1.0;
      // Differentiate pitch between Anchor (1.0) and Analyst (1.15)
      utterance.pitch = turn.speaker === "Anchor" ? 0.95 : 1.15;
      utterance.lang = targetLanguage.startsWith("zh") ? "zh-CN" : "en-NZ";

      utterance.onend = () => {
        if (turnIndexRef.current === turnIdx && isPlayingRef.current) {
          playTurn(turnIdx + 1);
        }
      };

      utterance.onerror = () => {
        setIsPlaying(false);
      };

      window.speechSynthesis.speak(utterance);
    },
    [turns, targetLanguage, stopCurrentAudio, playTurn],
  );

  const togglePlayPause = () => {
    if (isPlaying) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.pause();
      }
      setIsPlaying(false);
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "paused";
      }
    } else {
      if (audioRef.current && audioRef.current.paused && audioRef.current.src) {
        audioRef.current.play().catch(() => playTurn(currentTurnIndex));
        setIsPlaying(true);
        if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
          navigator.mediaSession.playbackState = "playing";
        }
      } else {
        playTurn(currentTurnIndex);
      }
    }
  };

  const handleNextTurn = () => {
    if (currentTurnIndex < turns.length - 1) {
      playTurn(currentTurnIndex + 1);
    }
  };

  const handlePrevTurn = () => {
    if (currentTurnIndex > 0) {
      playTurn(currentTurnIndex - 1);
    }
  };

  const handleSeekRelative = (seconds: number) => {
    if (audioRef.current && Number.isFinite(audioRef.current.duration)) {
      audioRef.current.currentTime = Math.max(
        0,
        Math.min(audioRef.current.duration, audioRef.current.currentTime + seconds),
      );
    }
  };

  const handleJumpToChapter = (startTurnIdx: number) => {
    playTurn(startTurnIdx);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCurrentAudio();
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "none";
      }
    };
  }, [stopCurrentAudio]);

  const currentChapter = chapters
    .slice()
    .reverse()
    .find((ch) => currentTurnIndex >= ch.startTurnIndex) || chapters[0];

  return (
    <div
      className="deep-dive-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Signal Executive Deep Dive Podcast Player"
    >
      <div className="deep-dive-modal">
        {/* Header */}
        <header className="deep-dive-header">
          <div className="deep-dive-title-group">
            <span className="deep-dive-badge">🎙️ PODCAST DEEP DIVE</span>
            <h2 className="deep-dive-title">{episode.title}</h2>
            <p className="deep-dive-subtitle">{episode.subtitle}</p>
          </div>
          <button
            type="button"
            className="deep-dive-close-btn"
            onClick={onClose}
            aria-label="Close Deep Dive Player"
          >
            ✕
          </button>
        </header>

        {/* Dual Host Studio Stage */}
        <div className="deep-dive-stage">
          {/* Host 1: Anchor Alex */}
          <div
            className={`deep-dive-host-card ${activeSpeaker === "Anchor" && isPlaying ? "is-speaking" : ""}`}
          >
            <div className="deep-dive-avatar-wrap">
              <div className="deep-dive-avatar anchor-avatar" aria-hidden="true">
                🎙️
              </div>
              {activeSpeaker === "Anchor" && isPlaying && (
                <span className="speaking-wave-pulse" aria-hidden="true" />
              )}
            </div>
            <div className="deep-dive-host-meta">
              <strong className="host-name">Alex</strong>
              <span className="host-role">Executive Anchor</span>
            </div>
          </div>

          <div className="deep-dive-stage-center">
            <span className="deep-dive-vs-badge">VS</span>
            {currentChapter && (
              <span className="deep-dive-chapter-badge">{currentChapter.title}</span>
            )}
          </div>

          {/* Host 2: Analyst Elena */}
          <div
            className={`deep-dive-host-card ${activeSpeaker === "Analyst" && isPlaying ? "is-speaking" : ""}`}
          >
            <div className="deep-dive-avatar-wrap">
              <div className="deep-dive-avatar analyst-avatar" aria-hidden="true">
                📊
              </div>
              {activeSpeaker === "Analyst" && isPlaying && (
                <span className="speaking-wave-pulse" aria-hidden="true" />
              )}
            </div>
            <div className="deep-dive-host-meta">
              <strong className="host-name">Elena</strong>
              <span className="host-role">Chief Analyst</span>
            </div>
          </div>
        </div>

        {/* Chapter Navigation Chips */}
        {chapters.length > 0 && (
          <nav className="deep-dive-chapters-nav" aria-label="Podcast Chapters">
            {chapters.map((ch, idx) => {
              const isCurrent = currentChapter?.startTurnIndex === ch.startTurnIndex;
              return (
                <button
                  key={ch.title}
                  type="button"
                  className={`deep-dive-chapter-chip ${isCurrent ? "is-active" : ""}`}
                  onClick={() => handleJumpToChapter(ch.startTurnIndex)}
                >
                  <span className="chapter-num">{idx + 1}.</span> {ch.title}
                </button>
              );
            })}
          </nav>
        )}

        {/* Live Transcript Stream */}
        <div
          className="deep-dive-transcript-stream"
          ref={transcriptScrollRef}
          role="region"
          aria-label="Dialogue Transcript"
        >
          {turns.map((turn) => {
            const isTurnActive = turn.index === currentTurnIndex;
            return (
              <div
                key={turn.index}
                id={`deep-dive-turn-${turn.index}`}
                className={`deep-dive-turn-row ${isTurnActive ? "is-active-turn" : ""} speaker-${turn.speaker.toLowerCase()}`}
              >
                <div className="turn-speaker-badge">
                  <span className="speaker-icon">
                    {turn.speaker === "Anchor" ? "🎙️ Alex" : "📊 Elena"}
                  </span>
                </div>
                <div className="turn-content">
                  <p className="turn-text">{turn.text}</p>
                  {turn.citedSource && (
                    <div className="turn-citation">
                      <span className="citation-label">Reported by:</span>
                      {turn.citedUrl ? (
                        <a
                          href={turn.citedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="citation-link"
                        >
                          {turn.citedSource} ↗
                        </a>
                      ) : (
                        <span className="citation-pill">{turn.citedSource}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {audioError && (
          <p className="deep-dive-error-bar" role="alert">
            {audioError}
          </p>
        )}

        {/* Audio Transport Bar */}
        <footer className="deep-dive-transport">
          <button
            type="button"
            className="deep-dive-btn"
            onClick={handlePrevTurn}
            disabled={currentTurnIndex <= 0}
            aria-label="Previous Dialogue Turn"
          >
            ⏮
          </button>

          <button
            type="button"
            className="deep-dive-btn seek-btn"
            onClick={() => handleSeekRelative(-15)}
            aria-label="Rewind 15 seconds"
          >
            ↺ 15s
          </button>

          <button
            type="button"
            className={`deep-dive-btn play-btn ${isPlaying ? "is-playing" : ""}`}
            onClick={togglePlayPause}
            aria-label={isPlaying ? "Pause Deep Dive Episode" : "Play Deep Dive Episode"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>

          <button
            type="button"
            className="deep-dive-btn seek-btn"
            onClick={() => handleSeekRelative(15)}
            aria-label="Skip 15 seconds"
          >
            15s ↻
          </button>

          <button
            type="button"
            className="deep-dive-btn"
            onClick={handleNextTurn}
            disabled={currentTurnIndex >= turns.length - 1}
            aria-label="Next Dialogue Turn"
          >
            ⏭
          </button>
        </footer>
      </div>
    </div>
  );
}
