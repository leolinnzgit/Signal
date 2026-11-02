"use client";

import React, { useState, useEffect } from "react";
import {
  loadQuietHoursConfig,
  saveQuietHoursConfig,
  DEFAULT_QUIET_HOURS,
  type QuietHoursConfig,
} from "./quiet-hours";
import "./quiet-hours.css";

export interface QuietHoursModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfigChanged?: (config: QuietHoursConfig) => void;
}

export default function QuietHoursModal({
  isOpen,
  onClose,
  onConfigChanged,
}: QuietHoursModalProps) {
  const [config, setConfig] = useState<QuietHoursConfig>(DEFAULT_QUIET_HOURS);
  const [newVip, setNewVip] = useState("");
  const [savedFeedback, setSavedFeedback] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    void loadQuietHoursConfig().then((cfg) => setConfig(cfg));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = async () => {
    await saveQuietHoursConfig(config);
    if (onConfigChanged) onConfigChanged(config);
    setSavedFeedback("Preferences saved!");
    setTimeout(() => {
      setSavedFeedback("");
      onClose();
    }, 1200);
  };

  const handleAddVip = (e: React.FormEvent) => {
    e.preventDefault();
    const val = newVip.trim();
    if (!val || config.vipEntities.includes(val)) return;
    setConfig((prev) => ({
      ...prev,
      vipEntities: [...prev.vipEntities, val],
    }));
    setNewVip("");
  };

  const handleRemoveVip = (vipToRemove: string) => {
    setConfig((prev) => ({
      ...prev,
      vipEntities: prev.vipEntities.filter((v) => v !== vipToRemove),
    }));
  };

  return (
    <div className="quiet-hours-backdrop" role="dialog" aria-modal="true" aria-labelledby="quiet-modal-title">
      <div className="quiet-hours-modal">
        <header className="quiet-hours-header">
          <h2 id="quiet-modal-title" className="quiet-hours-title">
            🌙 Quiet Hours & VIP Crisis Threshold
          </h2>
          <button
            type="button"
            className="quiet-hours-close-btn"
            onClick={onClose}
            aria-label="Close quiet hours settings"
          >
            &times;
          </button>
        </header>

        <div className="quiet-hours-body">
          <div className="quiet-hours-toggle-row">
            <div>
              <h3 className="quiet-hours-toggle-title">Enable Quiet Hours Triage</h3>
              <p className="quiet-hours-toggle-sub">
                Suppress non-urgent news to tomorrow morning&apos;s Daily Briefing pack.
              </p>
            </div>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
              style={{ width: "1.25rem", height: "1.25rem", cursor: "pointer" }}
              aria-label="Enable Quiet Hours"
            />
          </div>

          <div className="quiet-hours-time-row">
            <div className="quiet-hours-time-field">
              <label className="quiet-hours-time-label">Quiet Hours Start</label>
              <input
                type="time"
                className="quiet-hours-time-input"
                value={config.startTime}
                onChange={(e) => setConfig((prev) => ({ ...prev, startTime: e.target.value }))}
              />
            </div>
            <div className="quiet-hours-time-field">
              <label className="quiet-hours-time-label">Wake-Up Briefing Resume</label>
              <input
                type="time"
                className="quiet-hours-time-input"
                value={config.endTime}
                onChange={(e) => setConfig((prev) => ({ ...prev, endTime: e.target.value }))}
              />
            </div>
          </div>

          <div className="quiet-hours-slider-row">
            <div className="quiet-hours-slider-header">
              <div>
                <strong style={{ fontSize: "0.95rem" }}>Market Shock Breakthrough Threshold</strong>
                <p style={{ margin: "0.2rem 0 0 0", fontSize: "0.8rem", color: "#94a3b8" }}>
                  Only price movements equal to or exceeding this threshold will alert during quiet hours.
                </p>
              </div>
              <span className="quiet-hours-slider-val">&plusmn;{config.shockThresholdPercent}%</span>
            </div>
            <input
              type="range"
              min="1.0"
              max="5.0"
              step="0.5"
              value={config.shockThresholdPercent}
              onChange={(e) => setConfig((prev) => ({ ...prev, shockThresholdPercent: parseFloat(e.target.value) }))}
              style={{ accentColor: "#60a5fa", cursor: "pointer" }}
              aria-label="Market Shock Breakthrough Threshold"
            />
          </div>

          <div className="quiet-hours-vip-box">
            <div>
              <strong style={{ fontSize: "0.95rem" }}>VIP Monitored Entities (Crisis Breakthrough)</strong>
              <p style={{ margin: "0.2rem 0 0 0", fontSize: "0.8rem", color: "#94a3b8" }}>
                Breaking regulatory probes, trading halts, or investigations regarding these entities break through quiet hours.
              </p>
            </div>

            <div className="quiet-hours-vip-tags">
              {config.vipEntities.map((vip, idx) => (
                <span key={idx} className="quiet-hours-vip-tag">
                  {vip}
                  <button
                    type="button"
                    className="quiet-hours-vip-remove-btn"
                    onClick={() => handleRemoveVip(vip)}
                    title={`Remove ${vip}`}
                  >
                    &times;
                  </button>
                </span>
              ))}
            </div>

            <form className="quiet-hours-vip-input-row" onSubmit={handleAddVip}>
              <input
                type="text"
                className="quiet-hours-vip-input"
                placeholder="Add VIP company, regulator or ticker..."
                value={newVip}
                onChange={(e) => setNewVip(e.target.value)}
              />
              <button type="submit" className="quiet-hours-vip-add-btn">
                + Add VIP
              </button>
            </form>
          </div>
        </div>

        <footer className="quiet-hours-footer">
          {savedFeedback ? (
            <span style={{ color: "#4ade80", fontSize: "0.85rem", fontWeight: 600 }}>{savedFeedback}</span>
          ) : (
            <span style={{ color: "#64748b", fontSize: "0.8rem" }}>
              Silently batches evening noise while preserving crisis alerts
            </span>
          )}
          <button type="button" className="quiet-hours-save-btn" onClick={handleSave}>
            Save Preferences
          </button>
        </footer>
      </div>
    </div>
  );
}
