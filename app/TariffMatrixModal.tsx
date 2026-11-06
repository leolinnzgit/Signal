import React, { useEffect, useState, useMemo } from "react";
import {
  TradeProfile,
  CorridorAdjustment,
  TariffSimulationResponse,
  fetchTradeProfiles,
  simulateTariffImpact,
  formatTariffDefenseDossier,
} from "./tariff-matrix.ts";
import "./tariff-matrix.css";

interface TariffMatrixModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TariffMatrixModal({ isOpen, onClose }: TariffMatrixModalProps) {
  const [profiles, setProfiles] = useState<TradeProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("semiconductors");
  const [usChinaRate, setUsChinaRate] = useState<number>(25);
  const [euChinaRate, setEuChinaRate] = useState<number>(18);
  const [apacUsRate, setApacUsRate] = useState<number>(8);
  const [usEuRate, setUsEuRate] = useState<number>(3);
  const [simulation, setSimulation] = useState<TariffSimulationResponse | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);

  // Load profiles
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadData() {
      try {
        const data = await fetchTradeProfiles();
        if (!isCancelled && data.length > 0) {
          setProfiles(data);
          if (!data.some((p) => p.id === selectedProfileId)) {
            setSelectedProfileId(data[0].id);
          }
        }
      } catch (err) {
        console.warn("Using default profiles:", err);
      }
    }

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  const activeProfile = useMemo(() => {
    return profiles.find((p) => p.id === selectedProfileId) || profiles[0];
  }, [profiles, selectedProfileId]);

  const corridors: CorridorAdjustment[] = useMemo(() => [
    { corridor: "us-china", tariffRatePercent: usChinaRate },
    { corridor: "eu-china", tariffRatePercent: euChinaRate },
    { corridor: "apac-us", tariffRatePercent: apacUsRate },
    { corridor: "us-eu", tariffRatePercent: usEuRate },
  ], [usChinaRate, euChinaRate, apacUsRate, usEuRate]);

  // Run simulation whenever profile or sliders change
  useEffect(() => {
    if (!isOpen || !activeProfile) return;
    let isCancelled = false;
    const timeout = setTimeout(async () => {
      try {
        setIsSimulating(true);
        const res = await simulateTariffImpact(activeProfile.id, corridors);
        if (!isCancelled) setSimulation(res);
      } catch (err) {
        console.error("Simulation failed:", err);
      } finally {
        if (!isCancelled) setIsSimulating(false);
      }
    }, 180);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [isOpen, activeProfile, corridors]);

  if (!isOpen) return null;

  const handleCopyMemo = async () => {
    if (!activeProfile || !simulation) return;
    const memo = formatTariffDefenseDossier(activeProfile, simulation, corridors);
    try {
      await navigator.clipboard.writeText(memo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="tariff-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="tariff-title">
      <div className="tariff-modal-container">
        {/* Header */}
        <div className="tariff-header">
          <div className="tariff-title-group">
            <span className="tariff-title-icon" aria-hidden="true">📊</span>
            <div>
              <h2 id="tariff-title" className="tariff-title">Global Tariff & Supply Arbitrage Matrix</h2>
              <p className="tariff-subtitle">Cross-border trade policy modeling, COGS sensitivity & FTA nearshoring arbitrage</p>
            </div>
          </div>
          <button
            type="button"
            className="tariff-close-btn"
            onClick={onClose}
            aria-label="Close Tariff Matrix"
          >
            ✕
          </button>
        </div>

        {/* Profile Selector Bar */}
        <div className="tariff-profile-bar">
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`profile-tab ${p.id === selectedProfileId ? "active" : ""}`}
              onClick={() => setSelectedProfileId(p.id)}
            >
              <span>{p.name.split(" ")[0]}</span>
              <span style={{ opacity: 0.7, fontSize: "0.7rem" }}>({p.hsCode})</span>
            </button>
          ))}
        </div>

        {/* Body Split */}
        <div className="tariff-body">
          {/* Controls Panel */}
          <div className="tariff-controls-panel">
            <div className="control-section-title">Trade Corridor Assumptions</div>

            {/* US - China */}
            <div className="slider-group">
              <div className="slider-header">
                <span>US ⇄ Mainland China</span>
                <span className="slider-rate-badge">{usChinaRate}%</span>
              </div>
              <input
                type="range"
                className="tariff-range-input"
                min="0"
                max="100"
                value={usChinaRate}
                onChange={(e) => setUsChinaRate(Number(e.target.value))}
              />
            </div>

            {/* EU - China */}
            <div className="slider-group">
              <div className="slider-header">
                <span>EU ⇄ Mainland China</span>
                <span className="slider-rate-badge">{euChinaRate}%</span>
              </div>
              <input
                type="range"
                className="tariff-range-input"
                min="0"
                max="60"
                value={euChinaRate}
                onChange={(e) => setEuChinaRate(Number(e.target.value))}
              />
            </div>

            {/* APAC - US */}
            <div className="slider-group">
              <div className="slider-header">
                <span>APAC ⇄ US (Friendshoring)</span>
                <span className="slider-rate-badge">{apacUsRate}%</span>
              </div>
              <input
                type="range"
                className="tariff-range-input"
                min="0"
                max="40"
                value={apacUsRate}
                onChange={(e) => setApacUsRate(Number(e.target.value))}
              />
            </div>

            {/* US - EU */}
            <div className="slider-group">
              <div className="slider-header">
                <span>Transatlantic (US ⇄ EU)</span>
                <span className="slider-rate-badge">{usEuRate}%</span>
              </div>
              <input
                type="range"
                className="tariff-range-input"
                min="0"
                max="30"
                value={usEuRate}
                onChange={(e) => setUsEuRate(Number(e.target.value))}
              />
            </div>

            {/* Sector Metadata Box */}
            {activeProfile && (
              <div style={{ marginTop: "0.5rem", background: "rgba(30, 41, 59, 0.4)", padding: "0.75rem", borderRadius: "6px" }}>
                <div style={{ fontSize: "0.7rem", color: "#94a3b8", textTransform: "uppercase" }}>
                  DUAL-USE EXPORT CONTROL ECCN
                </div>
                <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#f8fafc", marginTop: "0.15rem" }}>
                  {activeProfile.dualUseExportControlEccn}
                </div>
                <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.78rem", color: "#cbd5e1", lineHeight: 1.4 }}>
                  {activeProfile.executiveBrief}
                </p>
              </div>
            )}
          </div>

          {/* Results & Arbitrage Panel */}
          <div className="tariff-results-panel">
            {/* Telemetry Grid */}
            <div className="tariff-metrics-grid">
              <div className="tariff-metric-card">
                <div className="metric-card-label">Blended Effective Tariff</div>
                <div className="metric-card-val color-amber">
                  {simulation?.blendedEffectiveTariffPercent || 18.5}%
                </div>
              </div>
              <div className="tariff-metric-card">
                <div className="metric-card-label">Direct COGS Inflation</div>
                <div className="metric-card-val color-red">
                  +{simulation?.cogsImpactPercent || 8.6}%
                </div>
              </div>
              <div className="tariff-metric-card">
                <div className="metric-card-label">Margin Compression</div>
                <div className="metric-card-val color-red">
                  -{simulation?.ebitdaMarginCompressionBps || 320} bps
                </div>
              </div>
              <div className="tariff-metric-card">
                <div className="metric-card-label">Annualized P&L Impact</div>
                <div className="metric-card-val">
                  {simulation?.annualizedPnlVarianceUsd || "-$15.9M"}
                </div>
              </div>
            </div>

            {/* Arbitrage Re-routing Cards */}
            <div>
              <div className="control-section-title" style={{ color: "#34d399", marginBottom: "0.5rem" }}>
                Nearshore & Free Trade Agreement (FTA) Arbitrage Opportunities
              </div>
              <div className="arbitrage-cards-list">
                {(simulation?.arbitrageOptions || []).map((opt, idx) => (
                  <div key={idx} className="arbitrage-card">
                    <div className="arbitrage-card-header">
                      <span className="arbitrage-dest">📍 {opt.destination}</span>
                      <span className="arbitrage-badge">
                        +{opt.tariffRecoveryPercent}% Tariff Recovered
                      </span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#94a3b8" }}>
                      Trade Treaty: <strong>{opt.ftaAgreement}</strong> • Transit Delta: +{opt.leadTimeDeltaWeeks} weeks
                    </div>
                    <div className="arbitrage-rationale">{opt.strategicRationale}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Directives */}
            <div>
              <div className="control-section-title" style={{ marginBottom: "0.4rem" }}>
                Executive Defense Directives
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {(simulation?.executiveDirectives || []).map((dir, idx) => (
                  <div key={idx} style={{ fontSize: "0.8rem", color: "#cbd5e1", display: "flex", gap: "0.4rem" }}>
                    <span style={{ color: "#fbbf24" }}>▸</span>
                    <span>{dir}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="tariff-footer">
          <div style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
            {isSimulating ? "Recalculating corridor sensitivity..." : "Simulated based on global landed cost models."}
            {copied && <span style={{ marginLeft: "1rem", color: "#10b981", fontWeight: 600 }}>✓ Dossier Copied</span>}
          </div>
          <button
            type="button"
            className="tariff-export-btn"
            onClick={handleCopyMemo}
          >
            📋 Export Tariff Dossier
          </button>
        </div>
      </div>
    </div>
  );
}
