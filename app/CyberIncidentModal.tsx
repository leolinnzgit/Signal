"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef } from "react";
import {
  fetchCyberIncidentStatus,
  formatCyberIncidentDigest,
  getSectorIcon,
  getSeverityBadgeClass,
  type CyberIncidentResponse,
  type CyberIncident,
} from "./cyber-incident";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./cyber-incident.css";

export interface CyberIncidentModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  preferredVoice?: string;
}

const CATEGORY_FILTERS = [
  "All Categories",
  "Zero-Day Exploit",
  "Nation-State APT",
  "Critical Infrastructure",
  "Ransomware & Extortion",
];

export default function CyberIncidentModal({
  isOpen,
  onClose,
  articles = [],
  preferredVoice,
}: CyberIncidentModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<CyberIncidentResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("All Categories");
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
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

    void loadStatus();

    return () => {
      stopAudio();
    };
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const loadStatus = async () => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchCyberIncidentStatus({ articles });
      setData(res);
    } catch {
      // Degrade gracefully
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatCyberIncidentDigest(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("CISO Intelligence Briefing copied to clipboard!");
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
        const audio = createListeningAudio(streamUrl, () => setIsPlayingAudio(false));
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

      fallbackSpeech(data.spokenAudioScript);
    } catch {
      fallbackSpeech(data.spokenAudioScript);
    }
  };

  if (!isOpen) return null;

  const filteredIncidents = (data?.incidents || []).filter((inc: CyberIncident) => {
    if (selectedCategory !== "All Categories" && inc.category !== selectedCategory) {
      return false;
    }
    if (selectedSector) {
      const matchSector = inc.affectedSystems.some((sys) =>
        sys.toLowerCase().includes(selectedSector.toLowerCase())
      ) || inc.title.toLowerCase().includes(selectedSector.toLowerCase());
      if (!matchSector && selectedCategory === "All Categories") {
        return false;
      }
    }
    return true;
  });

  return (
    <div
      className="cyber-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="cyber-hud-title"
    >
      <div className="cyber-hud-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="cyber-hud-header">
          <div className="cyber-hud-title-wrap">
            <span className="cyber-hud-icon" aria-hidden="true">⚡</span>
            <div>
              <h2 id="cyber-hud-title" className="cyber-hud-title">
                Cyber Warfare & Critical Infrastructure Incident HUD
              </h2>
              <div className="cyber-hud-subtitle">
                CISO Cyber Threat Radar • CISA KEV & Infrastructure Telemetry
              </div>
            </div>
          </div>
          <div className="cyber-hud-controls">
            <button
              type="button"
              className={`cyber-btn cyber-btn-audio ${isPlayingAudio ? "active" : ""}`}
              onClick={handleToggleAudio}
              disabled={!data || loading}
              title="Incident Command Audio Dispatch (Azure Neural Voice)"
              aria-label={isPlayingAudio ? "Stop Audio Dispatch" : "Play Incident Command Audio"}
            >
              <span aria-hidden="true">{isPlayingAudio ? "⏹️" : "🔊"}</span>
              <span>{isPlayingAudio ? "Stop Dispatch" : "Audio Dispatch"}</span>
            </button>
            <button
              type="button"
              className="cyber-btn cyber-btn-copy"
              onClick={handleCopy}
              disabled={!data || loading}
              title="Copy CISO Briefing to Clipboard"
            >
              📋 Copy Briefing
            </button>
            <button
              type="button"
              className="cyber-btn-close"
              onClick={onClose}
              aria-label="Close Cyber Incident HUD"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Feedback Alert */}
        {copyFeedback && <div className="cyber-feedback">{copyFeedback}</div>}

        {/* Posture & Telemetry Banner */}
        <div className="cyber-posture-banner">
          <div className="cyber-defcon-badge">
            <span className="cyber-pulse-dot" aria-hidden="true" />
            <span>{data?.defconLevel || "DEFCON 2 — Severe Advisory"}</span>
          </div>
          <div className="cyber-posture-summary">
            {loading
              ? "Synthesizing global cyber threat vectors, zero-day CVE advisories, and infrastructure telemetry..."
              : data?.threatSummary || "Active zero-day exploitation and targeted infrastructure reconnaissance observed."}
          </div>
          <div className="cyber-telemetry-strip">
            <div className="cyber-telemetry-box">
              <div className="cyber-telemetry-val threat-score">
                {data ? `${data.compositeThreatIndex}/100` : "--"}
              </div>
              <div className="cyber-telemetry-label">Risk Index</div>
            </div>
            <div className="cyber-telemetry-box">
              <div className="cyber-telemetry-val threat-red">
                {data?.activeZeroDays ?? 0}
              </div>
              <div className="cyber-telemetry-label">Zero-Days</div>
            </div>
            <div className="cyber-telemetry-box">
              <div className="cyber-telemetry-val">
                {data?.activeAptCampaigns ?? 0}
              </div>
              <div className="cyber-telemetry-label">APT Waves</div>
            </div>
            <div className="cyber-telemetry-box">
              <div className="cyber-telemetry-val">
                {data?.criticalOutages ?? 0}
              </div>
              <div className="cyber-telemetry-label">Outages</div>
            </div>
          </div>
        </div>

        {/* Body Content */}
        <div className="cyber-hud-body">
          {/* Sector Exposure Matrix */}
          <div>
            <div className="cyber-section-title">
              <span>Sector Exposure & Infrastructure Attack Surface</span>
              <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                Select sector to filter incidents
              </span>
            </div>
            <div className="cyber-sector-grid">
              {(data?.sectors || []).map((sec) => (
                <div
                  key={sec.sector}
                  className={`cyber-sector-card ${selectedSector === sec.sector ? "selected" : ""}`}
                  onClick={() => setSelectedSector(selectedSector === sec.sector ? null : sec.sector)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      setSelectedSector(selectedSector === sec.sector ? null : sec.sector);
                    }
                  }}
                >
                  <div className="cyber-sector-top">
                    <span className="cyber-sector-name">
                      <span>{getSectorIcon(sec.sector)}</span>
                      <span>{sec.sector}</span>
                    </span>
                    <span className={`cyber-badge ${getSeverityBadgeClass(sec.riskLevel)}`}>
                      {sec.riskLevel}
                    </span>
                  </div>
                  <div className="cyber-sector-desc">{sec.description}</div>
                  <div className="cyber-sector-meta">
                    <span>Vector: {sec.threatVector}</span>
                    <span>Trend: {sec.trend}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Incidents & Exploit Triage */}
          <div>
            <div className="cyber-section-title">
              <span>Active Exploit Feeds & Infrastructure Incidents ({filteredIncidents.length})</span>
            </div>

            {/* Category Filter Pills */}
            <div className="cyber-filters-bar">
              {CATEGORY_FILTERS.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`cyber-filter-pill ${selectedCategory === cat ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                </button>
              ))}
              {selectedSector && (
                <button
                  type="button"
                  className="cyber-filter-pill active"
                  onClick={() => setSelectedSector(null)}
                  title="Clear Sector Filter"
                >
                  Sector: {selectedSector} ✕
                </button>
              )}
            </div>

            {/* Incident Cards */}
            <div className="cyber-incidents-list">
              {filteredIncidents.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "#64748b", fontStyle: "italic" }}>
                  No active incidents matching the selected category and sector filter.
                </div>
              ) : (
                filteredIncidents.map((inc) => (
                  <div
                    key={inc.id}
                    className={`cyber-incident-card ${inc.severity.toLowerCase()}`}
                  >
                    <div className="cyber-incident-top">
                      <h3 className="cyber-incident-title">{inc.title}</h3>
                      <div className="cyber-incident-tags">
                        <span className="cyber-cve-tag">{inc.cve}</span>
                        <span className={`cyber-badge ${getSeverityBadgeClass(inc.severity)}`}>
                          {inc.severity}
                        </span>
                      </div>
                    </div>

                    <div className="cyber-incident-metadata">
                      <span>Actor: <strong className="cyber-actor-tag">{inc.threatActor}</strong></span>
                      <span>Category: {inc.category}</span>
                      <span>Source: {inc.source}</span>
                      <span>Timestamp: {inc.timestamp}</span>
                    </div>

                    <div className="cyber-incident-impact">
                      {inc.impactAssessment}
                    </div>

                    {inc.affectedSystems?.length > 0 && (
                      <div className="cyber-affected-systems">
                        {inc.affectedSystems.map((sys) => (
                          <span key={sys} className="cyber-system-pill">
                            🎯 {sys}
                          </span>
                        ))}
                      </div>
                    )}

                    {inc.mitigationDirectives?.length > 0 && (
                      <div className="cyber-mitigations-box">
                        <div className="cyber-mitigations-heading">
                          🛡️ Incident Commander Tactical Directives
                        </div>
                        <ul className="cyber-mitigations-list">
                          {inc.mitigationDirectives.map((mit, i) => (
                            <li key={i}>{mit}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {inc.articleUrl && (
                      <div className="cyber-incident-footer">
                        <span>Correlated from live feed article</span>
                        <a
                          href={inc.articleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="cyber-link-btn"
                        >
                          View Source Coverage ↗
                        </a>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Priority Defense Posture & Mitigations */}
          <div className="cyber-defense-panel">
            <div className="cyber-section-title" style={{ marginBottom: "0.5rem" }}>
              <span>Executive Cybersecurity Readiness Directives</span>
            </div>
            <div>
              {(data?.mitigations || []).map((m, idx) => {
                const urgencyClass = m.urgency.includes("Immediate") || m.urgency.includes("P0")
                  ? "cyber-urgency-p0"
                  : m.urgency.includes("24") || m.urgency.includes("P1")
                  ? "cyber-urgency-p1"
                  : "cyber-urgency-p2";
                return (
                  <div key={idx} className="cyber-defense-item">
                    <span className={`cyber-urgency-badge ${urgencyClass}`}>
                      {m.urgency}
                    </span>
                    <div>
                      <div className="cyber-defense-text">{m.action}</div>
                      <div className="cyber-defense-domain">Domain: {m.targetDomain}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
