"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  buildCommutePlaylist,
  formatCommuteTime,
  setupMediaSession,
  type CommutePlaylist,
} from "./commute-playlist";
import "./commute-playlist.css";

export interface CommutePlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  briefing?: {
    edition?: string;
    formattedDate?: string;
    spokenScript?: string;
    leadStories?: Array<{ title: string; source: string; url: string; summary?: string }>;
    weatherGlance?: { temperature: number; condition: string; location: string };
  } | null;
  marketSentiment?: {
    macroHeadline?: string;
    assets?: Array<{ symbol: string; name: string; price: number; changePercent?: number; percentChange?: number; sentimentTone?: string }>;
  } | null;
  stagedArticles?: Array<{ title: string; source: string; url: string; summary?: string }>;
}

export default function CommutePlaylistModal({
  isOpen,
  onClose,
  briefing,
  marketSentiment,
  stagedArticles = [],
}: CommutePlaylistModalProps) {
  const [playlist, setPlaylist] = useState<CommutePlaylist | null>(null);
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<1 | 1.25 | 1.5>(1.25);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const pl = buildCommutePlaylist(briefing, marketSentiment, stagedArticles);
    setPlaylist(pl);
    setCurrentChapterIndex(0);
    setElapsedSeconds(0);
    setIsPlaying(true);
  }, [briefing, isOpen, marketSentiment, stagedArticles]);

  const activeChapter = playlist?.chapters[currentChapterIndex] || null;

  const handleNext = useCallback(() => {
    if (!playlist) return;
    if (currentChapterIndex < playlist.chapters.length - 1) {
      setCurrentChapterIndex((prev) => prev + 1);
      setElapsedSeconds(0);
    } else {
      setIsPlaying(false);
    }
  }, [currentChapterIndex, playlist]);

  const handlePrev = useCallback(() => {
    if (elapsedSeconds > 5) {
      setElapsedSeconds(0);
    } else if (currentChapterIndex > 0) {
      setCurrentChapterIndex((prev) => prev - 1);
      setElapsedSeconds(0);
    }
  }, [currentChapterIndex, elapsedSeconds]);

  // MediaSession integration
  useEffect(() => {
    if (!playlist) return;
    setupMediaSession(playlist, currentChapterIndex, {
      onPlay: () => setIsPlaying(true),
      onPause: () => setIsPlaying(false),
      onNext: handleNext,
      onPrevious: handlePrev,
      onSeekTo: (time) => setElapsedSeconds(time),
    });
  }, [currentChapterIndex, handleNext, handlePrev, playlist]);

  // Simulated continuous audio playback progress
  useEffect(() => {
    if (isPlaying && activeChapter) {
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds((prev) => {
          if (prev >= activeChapter.durationSeconds) {
            handleNext();
            return 0;
          }
          return prev + 1;
        });
      }, 1000 / playbackRate);
    } else if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeChapter, handleNext, isPlaying, playbackRate]);

  if (!isOpen || !playlist || !activeChapter) return null;

  const progressPercent = Math.min(100, (elapsedSeconds / activeChapter.durationSeconds) * 100);

  const toggleRate = () => {
    setPlaybackRate((prev) => (prev === 1 ? 1.25 : prev === 1.25 ? 1.5 : 1));
  };

  return (
    <div
      className="commute-playlist-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="commute-title"
    >
      <div className="commute-playlist-card">
        {/* Header */}
        <header className="commute-header">
          <div>
            <span className="commute-kicker">🚗 EXECUTIVE COMMUTE PLAYLIST</span>
            <h2 id="commute-title" className="commute-title">{playlist.title}</h2>
          </div>
          <button
            type="button"
            className="commute-close-btn"
            onClick={onClose}
            aria-label="Close Commute Playlist"
          >
            ✕
          </button>
        </header>

        {/* Current Active Chapter Card */}
        <div className="commute-active-focus">
          <span className="commute-chapter-badge">
            Chapter {currentChapterIndex + 1} of {playlist.chapters.length} &bull; {activeChapter.category.replace("_", " ")}
          </span>
          <h3 className="commute-chapter-title">{activeChapter.title}</h3>
          <p className="commute-chapter-source">Reporting by {activeChapter.source || "Signal Intelligence Desk"}</p>
          <p className="commute-narration-preview">
            &ldquo;{activeChapter.narrationText}&rdquo;
          </p>
        </div>

        {/* Scrubber */}
        <div className="commute-scrubber-container">
          <div
            className="commute-progress-bar-bg"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const clickX = e.clientX - rect.left;
              const frac = Math.max(0, Math.min(1, clickX / rect.width));
              setElapsedSeconds(Math.floor(frac * activeChapter.durationSeconds));
            }}
          >
            <div className="commute-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="commute-timestamps">
            <span>{formatCommuteTime(elapsedSeconds)}</span>
            <span>{formatCommuteTime(activeChapter.durationSeconds)}</span>
          </div>
        </div>

        {/* Extra Large Car-Friendly Controls */}
        <div className="commute-controls-row">
          <button
            type="button"
            className="commute-ctrl-btn"
            onClick={handlePrev}
            title="Previous chapter"
            aria-label="Previous chapter"
          >
            ⏮
          </button>
          <button
            type="button"
            className="commute-ctrl-btn play-btn"
            onClick={() => setIsPlaying((p) => !p)}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            className="commute-ctrl-btn"
            onClick={handleNext}
            title="Next chapter"
            aria-label="Next chapter"
          >
            ⏭
          </button>
          <button
            type="button"
            className="commute-speed-toggle"
            onClick={toggleRate}
            title="Change narration speed"
          >
            {playbackRate}x
          </button>
        </div>

        {/* Chapter List */}
        <div className="commute-chapter-list" role="list" aria-label="Playlist Chapters">
          {playlist.chapters.map((chap, idx) => (
            <div
              key={chap.id}
              role="listitem"
              className={`commute-chapter-item ${idx === currentChapterIndex ? "active" : ""}`}
              onClick={() => {
                setCurrentChapterIndex(idx);
                setElapsedSeconds(0);
                setIsPlaying(true);
              }}
            >
              <span className="commute-chapter-item-title">
                {idx + 1}. {chap.title}
              </span>
              <span className="commute-chapter-item-duration">
                {formatCommuteTime(chap.durationSeconds)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
