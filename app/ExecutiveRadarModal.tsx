"use client";

import React, { useState, useEffect } from "react";
import {
  scanExecutiveRadar,
  type RadarAnomaly,
  type RadarScanResponse,
} from "./executive-radar";
import "./executive-radar.css";

export interface ExecutiveRadarModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; publishedAt?: string }>;
  markets?: Array<{ symbol: string; name: string; price: number; changePercent?: number; percentChange?: number }>;
  onStageDossierArticle?: (article: { title: string; source: string; url: string }) => void;
}

export default function ExecutiveRadarModal({
  isOpen,
  onClose,
  articles = [],
  markets = [],
  onStageDossierArticle,
}: ExecutiveRadarModalProps) {
  const [data, setData] = useState<RadarScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [stagedIds, setStagedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    const abort = new AbortController();

    void scanExecutiveRadar(articles, markets, 45, abort.signal).then((res) => {
      setData(res);
      setLoading(false);
    });

    return () => abort.abort();
  }, [articles, isOpen, markets]);

  if (!isOpen) return null;

  const handleStage = (anomaly: RadarAnomaly) => {
    setStagedIds((prev) => new Set(prev).add(anomaly.id));
    if (onStageDossierArticle) {
      onStageDossierArticle({
        title: anomaly.headline,
        source: anomaly.sources[0] || "Executive Radar",
        url: "",
      });
    }
  };

  return (
    <div
      className="radar-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="radar-modal-title"
    >
      <div className="radar-card">
        {/* Header */}
        <header className="radar-header">
          <div>
            <div className="radar-kicker-row">
              <span className="radar-kicker">📡 REAL-TIME ANOMALY DETECTOR</span>
              <span className="radar-pulse-dot" />
            </div>
            <h2 id="radar-modal-title" className="radar-title">
              Executive Velocity &amp; Market Shock Radar
            </h2>
          </div>
          <button
            type="button"
            className="radar-close-btn"
            onClick={onClose}
            aria-label="Close Executive Radar"
          >
            ✕
          </button>
        </header>

        {/* HUD Bar */}
        <div className="radar-hud-bar">
          <div className="radar-hud-stat">
            <span>Active Anomalies:</span>
            <strong>{data?.anomalyCount ?? 0}</strong>
          </div>
          <div className="radar-hud-stat">
            <span>Monitored Window:</span>
            <strong>Past 45 mins</strong>
          </div>
          <div className="radar-hud-stat">
            <span>Sensors:</span>
            <strong>Publication Velocity + Intraday Divergence</strong>
          </div>
        </div>

        {/* Anomalies List */}
        <div className="radar-anomalies-grid" role="feed" aria-label="Detected Anomalies">
          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem", color: "#94a3b8" }}>
              Scanning wire traffic and asset order flow...
            </div>
          ) : data && data.anomalies.length > 0 ? (
            data.anomalies.map((item) => {
              const sevClass = item.severity.toLowerCase();
              const isStaged = stagedIds.has(item.id);

              return (
                <article
                  key={item.id}
                  className={`radar-anomaly-card ${sevClass}`}
                >
                  <div className="radar-card-top">
                    <span className="radar-type-pill">
                      {item.anomalyType === "velocity_spike" ? "⚡ Velocity Spike" : "📊 Macro Divergence"}
                    </span>
                    <span className="radar-velocity-pill">
                      {item.anomalyType === "velocity_spike"
                        ? `${item.velocityScore}x burst / ${item.timeWindowMinutes}m`
                        : `${item.priceChangePercent && item.priceChangePercent > 0 ? "+" : ""}${item.priceChangePercent}% shift`}
                    </span>
                  </div>

                  <h3 className="radar-headline">{item.headline}</h3>
                  <p className="radar-summary">{item.summary}</p>

                  <footer className="radar-card-footer">
                    <div className="radar-sources-list">
                      {item.sources.map((src) => (
                        <span key={src} className="radar-source-tag">{src}</span>
                      ))}
                    </div>
                    {onStageDossierArticle && (
                      <button
                        type="button"
                        className="radar-action-btn"
                        onClick={() => handleStage(item)}
                        disabled={isStaged}
                      >
                        {isStaged ? "✓ Staged for Dossier" : "+ Stage for Dossier"}
                      </button>
                    )}
                  </footer>
                </article>
              );
            })
          ) : (
            <div style={{ textAlign: "center", padding: "3rem", color: "#94a3b8" }}>
              All monitored wires and sector benchmarks within standard variance parameters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
