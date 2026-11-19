"use client";

import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "./listening-break";
import React, { useState, useEffect, useRef } from "react";
import {
  fetchSupplyChainStatus,
  formatSupplyChainDigest,
  type SupplyChainResponse,
  type Chokepoint,
} from "./supply-chain";
import { openArticleAudioStream } from "./article-audio-stream";
import { resolveUserReadingVoice } from "./headline-audio";
import "./supply-chain.css";

export interface SupplyChainModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  preferredVoice?: string;
}

const REGION_FILTERS = [
  "All Corridors",
  "Middle East",
  "Southeast Asia",
  "East Asia",
  "Americas",
  "Europe & Africa",
];

export default function SupplyChainModal({
  isOpen,
  onClose,
  articles = [],
  preferredVoice,
}: SupplyChainModalProps) {
  const activeVoice = preferredVoice || resolveUserReadingVoice();
  const [data, setData] = useState<SupplyChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState("All Corridors");
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

  const loadStatus = async () => {
    setLoading(true);
    setCopyFeedback("");
    try {
      const res = await fetchSupplyChainStatus({ articles });
      setData(res);
    } catch {
      // Degrade gracefully
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data) return;
    const text = formatSupplyChainDigest(data);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Supply chain intelligence copied to clipboard!");
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

  const filteredChokepoints = (data?.chokepoints || []).filter((c) => {
    if (selectedRegion === "All Corridors") return true;
    if (selectedRegion === "Middle East") return c.region.includes("Middle East") || c.region.includes("Persian Gulf");
    if (selectedRegion === "Southeast Asia") return c.region.includes("Southeast Asia");
    if (selectedRegion === "East Asia") return c.region.includes("East Asia");
    if (selectedRegion === "Americas") return c.region.includes("America");
    if (selectedRegion === "Europe & Africa") return c.region.includes("Europe") || c.region.includes("Africa");
    return true;
  });

  return (
    <div className="supply-chain-backdrop" role="dialog" aria-modal="true" aria-labelledby="supply-chain-title">
      <div className="supply-chain-modal">
        <div className="supply-chain-header">
          <h2 id="supply-chain-title" className="supply-chain-title">
            🚢 Supply Chain &amp; Trade Chokepoint Tracker
          </h2>
          <button
            type="button"
            className="supply-chain-close-btn"
            onClick={onClose}
            aria-label="Close Supply Chain Tracker"
          >
            &times;
          </button>
        </div>

        <div className="supply-chain-body">
          {loading && !data ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem", color: "#94a3b8" }}>
              Analyzing global maritime choke corridors &amp; logistics exposure...
            </div>
          ) : data ? (
            <>
              {/* Macro Exposure Banner */}
              <div className="supply-chain-banner">
                <div className="supply-chain-score-cluster">
                  <div className="supply-chain-score-dial">{data.compositeExposureIndex}</div>
                  <div className="supply-chain-score-meta">
                    <div className="supply-chain-score-label">{data.exposureLabel}</div>
                    <div className="supply-chain-score-sub">
                      Composite Global Vulnerability Index (Scale: 0-100)
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: "0.8rem", color: "#94a3b8", textAlign: "right" }}>
                  <span>Updated: {new Date(data.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              </div>

              {/* Sector Exposure Breakdown */}
              <div>
                <div className="supply-chain-section-title">Critical Category Vulnerability</div>
                <div className="supply-vulnerability-grid">
                  <div className="supply-vuln-card">
                    <div className="supply-vuln-val" style={{ color: "#ef4444" }}>
                      {data.exposure.freightAndTransit}
                    </div>
                    <div className="supply-vuln-label">Freight &amp; Transit Delay</div>
                  </div>
                  <div className="supply-vuln-card">
                    <div className="supply-vuln-val" style={{ color: "#f59e0b" }}>
                      {data.exposure.energyAndFuel}
                    </div>
                    <div className="supply-vuln-label">Energy, Crude &amp; LNG</div>
                  </div>
                  <div className="supply-vuln-card">
                    <div className="supply-vuln-val" style={{ color: "#38bdf8" }}>
                      {data.exposure.electronicsAndChips}
                    </div>
                    <div className="supply-vuln-label">Chips &amp; Electronics</div>
                  </div>
                  <div className="supply-vuln-card">
                    <div className="supply-vuln-val" style={{ color: "#10b981" }}>
                      {data.exposure.agriCommodities}
                    </div>
                    <div className="supply-vuln-label">Grains &amp; Agriculture</div>
                  </div>
                </div>
              </div>

              {/* Audio Strip */}
              <div className="supply-chain-audio-bar">
                <div className="supply-chain-audio-info">
                  🔊 <strong>Executive Neural Audio Brief:</strong> Maritime Corridors &amp; Re-routing Impact
                </div>
                <button
                  type="button"
                  className="supply-chain-audio-btn"
                  onClick={() => void handleToggleAudio()}
                  title="Listen using Azure Neural Voice"
                >
                  {isPlayingAudio ? "⏹ Stop Briefing" : "▶ Listen via Azure Neural"}
                </button>
              </div>

              {/* Regional Filter Chips */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                {REGION_FILTERS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    style={{
                      background: selectedRegion === r ? "#0284c7" : "rgba(255,255,255,0.06)",
                      border: "1px solid " + (selectedRegion === r ? "#38bdf8" : "rgba(255,255,255,0.12)"),
                      color: selectedRegion === r ? "#fff" : "#cbd5e1",
                      borderRadius: "9999px",
                      padding: "0.35rem 0.8rem",
                      fontSize: "0.8rem",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={() => setSelectedRegion(r)}
                  >
                    {r}
                  </button>
                ))}
              </div>

              {/* Chokepoint Cards */}
              <div>
                <div className="supply-chain-section-title">Strategic Maritime Chokepoints</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {filteredChokepoints.map((cp) => (
                    <div
                      key={cp.id}
                      className={`supply-chokepoint-card ${cp.status.toLowerCase()}`}
                    >
                      <div className="supply-chokepoint-header">
                        <div>
                          <div className="supply-chokepoint-name">{cp.name}</div>
                          <div className="supply-chokepoint-region">{cp.region} &bull; Risk: {cp.riskScore}/100</div>
                        </div>
                        <span className={`supply-status-badge ${cp.status.toLowerCase()}`}>
                          {cp.status}
                        </span>
                      </div>

                      <div className="supply-details-grid">
                        <div className="supply-detail-item">
                          <strong>Global Volume:</strong> {cp.dailyVolumeShare}
                        </div>
                        <div className="supply-detail-item">
                          <strong>Re-routing Delay:</strong> +{cp.extraTransitDays} days ({cp.alternativeRoute})
                        </div>
                        <div className="supply-detail-item">
                          <strong>Primary Hazards:</strong> {cp.primaryHazards.join(", ")}
                        </div>
                        <div className="supply-detail-item">
                          <strong>Key Cargoes:</strong> {cp.impactedCommodities.join(", ")}
                        </div>
                      </div>

                      {cp.incidents && cp.incidents.length > 0 && (
                        <div style={{ fontSize: "0.8rem", color: "#e2e8f0", background: "rgba(15,23,42,0.6)", padding: "0.4rem 0.65rem", borderRadius: "0.375rem" }}>
                          ⚡ <strong>Latest Event:</strong> {cp.incidents[0].headline} <span style={{ color: "#94a3b8" }}>({cp.incidents[0].source} &bull; {cp.incidents[0].date})</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Ocean Carrier Action Advisories */}
              <div>
                <div className="supply-chain-section-title">Ocean Carrier Rerouting &amp; Surcharges</div>
                <div className="supply-carrier-list">
                  {data.carrierAlerts.map((ca, idx) => (
                    <div key={idx} className="supply-carrier-item">
                      <div>
                        <span className="supply-carrier-name">{ca.carrier}:</span>{" "}
                        <span className="supply-carrier-action">{ca.action} ({ca.impactedRoute})</span>
                      </div>
                      <div className="supply-carrier-surcharge">{ca.surcharge}</div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "2rem", color: "#f87171" }}>
              Unable to load supply chain intelligence feed.
            </div>
          )}
        </div>

        <div className="supply-chain-footer">
          <div>
            {copyFeedback && <span className="supply-chain-copy-feedback">{copyFeedback}</span>}
          </div>
          <button
            type="button"
            className="supply-chain-copy-btn"
            onClick={() => void handleCopy()}
            disabled={!data}
          >
            📋 Copy Supply Chain Brief
          </button>
        </div>
      </div>
    </div>
  );
}
