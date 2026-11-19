"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef } from "react";
import {
  fetchHorizonDossiers,
  formatHorizonScannerDigest,
  getDomainIcon,
  getMilestoneStatusClass,
  getDossierStatusClass,
  type HorizonScannerResponse,
  type HorizonDossier,
} from "./horizon-scanner";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./horizon-scanner.css";

export interface HorizonScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  preferredVoice?: string;
}

export default function HorizonScannerModal({
  isOpen,
  onClose,
  articles = [],
  preferredVoice,
}: HorizonScannerModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<HorizonScannerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeDossierId, setActiveDossierId] = useState<string | null>(null);
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

    void loadDossiers();

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

  const loadDossiers = async () => {
    setLoading(true);
    try {
      const res = await fetchHorizonDossiers({ articles });
      setData(res);
      if (res.dossiers.length > 0 && !activeDossierId) {
        setActiveDossierId(res.dossiers[0].id);
      }
    } catch {
      // Degrade gracefully
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatHorizonScannerDigest(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Horizon strategic briefing copied to clipboard!");
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

  const currentDossier: HorizonDossier | undefined =
    data?.dossiers.find((d) => d.id === activeDossierId) || data?.dossiers[0];

  return (
    <div
      className="horizon-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="horizon-hud-title"
    >
      <div className="horizon-hud-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="horizon-hud-header">
          <div className="horizon-hud-title-wrap">
            <span className="horizon-hud-icon" aria-hidden="true">🔭</span>
            <div>
              <h2 id="horizon-hud-title" className="horizon-hud-title">
                Autonomous Horizon Scanner & Living Dossiers
              </h2>
              <div className="horizon-hud-subtitle">
                Strategic Multi-Quarter Inflections • Delta Synthesis • Verified Roadmaps
              </div>
            </div>
          </div>
          <div className="horizon-hud-controls">
            <button
              type="button"
              className={`horizon-btn horizon-btn-audio ${isPlayingAudio ? "active" : ""}`}
              onClick={handleToggleAudio}
              disabled={!data || loading}
              title="Strategic Horizon Audio Briefing (Azure Neural Voice)"
              aria-label={isPlayingAudio ? "Stop Audio Dispatch" : "Play Horizon Audio Dispatch"}
            >
              <span aria-hidden="true">{isPlayingAudio ? "⏹️" : "🔊"}</span>
              <span>{isPlayingAudio ? "Stop Dispatch" : "Audio Dispatch"}</span>
            </button>
            <button
              type="button"
              className="horizon-btn horizon-btn-copy"
              onClick={handleCopy}
              disabled={!data || loading}
              title="Copy Horizon Strategic Memo to Clipboard"
            >
              📋 Copy Memo
            </button>
            <button
              type="button"
              className="horizon-btn-close"
              onClick={onClose}
              aria-label="Close Horizon Scanner"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Telemetry Banner */}
        <div className="horizon-posture-banner">
          <div className="horizon-summary-text">
            {loading
              ? "Reconciling strategic multi-quarter milestones, weekly narrative deltas, and corporate filings..."
              : data?.strategicSummary || "Tracking active strategic technology and geopolitical horizons."}
          </div>
          <div className="horizon-telemetry-strip">
            <div className="horizon-telemetry-box">
              <div className="horizon-telemetry-val">
                {data?.activeDossiersCount ?? 0}
              </div>
              <div className="horizon-telemetry-label">Dossiers</div>
            </div>
            <div className="horizon-telemetry-box">
              <div className="horizon-telemetry-val" style={{ color: "#f87171" }}>
                {data?.inflectionsCount ?? 0}
              </div>
              <div className="horizon-telemetry-label">Inflections</div>
            </div>
          </div>
        </div>

        {/* Tabs Bar */}
        <div className="horizon-tabs-bar">
          {(data?.dossiers || []).map((d) => (
            <button
              key={d.id}
              type="button"
              className={`horizon-tab-btn ${currentDossier?.id === d.id ? "active" : ""}`}
              onClick={() => setActiveDossierId(d.id)}
            >
              <span>{getDomainIcon(d.domain)}</span>
              <span>{d.strategicTopic}</span>
            </button>
          ))}
        </div>

        {/* Body Content */}
        {currentDossier && (
          <div className="horizon-hud-body">
            {/* Dossier Header Card */}
            <div className="horizon-dossier-card">
              <div className="horizon-dossier-top">
                <h3 className="horizon-dossier-title">{currentDossier.strategicTopic}</h3>
                <div className="horizon-badges">
                  <span className={`horizon-badge ${getDossierStatusClass(currentDossier.status)}`}>
                    {currentDossier.status}
                  </span>
                  <span className="horizon-tag-pill">
                    Phase: {currentDossier.maturityPhase}
                  </span>
                  <span className="horizon-tag-pill">
                    Horizon: {currentDossier.horizonWindow}
                  </span>
                  <span className="horizon-tag-pill" style={{ color: "#22d3ee" }}>
                    Confidence: {currentDossier.confidenceScore}%
                  </span>
                </div>
              </div>

              <div className="horizon-thesis">
                <strong>Executive Strategic Thesis:</strong> {currentDossier.executiveThesis}
              </div>
            </div>

            {/* Weekly Delta Panel */}
            <div>
              <div className="horizon-section-heading">
                Weekly Narrative Delta & Inflections
              </div>
              <div className="horizon-delta-grid">
                <div className="horizon-delta-box">
                  <div className="horizon-delta-header inflection">
                    <span>⚡</span>
                    <span>Inflection Points This Week</span>
                  </div>
                  <ul className="horizon-delta-list">
                    {currentDossier.weeklyDelta.inflectionPointsThisWeek.map((inf, i) => (
                      <li key={i}>{inf}</li>
                    ))}
                  </ul>
                </div>

                <div className="horizon-delta-box">
                  <div className="horizon-delta-header invalidated">
                    <span>⚠️</span>
                    <span>Assumptions Invalidated</span>
                  </div>
                  <ul className="horizon-delta-list">
                    {currentDossier.weeklyDelta.invalidatedAssumptions.map((inv, i) => (
                      <li key={i}>{inv}</li>
                    ))}
                  </ul>
                </div>

                <div className="horizon-delta-box">
                  <div className="horizon-delta-header catalyst">
                    <span>🎯</span>
                    <span>Catalysts (Next 90 Days)</span>
                  </div>
                  <ul className="horizon-delta-list">
                    {currentDossier.weeklyDelta.catalystsNext90Days.map((cat, i) => (
                      <li key={i}>{cat}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Timeline Milestones */}
            <div className="horizon-timeline-container">
              <div className="horizon-section-heading">
                Strategic Roadmap & Verification Milestones
              </div>
              <div className="horizon-milestone-list">
                {currentDossier.milestones.map((m, idx) => (
                  <div
                    key={idx}
                    className={`horizon-milestone-item ${getMilestoneStatusClass(m.status)}`}
                  >
                    <div className="horizon-milestone-date">{m.date}</div>
                    <div className="horizon-milestone-body">
                      <div className="horizon-milestone-title">
                        [{m.status.toUpperCase()}] {m.milestone}
                      </div>
                      <div className="horizon-milestone-source">
                        Verified via: {m.verificationSource}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Key Watch Entities */}
            <div>
              <div className="horizon-section-heading">
                Core Monitored Ecosystem Entities
              </div>
              <div className="horizon-entities-strip">
                {currentDossier.keyWatchEntities.map((ent) => (
                  <span key={ent} className="horizon-entity-pill">
                    🏢 {ent}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
