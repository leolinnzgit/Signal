"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  fetchRegulatoryRadar,
  formatRegulatoryRadarClipboard,
  type RegulatoryRadarResponse,
} from "./regulatory-radar";
import { openArticleAudioStream } from "./article-audio-stream";
import "./regulatory-radar.css";

export interface RegulatoryRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSector?: string;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>;
  preferredVoice?: string;
}

const SECTOR_OPTIONS = [
  "All NZ/APAC Sectors",
  "Agri & Primary Industries",
  "Banking & Fintech",
  "Energy & Resources",
  "Technology & Retail",
];

export default function RegulatoryRadarModal({
  isOpen,
  onClose,
  initialSector = "All NZ/APAC Sectors",
  articles = [],
  preferredVoice = "en-NZ-MollyNeural",
}: RegulatoryRadarModalProps) {
  const [sector, setSector] = useState(initialSector);
  const [data, setData] = useState<RegulatoryRadarResponse | null>(null);
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

    setSector(initialSector || "All NZ/APAC Sectors");
    void loadRadar(initialSector || "All NZ/APAC Sectors");

    return () => {
      stopAudio();
    };
  }, [initialSector, isOpen]);

  const loadRadar = async (targetSector: string) => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchRegulatoryRadar(targetSector, "New Zealand / Australasia", articles);
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleSectorChange = (targetSector: string) => {
    setSector(targetSector);
    void loadRadar(targetSector);
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatRegulatoryRadarClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Compliance Checklist copied to clipboard!");
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

    if (!data?.spokenComplianceScript) return;

    stopAudio();

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.spokenComplianceScript],
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
          fallbackSpeech(data.spokenComplianceScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }
    } catch {}

    fallbackSpeech(data.spokenComplianceScript);
  };

  if (!isOpen) return null;

  return (
    <div className="regulatory-radar-backdrop" role="dialog" aria-modal="true" aria-labelledby="regulatory-radar-title">
      <div className="regulatory-radar-modal">
        <header className="regulatory-radar-header">
          <h2 id="regulatory-radar-title" className="regulatory-radar-title">
            📜 Regulatory Horizon & Policy Compliance Radar
          </h2>
          <button
            type="button"
            className="regulatory-radar-close-btn"
            onClick={onClose}
            aria-label="Close Regulatory Radar"
          >
            &times;
          </button>
        </header>

        <div className="regulatory-radar-body">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
            {SECTOR_OPTIONS.map((sec) => (
              <button
                key={sec}
                type="button"
                style={{
                  background: sector === sec ? "#9333ea" : "rgba(255,255,255,0.06)",
                  color: sector === sec ? "#fff" : "#cbd5e1",
                  border: "1px solid rgba(255,255,255,0.12)",
                  padding: "0.35rem 0.8rem",
                  borderRadius: "9999px",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
                onClick={() => handleSectorChange(sec)}
              >
                {sec}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#c084fc" }}>
              Scanning select committee bills and statutory compliance schedules...
            </div>
          ) : data ? (
            <>
              <div className="regulatory-radar-audio-bar">
                <div className="regulatory-radar-audio-info">
                  <span>⚡ 60-Second Boardroom Compliance Audio Brief</span>
                </div>
                <button
                  type="button"
                  className="regulatory-radar-audio-btn"
                  onClick={handleToggleAudio}
                >
                  {isPlayingAudio ? "⏸ Stop Audio" : "▶ Listen Now"}
                </button>
              </div>

              <div>
                <div className="regulatory-radar-section-title">Active Legislative Mandates & Bills</div>
                {data.billsAndMandates.map((b, idx) => (
                  <div key={idx} className="regulatory-bill-card">
                    <div className="regulatory-bill-header">
                      <span className="regulatory-bill-title">{b.title}</span>
                      <span className="regulatory-bill-stage">{b.stage}</span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "#94a3b8", margin: "0.3rem 0" }}>
                      <strong>Regulator:</strong> {b.regulatoryBody} &bull; <strong>Deadline:</strong> {b.complianceDeadline}
                    </div>
                    <div style={{ fontSize: "0.85rem", color: "#cbd5e1", marginBottom: "0.3rem" }}>{b.summary}</div>
                    <div style={{ fontSize: "0.75rem", color: "#f87171" }}><strong>Exposure:</strong> {b.penaltyExposure}</div>
                  </div>
                ))}
              </div>

              <div>
                <div className="regulatory-radar-section-title">Boardroom Compliance Action Checklist</div>
                {data.complianceChecklist.map((c, idx) => (
                  <div key={idx} className="regulatory-checklist-item">
                    <div>
                      <div style={{ fontWeight: 600, color: "#f1f5f9" }}>{c.requirement}</div>
                      <div style={{ color: "#94a3b8", fontSize: "0.8rem" }}>{c.actionItem}</div>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                      <span style={{ fontSize: "0.75rem", color: "#cbd5e1" }}>{c.targetQuarter}</span>
                      <span className={`regulatory-priority-badge ${c.priority.toLowerCase()}`}>{c.priority}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <footer className="regulatory-radar-footer">
          <div>
            {copyFeedback && <span style={{ color: "#4ade80", fontWeight: 600, fontSize: "0.85rem" }}>{copyFeedback}</span>}
          </div>
          <button
            type="button"
            className="regulatory-radar-copy-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📋 Copy Compliance Action Plan
          </button>
        </footer>
      </div>
    </div>
  );
}
