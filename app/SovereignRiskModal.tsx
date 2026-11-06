import React, { useState, useEffect } from 'react';
import {
  SovereignEconomy,
  SovereignAssessResponse,
  fetchSovereignEconomies,
  assessSovereignRisk,
  formatSovereignRiskReport,
  getSovereignRiskColor,
  FALLBACK_ECONOMIES
} from './sovereign-risk';
import './sovereign-risk.css';

interface SovereignRiskModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SovereignRiskModal: React.FC<SovereignRiskModalProps> = ({ isOpen, onClose }) => {
  const [economies, setEconomies] = useState<SovereignEconomy[]>(FALLBACK_ECONOMIES);
  const [selectedEconomyId, setSelectedEconomyId] = useState<string>('argentina');
  const [exposureUsd, setExposureUsd] = useState<number>(10000000);
  const [assessment, setAssessment] = useState<SovereignAssessResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    fetchSovereignEconomies().then(data => {
      if (isMounted && data.length > 0) {
        setEconomies(data);
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      isMounted = false;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setIsLoading(true);
    assessSovereignRisk({ economyId: selectedEconomyId, corporateExposureUsd: exposureUsd })
      .then(res => {
        if (isMounted) {
          setAssessment(res);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, selectedEconomyId, exposureUsd]);

  if (!isOpen) return null;

  const currentEconomy = economies.find(e => e.id === selectedEconomyId) || economies[0];

  const handleCopyReport = async () => {
    if (!assessment) return;
    const text = formatSovereignRiskReport(assessment);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      className="sovereign-risk-modal-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Sovereign Risk & Currency Crisis Radar"
    >
      <div className="sovereign-risk-modal">
        {/* Header */}
        <div className="sovereign-risk-header">
          <div className="sovereign-risk-header-title">
            <div className="sovereign-risk-icon-pill" aria-hidden="true">🏛️</div>
            <div>
              <h2>Sovereign Risk & Currency Crisis Radar</h2>
              <p>Macro FX velocity, CDS spreads, capital controls & treasury repatriation haircuts</p>
            </div>
          </div>
          <button
            className="sovereign-risk-close-btn"
            onClick={onClose}
            aria-label="Close Sovereign Risk Radar"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="sovereign-risk-body">
          {/* Economy Selector Carousel */}
          <div className="sovereign-economy-bar" role="tablist" aria-label="Target Economies">
            {economies.map(econ => (
              <button
                key={econ.id}
                role="tab"
                aria-selected={selectedEconomyId === econ.id}
                className={`sovereign-economy-chip ${selectedEconomyId === econ.id ? 'active' : ''}`}
                onClick={() => setSelectedEconomyId(econ.id)}
              >
                <span>{econ.name}</span>
                <span
                  className="sovereign-economy-chip-score"
                  style={{ color: getSovereignRiskColor(econ.sovereignRiskScore) }}
                >
                  {econ.sovereignRiskScore}
                </span>
              </button>
            ))}
          </div>

          {/* Macro Brief */}
          <div className="sovereign-brief-banner">
            <strong>Macro Context:</strong> {currentEconomy.macroBrief}
          </div>

          {/* 4 Telemetry Metrics */}
          <div className="sovereign-metrics-grid">
            <div className="sovereign-metric-card">
              <span className="label">Risk Index</span>
              <span
                className="value"
                style={{ color: getSovereignRiskColor(currentEconomy.sovereignRiskScore) }}
              >
                {currentEconomy.sovereignRiskScore}/100
              </span>
              <span className="detail">Composite sovereign score</span>
            </div>

            <div className="sovereign-metric-card">
              <span className="label">5Y CDS Spread</span>
              <span className="value">{currentEconomy.cdsSpreadBps} bps</span>
              <span className="detail">Debt default insurance cost</span>
            </div>

            <div className="sovereign-metric-card">
              <span className="label">30d FX Velocity</span>
              <span
                className="value"
                style={{
                  color: currentEconomy.fx30dDepreciationVelocityPercent < -10
                    ? 'var(--danger-color, #ef4444)'
                    : currentEconomy.fx30dDepreciationVelocityPercent < -5
                    ? 'var(--warning-color, #f59e0b)'
                    : 'inherit'
                }}
              >
                {currentEconomy.fx30dDepreciationVelocityPercent > 0 ? '+' : ''}
                {currentEconomy.fx30dDepreciationVelocityPercent}%
              </span>
              <span className="detail">vs USD rolling depreciation</span>
            </div>

            <div className="sovereign-metric-card">
              <span className="label">Reserves Cover</span>
              <span className="value">{currentEconomy.foreignReservesCoverMonths} mo</span>
              <span className="detail">
                {currentEconomy.foreignReservesCoverMonths < 3 ? '⚠️ Below IMF safety buffer' : 'Adequate import cover'}
              </span>
            </div>
          </div>

          {/* Haircut & Exposure Loss Simulator */}
          <div className="sovereign-haircut-card">
            <div className="sovereign-haircut-top">
              <h3>
                <span>⚡ Capital Repatriation Stress Model</span>
                <span style={{ fontSize: '0.8rem', fontWeight: 400, color: 'var(--text-muted, #9ca3af)' }}>
                  ({currentEconomy.capitalControlStatus})
                </span>
              </h3>
              {assessment && (
                <div className="sovereign-loss-badge">
                  Est. Capital Loss: {assessment.estimatedExposureLossUsd} ({assessment.repatriationHaircutPercent}%)
                </div>
              )}
            </div>

            <div className="sovereign-slider-wrap">
              <div className="sovereign-slider-labels">
                <span>Corporate Onshore Exposure: <strong>${(exposureUsd / 1000000).toFixed(1)}M USD</strong></span>
                <span>Max $100M</span>
              </div>
              <input
                type="range"
                className="sovereign-slider"
                min={1000000}
                max={100000000}
                step={1000000}
                value={exposureUsd}
                onChange={e => setExposureUsd(Number(e.target.value))}
                aria-label="Corporate Exposure in USD"
              />
            </div>
          </div>

          {/* Treasury Action Playbooks */}
          {assessment && (
            <div className="sovereign-playbooks-wrap">
              <h3>Recommended Treasury Action Playbooks</h3>
              {assessment.treasuryActionPlaybooks.map((playbook, idx) => (
                <div key={idx} className="sovereign-playbook-item">
                  <span className="sovereign-playbook-num">{idx + 1}</span>
                  <span>{playbook}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sovereign-risk-footer">
          <div className="sovereign-footer-status">
            {isLoading ? 'Assessing sovereign macro telemetry...' : `Live Radar: ${currentEconomy.name} (${currentEconomy.currencyCode})`}
          </div>
          <button
            className="sovereign-export-btn"
            onClick={handleCopyReport}
          >
            {copied ? '✓ Brief Copied to Clipboard' : '📋 Copy Treasury Brief'}
          </button>
        </div>
      </div>
    </div>
  );
};
