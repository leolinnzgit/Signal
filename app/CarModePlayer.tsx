"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { DailyBriefingData, DailyBriefingChapter } from "./daily-briefing";
import { detectCoHostQuestionIntent, type CoHostState } from "./daily-briefing-cohost";
import { buildSuggestedBriefingQuestions } from "./daily-briefing-qa";

export interface CarModePlayerProps {
  briefing: DailyBriefingData;
  activeChapterIndex: number | null;
  isSpeaking: boolean;
  isPaused: boolean;
  onPlayPause: () => void;
  onPreviousChapter: () => void;
  onNextChapter: () => void;
  onSeekRelative: (seconds: number) => void;
  onClose: () => void;
  onQueueStories?: () => void;
  onSnooze?: (minutes: number) => void;
  coHostState?: CoHostState | null;
  onAskCoHost?: (question: string) => Promise<void> | void;
  onDismissCoHost?: () => void;
}

export default function CarModePlayer({
  briefing,
  activeChapterIndex,
  isSpeaking,
  isPaused,
  onPlayPause,
  onPreviousChapter,
  onNextChapter,
  onSeekRelative,
  onClose,
  onQueueStories,
  onSnooze,
  coHostState,
  onAskCoHost,
  onDismissCoHost,
}: CarModePlayerProps) {
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  const [queuedNotification, setQueuedNotification] = useState(false);
  const [showQuestionPicker, setShowQuestionPicker] = useState(false);
  const wakeLockRef = useRef<any>(null);
  const recognitionRef = useRef<any>(null);

  const chapters: DailyBriefingChapter[] = briefing?.chapters ?? [];
  const currentIndex = Math.max(
    0,
    Math.min(chapters.length - 1, activeChapterIndex ?? 0),
  );
  const currentChapter = chapters[currentIndex];
  const totalChapters = chapters.length;
  const suggestedQuestions = buildSuggestedBriefingQuestions(briefing);

  // Request screen wake lock so the display stays awake on car mounts
  useEffect(() => {
    let released = false;
    if (typeof navigator !== "undefined" && "wakeLock" in navigator) {
      (navigator as any).wakeLock
        .request("screen")
        .then((lock: any) => {
          if (!released) wakeLockRef.current = lock;
          else lock.release?.();
        })
        .catch(() => {});
    }

    return () => {
      released = true;
      try {
        wakeLockRef.current?.release?.();
      } catch {}
      wakeLockRef.current = null;
    };
  }, []);

  // Voice Command recognition setup
  const handleVoiceCommand = useCallback(
    (text: string) => {
      const lower = text.toLowerCase().trim();
      setVoiceFeedback(`Heard: "${lower}"`);
      window.setTimeout(() => setVoiceFeedback(null), 3000);

      // Check for voice co-host questions first
      const coHostIntent = detectCoHostQuestionIntent(text);
      if (coHostIntent && onAskCoHost) {
        setVoiceFeedback(`Co-Host: "${coHostIntent.questionText}"`);
        window.setTimeout(() => setVoiceFeedback(null), 4000);
        onAskCoHost(coHostIntent.questionText);
        return;
      }

      if (lower.includes("pause") || lower.includes("wait") || lower.includes("hold")) {
        if (isSpeaking) onPlayPause();
      } else if (lower.includes("play") || lower.includes("resume") || lower.includes("start")) {
        if (!isSpeaking || isPaused) onPlayPause();
      } else if (lower.includes("next") || lower.includes("skip") || lower.includes("forward")) {
        onNextChapter();
      } else if (lower.includes("previous") || lower.includes("back") || lower.includes("rewind")) {
        onPreviousChapter();
      } else if (lower.includes("snooze")) {
        onSnooze?.(10);
      } else if (lower.includes("queue")) {
        onQueueStories?.();
        setQueuedNotification(true);
        window.setTimeout(() => setQueuedNotification(false), 3000);
      } else if (lower.includes("stop") || lower.includes("exit") || lower.includes("close")) {
        onClose();
      }
    },
    [isSpeaking, isPaused, onPlayPause, onNextChapter, onPreviousChapter, onSnooze, onQueueStories, onClose, onAskCoHost],
  );

  const toggleVoiceControl = useCallback(() => {
    if (voiceActive) {
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      recognitionRef.current = null;
      setVoiceActive(false);
      setVoiceFeedback(null);
      return;
    }

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setVoiceFeedback("Voice recognition not supported in this browser");
      window.setTimeout(() => setVoiceFeedback(null), 3000);
      return;
    }

    try {
      const recog = new SpeechRecognition();
      recog.continuous = true;
      recog.interimResults = false;
      recog.lang = "en-US";

      recog.onresult = (event: any) => {
        const last = event.results[event.results.length - 1];
        if (last && last[0]?.transcript) {
          handleVoiceCommand(last[0].transcript);
        }
      };

      recog.onerror = () => {
        // Recognition will restart on end if still active
      };

      recog.onend = () => {
        if (recognitionRef.current) {
          try {
            recog.start();
          } catch {}
        }
      };

      recognitionRef.current = recog;
      recog.start();
      setVoiceActive(true);
      setVoiceFeedback("Listening for 'play', 'pause', 'next', 'previous', 'snooze'...");
      window.setTimeout(() => setVoiceFeedback(null), 4000);
    } catch {
      setVoiceFeedback("Could not activate microphone");
      window.setTimeout(() => setVoiceFeedback(null), 3000);
    }
  }, [voiceActive, handleVoiceCommand]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.stop?.();
      } catch {}
      recognitionRef.current = null;
    };
  }, []);

  const progressPercent = totalChapters > 0 ? ((currentIndex + 1) / totalChapters) * 100 : 0;

  return (
    <div
      className="car-mode-overlay"
      role="region"
      aria-label="Smart Car & Commute Briefing"
    >
      {/* Top Bar with Mode Header and Exit Button */}
      <header className="car-mode-header">
        <div className="car-mode-badge">
          <span className="car-mode-icon" aria-hidden="true">🚗</span>
          <div className="car-mode-meta">
            <span className="car-mode-title">COMMUTE MODE</span>
            <span className="car-mode-sub">Signal Executive Briefing</span>
          </div>
        </div>

        <button
          type="button"
          className="car-mode-close-btn"
          onClick={onClose}
          aria-label="Exit Car Mode"
        >
          ✕ Exit
        </button>
      </header>

      {/* Main Chapter Display */}
      <main className="car-mode-main">
        <div className="car-mode-chapter-card">
          <div className="car-mode-chapter-tag">
            <span>Chapter {currentIndex + 1} of {totalChapters}</span>
            <span className="car-mode-chapter-icon">{currentChapter?.icon || "🎙️"}</span>
          </div>

          <h2 className="car-mode-chapter-title">
            {currentChapter?.label || "Daily Briefing"}
          </h2>

          <p className="car-mode-chapter-preview">
            {currentChapter?.text || "Audio briefing narration in progress..."}
          </p>
        </div>

        {/* Progress Strip */}
        <div
          className="car-mode-progress-strip"
          role="progressbar"
          aria-valuenow={currentIndex + 1}
          aria-valuemin={1}
          aria-valuemax={totalChapters}
        >
          <div
            className="car-mode-progress-fill"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Voice Feedback Pill */}
        {voiceFeedback && (
          <div className="car-mode-voice-feedback" role="status" aria-live="polite">
            <span className="car-mode-mic-pulse" aria-hidden="true">🎙️</span>
            <span>{voiceFeedback}</span>
          </div>
        )}

        {queuedNotification && (
          <div className="car-mode-voice-feedback" role="status">
            <span>✅ Lead stories added to queue!</span>
          </div>
        )}

        {/* Co-Host Interaction & Answer Display */}
        {coHostState && (coHostState.asking || coHostState.answer || coHostState.error) && (
          <div className="car-mode-cohost-overlay" role="region" aria-label="Executive Co-Host Answer">
            <div className="car-mode-cohost-header">
              <span className="car-mode-cohost-badge">
                <span className="car-mode-mic-pulse" aria-hidden="true">🎙️</span> Executive Co-Host
              </span>
              {onDismissCoHost && (
                <button
                  type="button"
                  className="car-mode-cohost-dismiss"
                  onClick={onDismissCoHost}
                  aria-label="Dismiss Co-Host Answer and Resume Briefing"
                >
                  ✕ Resume
                </button>
              )}
            </div>
            {coHostState.question && (
              <p className="car-mode-cohost-question">
                <strong>Q:</strong> {coHostState.question}
              </p>
            )}
            {coHostState.asking && (
              <p className="car-mode-cohost-asking">
                Consulting executive briefing signals &amp; live market data...
              </p>
            )}
            {coHostState.answer && (
              <p className="car-mode-cohost-answer">
                {coHostState.answer}
              </p>
            )}
            {coHostState.error && (
              <p className="car-mode-cohost-error">
                {coHostState.error}
              </p>
            )}
          </div>
        )}

        {/* Quick Automotive Question Chips */}
        {showQuestionPicker && (
          <div className="car-mode-quick-questions" role="menu" aria-label="Suggested Co-Host Questions">
            <div className="car-mode-questions-header">
              <span>Tap a question or speak:</span>
              <button
                type="button"
                className="car-mode-cohost-dismiss"
                onClick={() => setShowQuestionPicker(false)}
              >
                ✕
              </button>
            </div>
            <div className="car-mode-question-chips">
              {suggestedQuestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="car-mode-question-chip"
                  onClick={() => {
                    setShowQuestionPicker(false);
                    onAskCoHost?.(q);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Huge Automotive Driving Touch Controls */}
        <div className="car-mode-controls-primary">
          <button
            type="button"
            className="car-mode-btn car-mode-btn-nav"
            onClick={onPreviousChapter}
            disabled={currentIndex <= 0}
            aria-label="Previous Chapter"
          >
            <span className="car-btn-symbol" aria-hidden="true">⏮</span>
            <span className="car-btn-text">Prev</span>
          </button>

          <button
            type="button"
            className="car-mode-btn car-mode-btn-seek"
            onClick={() => onSeekRelative(-15)}
            aria-label="Rewind 15 seconds"
          >
            <span className="car-btn-symbol" aria-hidden="true">↺ 15s</span>
          </button>

          <button
            type="button"
            className={`car-mode-btn car-mode-btn-play ${isSpeaking && !isPaused ? "is-playing" : ""}`}
            onClick={onPlayPause}
            aria-label={isSpeaking && !isPaused ? "Pause Briefing" : "Play Briefing"}
          >
            <span className="car-play-symbol" aria-hidden="true">
              {isSpeaking && !isPaused ? "⏸" : "▶"}
            </span>
          </button>

          <button
            type="button"
            className="car-mode-btn car-mode-btn-seek"
            onClick={() => onSeekRelative(15)}
            aria-label="Skip 15 seconds"
          >
            <span className="car-btn-symbol" aria-hidden="true">15s ↻</span>
          </button>

          <button
            type="button"
            className="car-mode-btn car-mode-btn-nav"
            onClick={onNextChapter}
            disabled={currentIndex >= totalChapters - 1}
            aria-label="Next Chapter"
          >
            <span className="car-btn-symbol" aria-hidden="true">⏭</span>
            <span className="car-btn-text">Next</span>
          </button>
        </div>

        {/* Commute Secondary Controls: Voice & Queue */}
        <div className="car-mode-controls-secondary">
          <button
            type="button"
            className={`car-mode-secondary-btn ${voiceActive ? "is-active" : ""}`}
            onClick={toggleVoiceControl}
            aria-pressed={voiceActive}
            aria-label="Toggle Driving Voice Control"
          >
            <span aria-hidden="true">{voiceActive ? "🔴 Mic Active" : "🎙️ Voice Control"}</span>
          </button>

          {onAskCoHost && (
            <button
              type="button"
              className={`car-mode-secondary-btn car-mode-cohost-btn ${coHostState?.asking ? "is-active" : ""}`}
              onClick={() => {
                if (!voiceActive) {
                  toggleVoiceControl();
                  setVoiceFeedback("Say your question aloud or tap suggestions");
                  window.setTimeout(() => setVoiceFeedback(null), 4000);
                  setShowQuestionPicker(true);
                } else {
                  setShowQuestionPicker((prev) => !prev);
                }
              }}
              aria-label="Talk to Your Briefing Executive Co-Host"
            >
              <span aria-hidden="true">{coHostState?.asking ? "⏳ Consulting..." : "🎙️ Ask Co-Host"}</span>
            </button>
          )}

          {onQueueStories && (
            <button
              type="button"
              className="car-mode-secondary-btn"
              onClick={() => {
                onQueueStories();
                setQueuedNotification(true);
                window.setTimeout(() => setQueuedNotification(false), 3000);
              }}
              aria-label="Queue Briefing Lead Stories for Continued Drive"
            >
              <span>➕ Queue Stories</span>
            </button>
          )}

          {onSnooze && (
            <button
              type="button"
              className="car-mode-secondary-btn"
              onClick={() => onSnooze(10)}
              aria-label="Snooze Briefing 10 minutes"
            >
              <span>⏰ Snooze 10m</span>
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
