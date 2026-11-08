import React, { useState, useEffect } from 'react';
import {
  PreMortemInitiative,
  PreMortemDossier,
  FALLBACK_INITIATIVES,
  fetchPreMortemInitiatives,
  simulatePreMortem,
  formatPreMortemDossier,
  getSeverityBadgeClass
} from './pre-mortem';
import './pre-mortem.css';

interface PreMortemModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialInitiativeId?: string;
}

export const PreMortemModal: React.FC<PreMortemModalProps> = ({
  isOpen,
  onClose,
  initialInitiativeId,
}) => {
  const [initiatives, setInitiatives] = useState<PreMortemInitiative[]>(FALLBACK_INITIATIVES);
  const [selectedInitiativeId, setSelectedInitiativeId] = useState<string>(
    initialInitiativeId || 'ai-cloud-migration'
  );
  const [horizonMonths, setHorizonMonths] = useState<number>(18);
  const [dossier, setDossier] = useState<PreMortemDossier | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen && initialInitiativeId) {
      setSelectedInitiativeId(initialInitiativeId.toLowerCase());
    }
  }, [isOpen, initialInitiativeId]);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    fetchPreMortemInitiatives().then(data => {
      if (isMounted && data.length > 0) {
        setInitiatives(data);
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
    simulatePreMortem({ initiativeId: selectedInitiativeId, horizonMonths })
      .then(res => {
        if (isMounted) {
          setDossier(res);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, selectedInitiativeId, horizonMonths]);

  if (!isOpen) return null;

  const currentInitiative = initiatives.find(i => i.id === selectedInitiativeId) || initiatives[0];

  const handleCopy = async () => {
    if (!dossier) return;
    const text = formatPreMortemDossier(dossier);
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
      className="pre-mortem-modal-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Corporate Pre-Mortem Simulator"
    >
      <div className="pre-mortem-modal">
        {/* Header */}
        <div className="pre-mortem-header">
          <div className="pre-mortem-header-title">
            <div className="pre-mortem-icon-pill" aria-hidden="true">⚔️</div>
            <div>
              <h2>Corporate "Pre-Mortem" Simulator ("Kill The Company")</h2>
              <p>Adversarial failure cascade modeling, early warning indicators & boardroom hedging directives</p>
            </div>
          </div>
          <button
            className="pre-mortem-close-btn"
            onClick={onClose}
            aria-label="Close Pre-Mortem Simulator"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="pre-mortem-body">
          {/* Initiative Picker */}
          <div className="pre-mortem-initiatives-list">
            {initiatives.map(init => (
              <button
                key={init.id}
                type="button"
                className={`pre-mortem-initiative-btn ${selectedInitiativeId === init.id ? 'active' : ''}`}
                onClick={() => setSelectedInitiativeId(init.id)}
              >
                <div className="pre-mortem-initiative-title">{init.title}</div>
                <div className="pre-mortem-initiative-meta">
                  <span>{init.capitalAtStakeUsd}</span>
                  <span>Risk: {init.baselineRiskScore}/100</span>
                </div>
              </button>
            ))}
          </div>

          {/* Controls: Horizon Slider */}
          <div className="pre-mortem-controls">
            <div className="pre-mortem-horizon-wrap">
              <span className="pre-mortem-horizon-label">
                Failure Horizon: <strong>+{horizonMonths} Months</strong>
              </span>
              <input
                type="range"
                className="pre-mortem-slider"
                min={6}
                max={36}
                step={6}
                value={horizonMonths}
                onChange={e => setHorizonMonths(Number(e.target.value))}
                aria-label="Failure Horizon in Months"
              />
            </div>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted, #9ca3af)' }}>
              Category: <strong style={{ color: 'var(--text-primary, #ffffff)' }}>{currentInitiative.category}</strong>
            </div>
          </div>

          {/* Autopsy Scenario & Fatality Probability */}
          {dossier && (
            <div className="pre-mortem-autopsy-card">
              <div className="pre-mortem-autopsy-header">
                <div className="pre-mortem-autopsy-title">
                  <span>💀 Simulated Failure Autopsy</span>
                </div>
                <div className="pre-mortem-fatality-tag">
                  Fatality Probability: {dossier.overallFatalityProbabilityPercent}%
                </div>
              </div>
              <p className="pre-mortem-autopsy-text">{dossier.executiveSummaryAutopsy}</p>
            </div>
          )}

          {/* Board Directive */}
          {dossier && (
            <div className="pre-mortem-board-directive">
              <strong>Governance Directive:</strong> {dossier.boardRecommendation}
            </div>
          )}

          {/* Live Risk Wires */}
          {dossier?.liveRiskSignals && dossier.liveRiskSignals.length > 0 && (
            <div className="pre-mortem-board-directive" style={{ borderColor: 'rgba(239, 68, 68, 0.4)' }}>
              <strong>🔴 Live EWI Wire Matches ({dossier.liveRiskSignals.length}):</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {dossier.liveRiskSignals.map((sig, i) => (
                  <li key={i} style={{ marginBottom: '4px' }}>
                    <strong>{sig.source}:</strong> {sig.title} <em>({sig.matchedVector})</em>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Collapse Vectors */}
          {dossier && (
            <div className="pre-mortem-vectors-container">
              <h3>Adversarial Collapse Vectors & Early Warning Indicators</h3>
              {dossier.collapseVectors.map(vec => (
                <div key={vec.vectorId} className="pre-mortem-vector-card">
                  <div className="pre-mortem-vector-head">
                    <span className="pre-mortem-vector-name">{vec.name}</span>
                    <span className={getSeverityBadgeClass(vec.severity)}>{vec.severity}</span>
                  </div>

                  <p className="pre-mortem-mechanism">{vec.failureMechanism}</p>

                  <div className="pre-mortem-ewi-box">
                    <span className="pre-mortem-ewi-title">Early Warning Indicators (EWIs):</span>
                    <div className="pre-mortem-ewi-list">
                      {vec.earlyWarningIndicators.map((ewi, i) => (
                        <span key={i} className="pre-mortem-ewi-tag">⚠️ {ewi}</span>
                      ))}
                    </div>
                  </div>

                  <div className="pre-mortem-hedging-box">
                    <strong>🛡️ Pre-Emptive Hedging Directive:</strong> {vec.preemptiveHedgingDirective}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pre-mortem-footer">
          <div className="pre-mortem-footer-status">
            {isLoading ? 'Running Monte-Carlo failure cascade...' : `Target: ${currentInitiative.title}`}
          </div>
          <button
            className="pre-mortem-export-btn"
            onClick={handleCopy}
          >
            {copied ? '✓ Dossier Copied' : '📑 Export Boardroom Dossier'}
          </button>
        </div>
      </div>
    </div>
  );
};
