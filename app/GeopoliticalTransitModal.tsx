import React, { useEffect, useState, useMemo } from "react";
import {
  ChokepointZone,
  TransitAssessmentResponse,
  fetchChokepoints,
  assessChokepointTransit,
  projectCoordinatesToSvg,
  getThreatColor,
  formatTransitMemo,
} from "./geopolitical-transit.ts";
import "./geopolitical-transit.css";

interface GeopoliticalTransitModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
}

export function GeopoliticalTransitModal({
  isOpen,
  onClose,
  articles = [],
}: GeopoliticalTransitModalProps) {
  const [chokepoints, setChokepoints] = useState<ChokepointZone[]>([]);
  const [selectedId, setSelectedId] = useState<string>("bab-el-mandeb");
  const [assessment, setAssessment] = useState<TransitAssessmentResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const [filterAirspace, setFilterAirspace] = useState<boolean>(true);

  // Load chokepoints on mount or open
  useEffect(() => {
    if (!isOpen) return;
    let isCancelled = false;

    async function loadData() {
      try {
        setLoading(true);
        const data = await fetchChokepoints();
        if (!isCancelled && data.length > 0) {
          setChokepoints(data);
          if (!data.some((c) => c.id === selectedId)) {
            setSelectedId(data[0].id);
          }
        }
      } catch (err) {
        console.warn("Using fallback chokepoint data:", err);
      } finally {
        if (!isCancelled) setLoading(false);
      }
    }

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [isOpen]);

  // Load assessment whenever selectedId changes
  useEffect(() => {
    if (!isOpen || !selectedId) return;
    let isCancelled = false;

    async function loadAssessment() {
      try {
        const articleInputs = articles.slice(0, 5).map((a) => ({
          title: a.title,
          source: a.source,
          url: a.url,
          relevance: a.summary?.slice(0, 100) || "Breaking headline",
        }));
        const res = await assessChokepointTransit(selectedId, articleInputs);
        if (!isCancelled) setAssessment(res);
      } catch (err) {
        console.warn("Failed assessing transit, falling back:", err);
      }
    }

    loadAssessment();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, selectedId, articles]);

  const activeChokepoint = useMemo(() => {
    return chokepoints.find((c) => c.id === selectedId) || chokepoints[0];
  }, [chokepoints, selectedId]);

  if (!isOpen) return null;

  const handleCopyMemo = async () => {
    if (!activeChokepoint || !assessment) return;
    const memo = formatTransitMemo(activeChokepoint, assessment);
    try {
      await navigator.clipboard.writeText(memo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="transit-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="transit-title">
      <div className="transit-modal-container">
        {/* Header */}
        <div className="transit-header">
          <div className="transit-title-group">
            <span className="transit-title-icon" aria-hidden="true">🌐</span>
            <div>
              <h2 id="transit-title" className="transit-title">Signal Sky & Sea • Geopolitical Straits Watch</h2>
              <p className="transit-subtitle">Live maritime chokepoints, commercial detour penalties & NOTAM airspace cones</p>
            </div>
          </div>
          <button
            type="button"
            className="transit-close-btn"
            onClick={onClose}
            aria-label="Close Geopolitical Transit Watch"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="transit-body">
          {/* Map Section */}
          <div className="transit-map-wrapper">
            <div className="transit-map-hud-overlay">
              <span className="transit-map-hud-blip" aria-hidden="true" />
              <span>LIVE SATELLITE AIS MESH • 7 ARTERIAL STRAITS</span>
            </div>

            <svg
              className="transit-map-svg"
              viewBox="0 0 800 400"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Interactive world map showing geopolitical chokepoints"
            >
              {/* Simplified oceanic grid lines */}
              <defs>
                <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(56, 189, 248, 0.05)" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="800" height="400" fill="#030712" />
              <rect width="800" height="400" fill="url(#grid)" />

              {/* Equator & Meridians */}
              <line x1="0" y1="200" x2="800" y2="200" stroke="rgba(148, 163, 184, 0.15)" strokeDasharray="4 4" />
              <line x1="400" y1="0" x2="400" y2="400" stroke="rgba(148, 163, 184, 0.15)" strokeDasharray="4 4" />

              {/* Render Major Trade Routes */}
              <path
                d="M 580 230 Q 640 250 680 235 T 200 240"
                fill="none"
                stroke="rgba(56, 189, 248, 0.18)"
                strokeWidth="1.5"
                strokeDasharray="6 3"
              />
              <path
                d="M 460 210 Q 520 220 625 210"
                fill="none"
                stroke="rgba(56, 189, 248, 0.22)"
                strokeWidth="1.5"
                strokeDasharray="4 2"
              />

              {/* Render Airspace Advisory Cones if toggled */}
              {filterAirspace && (
                <g opacity="0.4">
                  {/* Red Sea advisory ellipse */}
                  <ellipse cx="496" cy="180" rx="35" ry="18" fill="rgba(239, 68, 68, 0.25)" stroke="#ef4444" strokeWidth="1" strokeDasharray="3 3" />
                  {/* Persian Gulf advisory */}
                  <ellipse cx="525" cy="148" rx="28" ry="14" fill="rgba(249, 115, 22, 0.25)" stroke="#f97316" strokeWidth="1" strokeDasharray="3 3" />
                  {/* Taiwan ADIZ */}
                  <ellipse cx="665" cy="155" rx="30" ry="18" fill="rgba(234, 179, 8, 0.25)" stroke="#eab308" strokeWidth="1" strokeDasharray="3 3" />
                </g>
              )}

              {/* Render Chokepoints */}
              {chokepoints.map((cp) => {
                const pt = projectCoordinatesToSvg(cp.coordinates[0], cp.coordinates[1], 800, 400);
                const colors = getThreatColor(cp.threatLevel);
                const isSelected = cp.id === selectedId;

                return (
                  <g
                    key={cp.id}
                    className={`transit-marker-node ${isSelected ? "transit-marker-selected" : ""}`}
                    onClick={() => setSelectedId(cp.id)}
                    tabIndex={0}
                    role="button"
                    aria-label={`${cp.name}: Threat ${cp.threatLevel}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedId(cp.id);
                    }}
                  >
                    {/* Generous touch target for mobile devices */}
                    <circle cx={pt.x} cy={pt.y} r="22" fill="transparent" pointerEvents="all" />
                    {/* Pulsing ring */}
                    <circle cx={pt.x} cy={pt.y} r={isSelected ? "14" : "10"} fill={colors.stroke} opacity="0.6">
                      <animate attributeName="r" values="8;18;8" dur="3s" repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.7;0.1;0.7" dur="3s" repeatCount="indefinite" />
                    </circle>
                    {/* Core node */}
                    <circle cx={pt.x} cy={pt.y} r={isSelected ? "6" : "4.5"} fill={colors.fill} stroke="#ffffff" strokeWidth={isSelected ? 2 : 1} />
                    {/* Label */}
                    <text
                      x={pt.x + 8}
                      y={pt.y + 4}
                      fill="#e2e8f0"
                      fontSize={isSelected ? "11" : "9"}
                      fontWeight={isSelected ? "700" : "500"}
                      fontFamily="system-ui, sans-serif"
                    >
                      {cp.name.split(" ")[0]}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Grid: List + Detail Inspection */}
          <div className="transit-content-grid">
            {/* Sidebar list */}
            <div className="transit-sidebar-list" role="list">
              {chokepoints.map((cp) => {
                const colors = getThreatColor(cp.threatLevel);
                const isSelected = cp.id === selectedId;
                return (
                  <div
                    key={cp.id}
                    className={`transit-chokepoint-card ${isSelected ? "active" : ""}`}
                    onClick={() => setSelectedId(cp.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedId(cp.id);
                    }}
                  >
                    <div className="chokepoint-card-header">
                      <span className="chokepoint-card-title">{cp.name}</span>
                      <span className={`chokepoint-threat-pill ${colors.badgeClass}`}>
                        {cp.threatLevel}
                      </span>
                    </div>
                    <div className="chokepoint-card-metrics">
                      <span>🚢 {cp.dailyTeuVolume.toLocaleString()} TEU/day</span>
                      <span>⏱️ +{cp.detourDays}d detour</span>
                      <span>✈️ {cp.airspaceStatus}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Inspection Detail Panel */}
            {activeChokepoint && (
              <div className="transit-inspection-panel">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <h3 style={{ margin: "0 0 0.25rem 0", color: "#f8fafc", fontSize: "1.1rem" }}>
                      {activeChokepoint.name}
                    </h3>
                    <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>{activeChokepoint.region}</span>
                  </div>
                  <span className={`chokepoint-threat-pill ${getThreatColor(activeChokepoint.threatLevel).badgeClass}`}>
                    THREAT: {activeChokepoint.threatLevel.toUpperCase()}
                  </span>
                </div>

                <p style={{ margin: 0, fontSize: "0.85rem", color: "#cbd5e1", lineHeight: 1.5 }}>
                  {activeChokepoint.strategicBrief}
                </p>

                {/* Telemetry Row */}
                <div className="transit-telemetry-row">
                  <div className="transit-telemetry-box">
                    <div className="telemetry-label">Transit Delay</div>
                    <div className="telemetry-value highlight-amber">+{activeChokepoint.detourDays} Days</div>
                  </div>
                  <div className="transit-telemetry-box">
                    <div className="telemetry-label">Bunker Fuel Delta</div>
                    <div className="telemetry-value highlight-red">+{activeChokepoint.fuelCostDeltaPercent}%</div>
                  </div>
                  <div className="transit-telemetry-box">
                    <div className="telemetry-label">Daily Oil Flow</div>
                    <div className="telemetry-value highlight-cyan">{activeChokepoint.dailyOilBarrelsMbpd} Mbpd</div>
                  </div>
                  <div className="transit-telemetry-box">
                    <div className="telemetry-label">Trade Value At Risk</div>
                    <div className="telemetry-value">{assessment?.estimatedDailyTradeDisruptionUsd || "$2.4B/day"}</div>
                  </div>
                </div>

                {/* NOTAM & Airspace */}
                <div>
                  <div className="transit-section-title">Active Airspace Advisories & NOTAMs</div>
                  <div className="transit-notams-list">
                    {activeChokepoint.activeNotams.map((notam, idx) => (
                      <div key={idx} className="notam-item">
                        {notam}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Executive Actions */}
                <div>
                  <div className="transit-section-title">Strategic Mitigation Directives</div>
                  <div className="transit-actions-list">
                    {(assessment?.executiveActionItems || [
                      "Lock in 45-day bunker fuel futures hedges.",
                      "Advance European delivery windows to compensate for transit delay.",
                      "Audit war risk hull & machinery insurance coverage.",
                    ]).map((action, idx) => (
                      <div key={idx} className="transit-action-item">
                        <span className="transit-action-bullet">▸</span>
                        <span>{action}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="transit-footer">
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <label style={{ fontSize: "0.78rem", color: "#94a3b8", display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={filterAirspace}
                onChange={(e) => setFilterAirspace(e.target.checked)}
              />
              Show NOTAM Air Cones
            </label>
            {copied && <span className="transit-copied-pill">✓ Memo Copied to Clipboard</span>}
          </div>

          <button
            type="button"
            className="transit-export-btn"
            onClick={handleCopyMemo}
          >
            📋 Copy Strategic Memo
          </button>
        </div>
      </div>
    </div>
  );
}
