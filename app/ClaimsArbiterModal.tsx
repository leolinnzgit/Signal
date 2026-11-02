"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  fetchClaimsArbiter,
  formatClaimsArbiterClipboard,
  type ClaimsArbiterResponse,
} from "./claims-arbiter";
import { openArticleAudioStream } from "./article-audio-stream";
import "./claims-arbiter.css";

export interface ClaimsArbiterModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTopic?: string;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>;
  preferredVoice?: string;
}

export default function ClaimsArbiterModal({
  isOpen,
  onClose,
  initialTopic = "Reserve Bank Monetary Policy & Dairy Payout Forecasts",
  articles = [],
  preferredVoice = "en-NZ-MollyNeural",
}: ClaimsArbiterModalProps) {
  const [topic, setTopic] = useState(initialTopic);
  const [data, setData] = useState<ClaimsArbiterResponse | null>(null);
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
      window.speechSynthesis.cancel();
    }
    setIsPlayingAudio(false);
  };

  useEffect(() => {
    if (!isOpen) {
      stopAudio();
      return;
    }

    setTopic(initialTopic || "Reserve Bank Monetary Policy & Dairy Payout Forecasts");
    void loadArbiter(initialTopic || "Reserve Bank Monetary Policy & Dairy Payout Forecasts");

    return () => {
      stopAudio();
    };
  }, [initialTopic, isOpen]);

  const loadArbiter = async (targetTopic: string) => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchClaimsArbiter(targetTopic, articles);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatClaimsArbiterClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Consensus Verdict copied to clipboard!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {}
  };

  const fallbackSpeech = (script: string) => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(script);
      utterance.rate = 1.15;
      utterance.onend = () => setIsPlayingAudio(false);
      utterance.onerror = () => setIsPlayingAudio(false);
      setIsPlayingAudio(true);
      window.speechSynthesis.speak(utterance);
    } else {
      setIsPlayingAudio(false);
    }
  };

  const handleToggleAudio = async () => {
    if (isPlayingAudio) {
      stopAudio();
      return;
    }

    if (!data?.spokenArbitrationScript) return;

    stopAudio();

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.spokenArbitrationScript],
        "en-NZ",
        { en: preferredVoice || "en-NZ-MollyNeural", zh: "zh-CN-XiaoxiaoNeural" },
        controller.signal,
        () => {},
      );

      if (controller.signal.aborted) return;

      if (streamUrl) {
        const audio = new Audio(streamUrl);
        audioRef.current = audio;
        audio.onended = () => {
          setIsPlayingAudio(false);
          audioRef.current = null;
        };
        audio.onerror = () => {
          fallbackSpeech(data.spokenArbitrationScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }
    } catch {}

    fallbackSpeech(data.spokenArbitrationScript);
  };

  if (!isOpen) return null;

  return (
    <div className="claims-arbiter-backdrop" role="dialog" aria-modal="true" aria-labelledby="claims-arbiter-title">
      <div className="claims-arbiter-modal">
        <header className="claims-arbiter-header">
          <h2 id="claims-arbiter-title" className="claims-arbiter-title">
            ⚖️ Contradiction Arbiter & Multi-Source Fact Verifier
          </h2>
          <button
            type="button"
            className="claims-arbiter-close-btn"
            onClick={onClose}
            aria-label="Close Claims Arbiter"
          >
            &times;
          </button>
        </header>

        <div className="claims-arbiter-body">
          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#fbbf24" }}>
              Reconciling diverging media reports & calculating consensus confidence...
            </div>
          ) : data ? (
            <>
              <div style={{ background: "rgba(30, 41, 59, 0.5)", border: "1px solid rgba(255,255,255,0.08)", padding: "0.85rem 1rem", borderRadius: "0.75rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Arbitration Subject:</div>
                  <div style={{ fontSize: "1rem", fontWeight: 700, color: "#f8fafc" }}>{data.topic}</div>
                </div>
                <div style={{ background: "rgba(245, 158, 11, 0.2)", color: "#fbbf24", border: "1px solid rgba(245, 158, 11, 0.3)", padding: "0.25rem 0.6rem", borderRadius: "0.375rem", fontSize: "0.75rem", fontWeight: 700 }}>
                  {data.reconciliationStatus}
                </div>
              </div>

              <div className="claims-arbiter-audio-bar">
                <div className="claims-arbiter-audio-info">
                  <span>⚡ 60-Second Fact Arbitration Audio Brief</span>
                </div>
                <button
                  type="button"
                  className="claims-arbiter-audio-btn"
                  onClick={handleToggleAudio}
                >
                  {isPlayingAudio ? "⏸ Stop Audio" : "▶ Listen Now"}
                </button>
              </div>

              <div>
                <div className="claims-arbiter-section-title">Reconciled Claim Divergence</div>
                {data.claims.map((c, idx) => (
                  <div key={idx} className="claims-card">
                    <div className="claims-card-header">
                      <span style={{ fontWeight: 700, color: "#f8fafc" }}>{c.subject}</span>
                      <span style={{ fontSize: "0.75rem", color: "#94a3b8", background: "rgba(255,255,255,0.08)", padding: "0.2rem 0.5rem", borderRadius: "0.25rem" }}>
                        {c.divergenceType} &bull; {c.confidenceScore}% Confidence
                      </span>
                    </div>

                    <div>
                      {c.outletsReporting.map((out, oIdx) => (
                        <div key={oIdx} className="claims-outlet-item">
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#fbbf24", marginBottom: "0.2rem" }}>
                            <span><strong>{out.publisher}</strong></span>
                            <span>{out.credibilityRating}</span>
                          </div>
                          <div style={{ color: "#e2e8f0" }}>{out.claimedValueOrQuote}</div>
                        </div>
                      ))}
                    </div>

                    <div className="claims-verdict-box">
                      <strong>Consensus Verdict:</strong> {c.consensusConclusion}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
                <div>
                  <div className="claims-arbiter-section-title" style={{ color: "#4ade80" }}>✓ Established Facts</div>
                  <div style={{ background: "rgba(15, 23, 42, 0.5)", border: "1px solid rgba(74, 222, 128, 0.2)", borderRadius: "0.5rem", padding: "0.75rem" }}>
                    {data.establishedFacts.map((fact, idx) => (
                      <div key={idx} style={{ fontSize: "0.8rem", color: "#cbd5e1", marginBottom: "0.4rem" }}>
                        • {fact}
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="claims-arbiter-section-title" style={{ color: "#f87171" }}>✗ Unverified Rumors</div>
                  <div style={{ background: "rgba(15, 23, 42, 0.5)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "0.5rem", padding: "0.75rem" }}>
                    {data.unverifiedRumors.map((rumor, idx) => (
                      <div key={idx} style={{ fontSize: "0.8rem", color: "#cbd5e1", marginBottom: "0.4rem" }}>
                        • {rumor}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        <footer className="claims-arbiter-footer">
          <div>
            {copyFeedback && <span style={{ color: "#4ade80", fontWeight: 600, fontSize: "0.85rem" }}>{copyFeedback}</span>}
          </div>
          <button
            type="button"
            className="claims-arbiter-copy-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📋 Export Consensus Memo
          </button>
        </footer>
      </div>
    </div>
  );
}
