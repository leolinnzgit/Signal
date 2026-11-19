"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef } from "react";
import {
  fetchMeetingPrep,
  formatMeetingPrepClipboard,
  type MeetingPrepResponse,
} from "./meeting-prep";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./meeting-prep.css";

export interface MeetingPrepModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialEntity?: string;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>;
  preferredVoice?: string;
}

export default function MeetingPrepModal({
  isOpen,
  onClose,
  initialEntity = "Fonterra",
  articles = [],
  preferredVoice,
}: MeetingPrepModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [entityInput, setEntityInput] = useState(initialEntity);
  const [data, setData] = useState<MeetingPrepResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState("");
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopAudio = () => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cancelListeningSpeech();
    }
    setIsPlayingAudio(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopAudio();
      return;
    }

    setEntityInput(initialEntity || "Fonterra");
    void loadPrep(initialEntity || "Fonterra");

    return () => {
      stopAudio();
    };
  }, [initialEntity, isOpen]);

  const loadPrep = async (targetEntity: string) => {
    if (!targetEntity.trim()) return;
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchMeetingPrep(targetEntity, articles, 30);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void loadPrep(entityInput);
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatMeetingPrepClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Flash Brief copied to clipboard!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {}
  };

  const fallbackSpeech = (script: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      cancelListeningSpeech();
      const utterance = new SpeechSynthesisUtterance(script);
      utterance.rate = 1.15;
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      setIsPlayingAudio(true);
      speakListeningSpeech(utterance, () => setIsPlayingAudio(false));
    } else {
      setIsPlayingAudio(false);
    }
  };

  const handleToggleAudio = async () => {
    if (isPlayingAudio) {
      stopAudio();
      return;
    }

    if (!data?.rapidFireAudioScript) return;

    stopAudio();

    // Default to high-fidelity Azure Neural Voice stream
    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.rapidFireAudioScript],
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        () => {},
      );

      if (controller.signal.aborted) return;

      if (streamUrl) {
        const audio = createListeningAudio(streamUrl, () => setIsPlayingAudio(false));
        audioRef.current = audio;
        audio.onended = () => {
          setIsPlayingAudio(false);
          audioRef.current = null;
        };
        audio.onerror = () => {
          fallbackSpeech(data.rapidFireAudioScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }
    } catch {
      // Fallback to browser speech if offline or Azure stream is unreachable
    }

    fallbackSpeech(data.rapidFireAudioScript);
  };

  if (!isOpen) return null;

  return (
    <div className="meeting-prep-backdrop" role="dialog" aria-modal="true" aria-labelledby="meeting-prep-title">
      <div className="meeting-prep-modal">
        <header className="meeting-prep-header">
          <h2 id="meeting-prep-title" className="meeting-prep-title">
            🎯 1-Minute Meeting Prep Brief
          </h2>
          <button
            type="button"
            className="meeting-prep-close-btn"
            onClick={onClose}
            aria-label="Close meeting prep"
          >
            &times;
          </button>
        </header>

        <div className="meeting-prep-body">
          <form className="meeting-prep-search-row" onSubmit={handleSearch}>
            <input
              type="text"
              className="meeting-prep-input"
              value={entityInput}
              onChange={(e) => setEntityInput(e.target.value)}
              placeholder="Enter company, executive, regulator, or partner name..."
              aria-label="Target organization or executive"
            />
            <button type="submit" className="meeting-prep-search-btn" disabled={loading}>
              {loading ? "Synthesizing..." : "Generate Brief"}
            </button>
          </form>

          {data && (
            <>
              <div className="meeting-prep-audio-bar">
                <div className="meeting-prep-audio-info">
                  <span>⚡ 60-Second Rapid-Fire Spoken Brief</span>
                </div>
                <button
                  type="button"
                  className="meeting-prep-audio-btn"
                  onClick={handleToggleAudio}
                >
                  {isPlayingAudio ? "⏸ Stop Audio" : "▶ Listen Now"}
                </button>
              </div>

              <div className="meeting-prep-meta-row">
                <span className="meeting-prep-badge">{data.sentimentTone}</span>
                <span>{data.sentimentTrajectory}</span>
              </div>

              <div>
                <div className="meeting-prep-section-title">Strategic Intelligence Points</div>
                <div className="meeting-prep-card-list">
                  {data.strategicPoints.map((p, idx) => (
                    <div key={idx} className="meeting-prep-card">
                      <div className="meeting-prep-card-header">
                        <span className="meeting-prep-card-category">{p.category}</span>
                        <span className="meeting-prep-card-source">{p.source}</span>
                      </div>
                      <p className="meeting-prep-card-desc">{p.description}</p>
                    </div>
                  ))}
                </div>
              </div>

              {data.leadershipQuotes.length > 0 && (
                <div>
                  <div className="meeting-prep-section-title">Leadership On The Record</div>
                  <div className="meeting-prep-card-list">
                    {data.leadershipQuotes.map((q, idx) => (
                      <div key={idx} className="meeting-prep-quote-card">
                        <p className="meeting-prep-quote-text">&ldquo;{q.quote}&rdquo;</p>
                        <div className="meeting-prep-quote-speaker">
                          — {q.speaker} [{q.stance}] &bull; {q.context}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="meeting-prep-section-title">Boardroom Questions & Talking Points</div>
                <div className="meeting-prep-card-list">
                  {data.talkingPoints.map((t, idx) => (
                    <div key={idx} className="meeting-prep-talking-card">
                      <strong>{t.dimension}</strong>: {t.talkingPoint}
                      <div className="meeting-prep-question-row">
                        👉 Ask: &ldquo;{t.questionToAsk}&rdquo;
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <footer className="meeting-prep-footer">
          {copyFeedback ? (
            <span className="meeting-prep-feedback">{copyFeedback}</span>
          ) : (
            <span style={{ color: "#64748b", fontSize: "0.8rem" }}>
              Instant flash card for elevator & boardroom review
            </span>
          )}
          <button
            type="button"
            className="meeting-prep-copy-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📋 Copy Flash Card
          </button>
        </footer>
      </div>
    </div>
  );
}
