"use client";

import React, { useState } from "react";
import {
  compileCSuiteReportData,
  formatCSuiteSummaryText,
} from "./csuite-report";
import "./csuite-report.css";

export interface CSuiteReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  briefing?: {
    edition?: string;
    formattedDate?: string;
    leadStories?: Array<{ title: string; source: string; summary?: string }>;
  } | null;
  marketSentiment?: {
    macroHeadline?: string;
    assets?: Array<{ symbol: string; name: string; price: number; changePercent?: number; percentChange?: number; sector?: string }>;
  } | null;
  dossier?: {
    topic?: string;
    executiveSummary?: string;
    risks?: Array<{ category: string; description: string; severity: string }>;
  } | null;
}

export default function CSuiteReportModal({
  isOpen,
  onClose,
  briefing,
  marketSentiment,
  dossier,
}: CSuiteReportModalProps) {
  const [copyFeedback, setCopyFeedback] = useState("");

  if (!isOpen) return null;

  const report = compileCSuiteReportData(briefing, marketSentiment, dossier);

  const handlePrint = () => {
    window.print();
  };

  const handleCopySummary = async () => {
    const text = formatCSuiteSummaryText(report);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        setCopyFeedback("Executive Report Copied!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {
      setCopyFeedback("Failed to copy report.");
    }
  };

  return (
    <div
      className="csuite-report-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="csuite-modal-title"
    >
      <div className="csuite-report-modal">
        {/* Sticky Action Toolbar */}
        <div className="csuite-toolbar-top">
          <span className="csuite-toolbar-title" id="csuite-modal-title">
            📑 C-Suite Executive Intelligence Briefing
          </span>
          <div className="csuite-toolbar-actions">
            {copyFeedback && (
              <span style={{ color: "#38bdf8", fontSize: "0.82rem", fontWeight: 700, marginRight: "0.5rem" }}>
                {copyFeedback}
              </span>
            )}
            <button
              type="button"
              className="csuite-btn primary"
              onClick={handlePrint}
              title="Print or export as PDF"
            >
              🖨️ Print / Save as PDF
            </button>
            <button
              type="button"
              className="csuite-btn"
              onClick={() => void handleCopySummary()}
              title="Copy executive summary text"
            >
              📋 Copy Summary
            </button>
            <button
              type="button"
              className="csuite-close-btn"
              onClick={onClose}
              aria-label="Close C-Suite Report"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Printable Paper Document */}
        <div className="csuite-paper">
          {/* Document Header */}
          <header className="csuite-paper-header">
            <div>
              <p className="csuite-kicker">SIGNAL &middot; EXECUTIVE BRIEFING REPORT</p>
              <h1 className="csuite-doc-title">C-Suite Intelligence Briefing</h1>
              <p className="csuite-doc-meta">{report.reportDate} &bull; {report.edition.toUpperCase()} EDITION</p>
            </div>
            <span className="csuite-confidential-pill">CONFIDENTIAL &bull; BOARD LEVEL</span>
          </header>

          {/* Macro Callout Box */}
          <div className="csuite-callout">
            <p className="csuite-callout-kicker">Macro Intelligence Assessment</p>
            <p className="csuite-callout-text">&ldquo;{report.macroHeadline}&rdquo;</p>
          </div>

          {/* Market Snapshot Grid */}
          <h2 className="csuite-section-title">Executive Market Pulse</h2>
          <div className="csuite-market-grid">
            {report.marketAssets.map((asset) => {
              const isPos = asset.changePercent > 0;
              const isNeg = asset.changePercent < 0;
              return (
                <div key={asset.symbol} className="csuite-market-tile">
                  <div className="csuite-tile-sym">{asset.symbol} &bull; {asset.sector}</div>
                  <div className="csuite-tile-price">${asset.price.toFixed(2)}</div>
                  <div className={`csuite-tile-chg ${isPos ? "pos" : isNeg ? "neg" : ""}`}>
                    {isPos ? "+" : ""}{asset.changePercent.toFixed(2)}%
                  </div>
                </div>
              );
            })}
          </div>

          {/* Lead Breaking Intelligence Stories */}
          <h2 className="csuite-section-title">Core Catalysts &amp; Breaking Developments</h2>
          <div className="csuite-stories-list">
            {report.leadArticles.map((art, idx) => (
              <div key={idx} className="csuite-story-row">
                <div className="csuite-story-src">{art.source}</div>
                <h3 className="csuite-story-title">{art.title}</h3>
                <p className="csuite-story-summary">{art.summary}</p>
              </div>
            ))}
          </div>

          {/* Red Team Contrarian Critique */}
          {report.redTeamContrarianNote && (
            <div className="csuite-redteam-box">
              <p className="csuite-redteam-kicker">⚖️ Red Team Contrarian Risk Assessment</p>
              <p className="csuite-redteam-body">{report.redTeamContrarianNote}</p>
            </div>
          )}

          {/* Strategic Risk Heatmap */}
          <h2 className="csuite-section-title">Strategic Downstream Risks</h2>
          <div className="csuite-risks-grid">
            {report.strategicRisks.map((risk, idx) => (
              <div key={idx} className="csuite-risk-card">
                <div className="csuite-risk-top">
                  <span className="csuite-risk-cat">{risk.category}</span>
                  <span className="csuite-risk-sev" style={{ color: risk.severity === "Elevated" ? "#dc2626" : "#ea580c" }}>
                    [{risk.severity}]
                  </span>
                </div>
                <p className="csuite-risk-desc">{risk.description}</p>
              </div>
            ))}
          </div>

          {/* Document Footer */}
          <footer className="csuite-doc-footer">
            <span>Prepared via Signal Executive Intelligence Platform</span>
            <span>Document ID: SIG-CSUITE-{Date.now().toString(36).toUpperCase()}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
