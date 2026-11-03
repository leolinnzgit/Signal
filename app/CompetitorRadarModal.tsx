"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  fetchCompetitorRadar,
  formatCompetitorRadarClipboard,
  type CompetitorRadarResponse,
} from "./competitor-radar";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./competitor-radar.css";

export interface CompetitorRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialPeerGroup?: string;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>;
  preferredVoice?: string;
}

const DEFAULT_SECTORS = [
  "Dairy & Agri-Export",
  "Telecom & Infrastructure",
  "Banking & Wealth",
  "Energy & Renewables",
];

export default function CompetitorRadarModal({
  isOpen,
  onClose,
  initialPeerGroup = "Dairy & Agri-Export",
  articles = [],
  preferredVoice,
}: CompetitorRadarModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [peerGroup, setPeerGroup] = useState(initialPeerGroup);
  const [data, setData] = useState<CompetitorRadarResponse | null>(null);
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

    setPeerGroup(initialPeerGroup || "Dairy & Agri-Export");
    void loadRadar(initialPeerGroup || "Dairy & Agri-Export");

    return () => {
      stopAudio();
    };
  }, [initialPeerGroup, isOpen]);

  const loadRadar = async (group: string) => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchCompetitorRadar(group, undefined, articles, 30);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleSectorChange = (group: string) => {
    setPeerGroup(group);
    void loadRadar(group);
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatCompetitorRadarClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Deal Sheet copied to clipboard!");
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

    if (!data?.spokenAudioScript) return;

    stopAudio();

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.spokenAudioScript],
        "en-NZ",
        { en: activeVoice, zh: "zh-CN-XiaoxiaoNeural" },
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
          fallbackSpeech(data.spokenAudioScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }
    } catch {}

    fallbackSpeech(data.spokenAudioScript);
  };

  if (!isOpen) return null;

  return (
    <div className="competitor-radar-backdrop" role="dialog" aria-modal="true" aria-labelledby="competitor-radar-title">
      <div className="competitor-radar-modal">
        <header className="competitor-radar-header">
          <h2 id="competitor-radar-title" className="competitor-radar-title">
            🎯 Competitive Intelligence Radar & M&A Tracker
          </h2>
          <button
            type="button"
            className="competitor-radar-close-btn"
            onClick={onClose}
            aria-label="Close Competitor Radar"
          >
            &times;
          </button>
        </header>

        <div className="competitor-radar-body">
          <div className="competitor-radar-sectors-row">
            {DEFAULT_SECTORS.map((sec) => (
              <button
                key={sec}
                type="button"
                className={`competitor-radar-sector-chip ${peerGroup === sec ? "active" : ""}`}
                onClick={() => handleSectorChange(sec)}
              >
                {sec}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
              Synthesizing peer moves and regulatory deal flow...
            </div>
          ) : data ? (
            <>
              <div className="competitor-radar-hhi-bar">
                <span>Market Concentration Index:</span>
                <span className="competitor-radar-hhi-score">
                  HHI {data.marketConcentrationHHI} &bull; {data.concentrationLabel}
                </span>
              </div>

              <div className="competitor-radar-audio-bar">
                <div className="competitor-radar-audio-info">
                  <span>⚡ 60-Second Competitive Intelligence Brief</span>
                </div>
                <button
                  type="button"
                  className="competitor-radar-audio-btn"
                  onClick={handleToggleAudio}
                >
                  {isPlayingAudio ? "⏸ Stop Audio" : "▶ Listen Now"}
                </button>
              </div>

              <div>
                <div className="competitor-radar-section-title">M&A Deal Flow & Regulatory Clearance</div>
                <div className="competitor-radar-deals-grid">
                  {data.deals.map((deal, idx) => (
                    <div key={idx} className="competitor-radar-deal-card">
                      <div className="competitor-radar-deal-header">
                        <span className="competitor-radar-deal-name">{deal.dealName}</span>
                        <span className="competitor-radar-deal-value">{deal.estimatedValue}</span>
                      </div>
                      <div className="competitor-radar-deal-meta">
                        <span><strong>Acquirer:</strong> {deal.acquirer}</span>
                        <span>&bull;</span>
                        <span><strong>Status:</strong> {deal.status}</span>
                        <span>&bull;</span>
                        <span><strong>Watchdog:</strong> {deal.regulatoryWatchdog}</span>
                        <span className={`competitor-radar-badge risk-${deal.antitrustRiskLevel.toLowerCase()}`}>
                          {deal.antitrustRiskLevel} Antitrust Risk
                        </span>
                      </div>
                      <p style={{ margin: "0.25rem 0", fontSize: "0.85rem", color: "#cbd5e1" }}>
                        {deal.strategicRationale}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="competitor-radar-section-title">Peer Strategic Movements</div>
                <div className="competitor-radar-movements-grid">
                  {data.peerMovements.map((m, idx) => (
                    <div key={idx} className="competitor-radar-movement-card">
                      <div className="competitor-radar-movement-header">
                        <span className="competitor-radar-competitor-name">{m.competitor}</span>
                        <span className="competitor-radar-pillar-badge">{m.strategicPillar}</span>
                      </div>
                      <div className="competitor-radar-movement-headline">{m.headline}</div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        {m.source} &bull; {m.date}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <footer className="competitor-radar-footer">
          <div>
            {copyFeedback && <span className="competitor-radar-copy-feedback">{copyFeedback}</span>}
          </div>
          <button
            type="button"
            className="competitor-radar-copy-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📋 Copy Deal Sheet
          </button>
        </footer>
      </div>
    </div>
  );
}
