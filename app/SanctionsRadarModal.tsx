"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef } from "react";
import {
  fetchSanctionsRadarStatus,
  formatSanctionsRadarDigest,
  getJurisdictionIcon,
  getSanctionSeverityBadgeClass,
  type SanctionsRadarResponse,
  type SanctionMeasure,
} from "./sanctions-radar";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./sanctions-radar.css";

export interface SanctionsRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  preferredVoice?: string;
}

const CATEGORY_FILTERS = [
  "All Categories",
  "Export Controls & Dual-Use",
  "Financial & Banking Sanctions",
  "Tariffs & Trade Remedies",
  "Critical Minerals & Commodities",
  "Maritime & Shadow Fleet",
];

export default function SanctionsRadarModal({
  isOpen,
  onClose,
  articles = [],
  preferredVoice,
}: SanctionsRadarModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<SanctionsRadarResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState("All Categories");
  const [selectedJurisdiction, setSelectedJurisdiction] = useState<string | null>(null);
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
      const res = await fetchSanctionsRadarStatus({ articles });
      setData(res);
    } catch {
      // Degrade gracefully
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatSanctionsRadarDigest(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Sanctions & trade compliance briefing copied to clipboard!");
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

  const filteredMeasures = (data?.measures || []).filter((meas: SanctionMeasure) => {
    if (selectedCategory !== "All Categories" && meas.category !== selectedCategory) {
      return false;
    }
    if (selectedJurisdiction) {
      const matchJur = meas.regime.toLowerCase().includes(selectedJurisdiction.toLowerCase()) ||
                       meas.title.toLowerCase().includes(selectedJurisdiction.toLowerCase());
      if (!matchJur && selectedCategory === "All Categories") {
        return false;
      }
    }
    return true;
  });

  return (
    <div
      className="sanctions-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sanctions-hud-title"
    >
      <div className="sanctions-hud-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="sanctions-hud-header">
          <div className="sanctions-hud-title-wrap">
            <span className="sanctions-hud-icon" aria-hidden="true">🛡️</span>
            <div>
              <h2 id="sanctions-hud-title" className="sanctions-hud-title">
                Global Sanctions, Tariffs & Export Controls Radar
              </h2>
              <div className="sanctions-hud-subtitle">
                Economic Statecraft • OFAC SDN • BIS Entity List • Critical Minerals
              </div>
            </div>
          </div>
          <div className="sanctions-hud-controls">
            <button
              type="button"
              className={`sanctions-btn sanctions-btn-audio ${isPlayingAudio ? "active" : ""}`}
              onClick={handleToggleAudio}
              disabled={!data || loading}
              title="Sanctions & Trade Compliance Audio Briefing (Azure Neural Voice)"
              aria-label={isPlayingAudio ? "Stop Audio Dispatch" : "Play Sanctions Audio Dispatch"}
            >
              <span aria-hidden="true">{isPlayingAudio ? "⏹️" : "🔊"}</span>
              <span>{isPlayingAudio ? "Stop Dispatch" : "Audio Dispatch"}</span>
            </button>
            <button
              type="button"
              className="sanctions-btn sanctions-btn-copy"
              onClick={handleCopy}
              disabled={!data || loading}
              title="Copy Trade Compliance Briefing to Clipboard"
            >
              📋 Copy Briefing
            </button>
            <button
              type="button"
              className="sanctions-btn sanctions-btn-close"
              onClick={onClose}
              aria-label="Close Sanctions Radar"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Feedback Alert */}
        {copyFeedback && <div className="sanctions-feedback">{copyFeedback}</div>}

        {/* Posture & Telemetry Banner */}
        <div className="sanctions-posture-banner">
          <div className="sanctions-status-badge">
            <span className="sanctions-pulse-dot" aria-hidden="true" />
            <span>{data?.globalEnforcementLevel || "Heightened Enforcement — Strategic Trade Controls"}</span>
          </div>
          <div className="sanctions-posture-summary">
            {loading
              ? "Synthesizing multilateral trade sanctions, dual-use export controls, and tariff schedules..."
              : data?.policySummary || "Tightened licensing thresholds on semiconductors and critical mineral quotas alongside escalating tariff disputes."}
          </div>
          <div className="sanctions-telemetry-strip">
            <div className="sanctions-telemetry-box">
              <div className="sanctions-telemetry-val risk-score">
                {data ? `${data.compositeRiskIndex}/100` : "--"}
              </div>
              <div className="sanctions-telemetry-label">Risk Index</div>
            </div>
            <div className="sanctions-telemetry-box">
              <div className="sanctions-telemetry-val stat-red">
                {data?.activeSanctionsActions ?? 0}
              </div>
              <div className="sanctions-telemetry-label">Sanctions</div>
            </div>
            <div className="sanctions-telemetry-box">
              <div className="sanctions-telemetry-val">
                {data?.exportBansInEffect ?? 0}
              </div>
              <div className="sanctions-telemetry-label">Export Bans</div>
            </div>
            <div className="sanctions-telemetry-box">
              <div className="sanctions-telemetry-val">
                {data?.designatedEntitiesCount ? `${data.designatedEntitiesCount}+` : "--"}
              </div>
              <div className="sanctions-telemetry-label">Entities</div>
            </div>
          </div>
        </div>

        {/* Body Content */}
        <div className="sanctions-hud-body">
          {/* Jurisdiction Exposure Matrix */}
          <div>
            <div className="sanctions-section-title">
              <span>Jurisdiction Regulatory Posture & Enforcement Matrix</span>
              <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
                Select jurisdiction to filter measures
              </span>
            </div>
            <div className="sanctions-jurisdiction-grid">
              {(data?.jurisdictions || []).map((jur) => (
                <div
                  key={jur.jurisdiction}
                  className={`sanctions-jurisdiction-card ${selectedJurisdiction === jur.jurisdiction ? "selected" : ""}`}
                  onClick={() => setSelectedJurisdiction(selectedJurisdiction === jur.jurisdiction ? null : jur.jurisdiction)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      setSelectedJurisdiction(selectedJurisdiction === jur.jurisdiction ? null : jur.jurisdiction);
                    }
                  }}
                >
                  <div className="sanctions-jurisdiction-top">
                    <span className="sanctions-jurisdiction-name">
                      <span>{getJurisdictionIcon(jur.jurisdiction)}</span>
                      <span>{jur.jurisdiction}</span>
                    </span>
                    <span className={`sanction-badge ${getSanctionSeverityBadgeClass(jur.riskLevel)}`}>
                      {jur.riskLevel}
                    </span>
                  </div>
                  <div className="sanctions-jurisdiction-desc">{jur.description}</div>
                  <div className="sanctions-jurisdiction-meta">
                    <span>Focus: {jur.focusArea}</span>
                    <span>Trend: {jur.enforcementTrend}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Regulatory Measures & Restrictions */}
          <div>
            <div className="sanctions-section-title">
              <span>Active Trade Restrictions, Export Bans & Tariff Schedules ({filteredMeasures.length})</span>
            </div>

            {/* Category Filter Pills */}
            <div className="sanctions-filters-bar">
              {CATEGORY_FILTERS.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`sanctions-filter-pill ${selectedCategory === cat ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                </button>
              ))}
              {selectedJurisdiction && (
                <button
                  type="button"
                  className="sanctions-filter-pill active"
                  onClick={() => setSelectedJurisdiction(null)}
                  title="Clear Jurisdiction Filter"
                >
                  Jurisdiction: {selectedJurisdiction} ✕
                </button>
              )}
            </div>

            {/* Measure Cards */}
            <div className="sanctions-measures-list">
              {filteredMeasures.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "#6b7280", fontStyle: "italic" }}>
                  No active trade measures matching the selected category and jurisdiction filter.
                </div>
              ) : (
                filteredMeasures.map((meas) => (
                  <div
                    key={meas.id}
                    className={`sanctions-measure-card ${meas.severity.toLowerCase()}`}
                  >
                    <div className="sanctions-measure-top">
                      <h3 className="sanctions-measure-title">{meas.title}</h3>
                      <div className="sanctions-measure-tags">
                        <span className="sanctions-regime-tag">{meas.regime}</span>
                        <span className={`sanction-badge ${getSanctionSeverityBadgeClass(meas.severity)}`}>
                          {meas.severity}
                        </span>
                      </div>
                    </div>

                    <div className="sanctions-measure-metadata">
                      <span>Category: <strong>{meas.category}</strong></span>
                      <span>Effective: {meas.effectiveDate}</span>
                      <span>Source: {meas.source}</span>
                    </div>

                    <div className="sanctions-measure-exposure">
                      {meas.exposureAssessment}
                    </div>

                    {meas.impactedSectors?.length > 0 && (
                      <div className="sanctions-impacted-sectors">
                        {meas.impactedSectors.map((sec) => (
                          <span key={sec} className="sanctions-sector-pill">
                            📦 {sec}
                          </span>
                        ))}
                      </div>
                    )}

                    {meas.complianceDirectives?.length > 0 && (
                      <div className="sanctions-directives-box">
                        <div className="sanctions-directives-heading">
                          ⚖️ Mandatory Compliance & Trade Directives
                        </div>
                        <ul className="sanctions-directives-list">
                          {meas.complianceDirectives.map((dir, i) => (
                            <li key={i}>{dir}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {meas.articleUrl && (
                      <div className="sanctions-measure-footer">
                        <span>Correlated from live feed article</span>
                        <a
                          href={meas.articleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="sanctions-link-btn"
                        >
                          View Coverage ↗
                        </a>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Priority Compliance Directives Panel */}
          <div className="sanctions-compliance-panel">
            <div className="sanctions-section-title" style={{ marginBottom: "0.5rem" }}>
              <span>Executive Trade Compliance Directives</span>
            </div>
            <div>
              {(data?.directives || []).map((dir, idx) => {
                const urgencyClass = dir.urgency.includes("Immediate") || dir.urgency.includes("P0")
                  ? "sanctions-urgency-p0"
                  : dir.urgency.includes("24") || dir.urgency.includes("P1")
                  ? "sanctions-urgency-p1"
                  : "sanctions-urgency-p2";
                return (
                  <div key={idx} className="sanctions-compliance-item">
                    <span className={`sanctions-urgency-badge ${urgencyClass}`}>
                      {dir.urgency}
                    </span>
                    <div>
                      <div className="sanctions-compliance-text">{dir.action}</div>
                      <div className="sanctions-compliance-domain">Domain: {dir.targetDomain}</div>
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
