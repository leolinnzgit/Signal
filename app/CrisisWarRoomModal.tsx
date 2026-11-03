"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  activateCrisisWarRoom,
  formatCrisisWarRoomClipboard,
  type CrisisWarRoomResponse,
} from "./crisis-war-room";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./crisis-war-room.css";

export interface CrisisWarRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialIncidentTitle?: string;
  affectedEntity?: string;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string; summary?: string }>;
  preferredVoice?: string;
}

export default function CrisisWarRoomModal({
  isOpen,
  onClose,
  initialIncidentTitle = "Critical Infrastructure Supply Chain Disruption",
  affectedEntity = "Primary Regional Operations",
  articles = [],
  preferredVoice,
}: CrisisWarRoomModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<CrisisWarRoomResponse | null>(null);
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

    void loadCrisis();

    return () => {
      stopAudio();
    };
  }, [affectedEntity, initialIncidentTitle, isOpen]);

  const loadCrisis = async () => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await activateCrisisWarRoom(
        initialIncidentTitle,
        affectedEntity,
        "Critical",
        articles,
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatCrisisWarRoomClipboard(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Crisis Dossier copied to clipboard!");
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

    if (!data?.urgentSituationScript) return;

    stopAudio();

    try {
      const controller = new AbortController();
      abortRef.current = controller;

      const streamUrl = await openArticleAudioStream(
        [data.urgentSituationScript],
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
          fallbackSpeech(data.urgentSituationScript);
        };
        await audio.play();
        setIsPlayingAudio(true);
        return;
      }
    } catch {}

    fallbackSpeech(data.urgentSituationScript);
  };

  if (!isOpen) return null;

  return (
    <div className="crisis-war-room-backdrop" role="dialog" aria-modal="true" aria-labelledby="crisis-war-room-title">
      <div className="crisis-war-room-modal">
        <header className="crisis-war-room-header">
          <h2 id="crisis-war-room-title" className="crisis-war-room-title">
            🚨 Executive Crisis War Room & Incident Command HUD
          </h2>
          <button
            type="button"
            className="crisis-war-room-close-btn"
            onClick={onClose}
            aria-label="Close Crisis War Room"
          >
            &times;
          </button>
        </header>

        <div className="crisis-war-room-body">
          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#fca5a5" }}>
              Activating incident command channels & synthesizing stakeholder exposure...
            </div>
          ) : data ? (
            <>
              <div className="crisis-war-room-banner">
                <div>
                  <div style={{ fontSize: "1.1rem", fontWeight: 700 }}>{data.incidentTitle}</div>
                  <div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
                    Affected: <strong>{data.affectedEntity}</strong> &bull; Incident ID: {data.incidentId}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span className="crisis-war-room-badge">{data.severityLevel}</span>
                  <span style={{ fontSize: "0.8rem", color: "#f87171", fontWeight: 600 }}>
                    {data.containmentStatus}
                  </span>
                </div>
              </div>

              <div className="crisis-war-room-audio-bar">
                <div className="crisis-war-room-audio-info">
                  <span>⚡ Urgent Incident Audio Situation Report</span>
                </div>
                <button
                  type="button"
                  className="crisis-war-room-audio-btn"
                  onClick={handleToggleAudio}
                >
                  {isPlayingAudio ? "⏸ Stop Audio" : "▶ Listen Now"}
                </button>
              </div>

              <div>
                <div className="crisis-war-room-section-title">Verified Holding Statements</div>
                {data.holdingStatements.map((hs, idx) => (
                  <div key={idx} className="crisis-holding-card">
                    <div className="crisis-holding-audience">Audience: {hs.audience} ({hs.guidanceTone})</div>
                    <p className="crisis-holding-quote">{hs.statement}</p>
                  </div>
                ))}
              </div>

              <div>
                <div className="crisis-war-room-section-title">Stakeholder Impact Matrix</div>
                <div className="crisis-stakeholder-grid">
                  {data.stakeholderImpacts.map((imp, idx) => (
                    <div key={idx} className="crisis-stakeholder-card">
                      <div className="crisis-stakeholder-header">
                        <span>{imp.group}</span>
                        <span style={{ color: "#f87171" }}>{imp.exposureLevel}</span>
                      </div>
                      <div style={{ color: "#cbd5e1", marginBottom: "0.25rem" }}>{imp.immediateRisk}</div>
                      <div style={{ color: "#94a3b8", fontSize: "0.75rem" }}><strong>Mitigation:</strong> {imp.mitigationAction}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="crisis-war-room-section-title">Incident Chronology</div>
                <div style={{ background: "rgba(15, 23, 42, 0.4)", borderRadius: "0.5rem", padding: "0.75rem" }}>
                  {data.timeline.map((item, idx) => (
                    <div key={idx} className="crisis-timeline-item">
                      <span className="crisis-timeline-time">{item.timestamp}</span>
                      <span style={{ flex: 1 }}>{item.milestone}</span>
                      <span style={{ color: "#64748b", fontSize: "0.75rem" }}>{item.source}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </div>

        <footer className="crisis-war-room-footer">
          <div>
            {copyFeedback && <span style={{ color: "#4ade80", fontWeight: 600, fontSize: "0.85rem" }}>{copyFeedback}</span>}
          </div>
          <button
            type="button"
            className="crisis-war-room-copy-btn"
            onClick={handleCopy}
            disabled={!data}
          >
            📋 Export War Room Playbook
          </button>
        </footer>
      </div>
    </div>
  );
}
