"use client";

import React, { useState, useEffect } from "react";
import {
  compileExecutiveDossier,
  formatDossierMarkdown,
  type ClusterDossierResponse,
  type DossierArticleInput,
} from "./executive-dossier";
import "./executive-dossier.css";

export interface ExecutiveDossierModalProps {
  isOpen: boolean;
  onClose: () => void;
  topic?: string;
  articles: DossierArticleInput[];
}

export default function ExecutiveDossierModal({
  isOpen,
  onClose,
  topic = "Executive Intelligence Dossier",
  articles,
}: ExecutiveDossierModalProps) {
  const [dossier, setDossier] = useState<ClusterDossierResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"summary" | "perspectives" | "risks" | "timeline" | "sources">("summary");
  const [copyFeedback, setCopyFeedback] = useState<string>("");

  useEffect(() => {
    if (!isOpen || articles.length === 0) return;
    setLoading(true);
    const abort = new AbortController();

    void compileExecutiveDossier(topic, articles, abort.signal).then((res) => {
      setDossier(res);
      setLoading(false);
    });

    return () => abort.abort();
  }, [articles, isOpen, topic]);

  if (!isOpen) return null;

  const handlePrintPdf = () => {
    window.print();
  };

  const handleCopyMarkdown = async () => {
    if (!dossier) return;
    const md = formatDossierMarkdown(dossier);
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(md);
        setCopyFeedback("Markdown Binder Copied!");
        setTimeout(() => setCopyFeedback(""), 3500);
      }
    } catch {
      setCopyFeedback("Failed to copy binder.");
    }
  };

  return (
    <div
      className="executive-dossier-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dossier-title"
    >
      <div className="executive-dossier-card">
        {/* Binder Header */}
        <header className="dossier-header">
          <div>
            <div className="dossier-badge-row">
              <span className="dossier-badge">📁 SIGNAL EXECUTIVE DOSSIER</span>
              <span className="dossier-sources-count">{articles.length} Contributing Sources</span>
            </div>
            <h2 id="dossier-title" className="dossier-title">{dossier?.topic || topic}</h2>
          </div>
          <div className="dossier-actions-top">
            <button
              type="button"
              className="dossier-btn secondary"
              onClick={handlePrintPdf}
              title="Print or export Executive Intelligence Dossier PDF"
            >
              📄 1-Pager PDF
            </button>
            <button
              type="button"
              className="dossier-btn secondary"
              onClick={() => void handleCopyMarkdown()}
              title="Copy formatted Markdown Dossier binder"
            >
              📋 Copy Markdown
            </button>
            <button
              type="button"
              className="dossier-close-btn"
              onClick={onClose}
              aria-label="Close Dossier"
            >
              ✕
            </button>
          </div>
        </header>

        {copyFeedback && (
          <div className="dossier-feedback" role="status" aria-live="polite">
            {copyFeedback}
          </div>
        )}

        {/* Navigation Tabs */}
        <nav className="dossier-tabs" role="tablist" aria-label="Dossier Sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "summary"}
            className={`dossier-tab ${activeTab === "summary" ? "active" : ""}`}
            onClick={() => setActiveTab("summary")}
          >
            Executive Summary
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "perspectives"}
            className={`dossier-tab ${activeTab === "perspectives" ? "active" : ""}`}
            onClick={() => setActiveTab("perspectives")}
          >
            Perspectives Matrix ({dossier?.perspectives.length ?? 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "risks"}
            className={`dossier-tab ${activeTab === "risks" ? "active" : ""}`}
            onClick={() => setActiveTab("risks")}
          >
            Risk Matrix ({dossier?.risks.length ?? 0})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "timeline"}
            className={`dossier-tab ${activeTab === "timeline" ? "active" : ""}`}
            onClick={() => setActiveTab("timeline")}
          >
            Evolution Timeline
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "sources"}
            className={`dossier-tab ${activeTab === "sources" ? "active" : ""}`}
            onClick={() => setActiveTab("sources")}
          >
            Cited Sources
          </button>
        </nav>

        {/* Binder Content */}
        <div className="dossier-body">
          {loading ? (
            <div className="dossier-loading">⏳ Synthesizing intelligence binder across sources...</div>
          ) : !dossier ? (
            <div className="dossier-error">Could not compile dossier at this time.</div>
          ) : (
            <>
              {activeTab === "summary" && (
                <section className="dossier-section summary-section">
                  <h3 className="section-heading">Strategic Intelligence Overview</h3>
                  <p className="summary-prose">{dossier.executiveSummary}</p>
                </section>
              )}

              {activeTab === "perspectives" && (
                <section className="dossier-section perspectives-section">
                  <h3 className="section-heading">Comparative Publisher Framing</h3>
                  <div className="perspectives-grid">
                    {dossier.perspectives.map((p, i) => (
                      <div key={i} className="perspective-card">
                        <div className="perspective-header">
                          <span className="perspective-publisher">{p.publisher}</span>
                          <span className="perspective-tone">{p.framingTone}</span>
                        </div>
                        <p className="perspective-focus">{p.primaryFocus}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "risks" && (
                <section className="dossier-section risks-section">
                  <h3 className="section-heading">Downstream &amp; Execution Risk Matrix</h3>
                  <div className="risks-list">
                    {dossier.risks.map((r, i) => (
                      <div key={i} className="risk-card">
                        <div className="risk-header">
                          <span className="risk-category">{r.category}</span>
                          <span className={`risk-severity-pill ${r.severity.toLowerCase()}`}>
                            {r.severity.toUpperCase()} RISK
                          </span>
                        </div>
                        <p className="risk-desc">{r.description}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "timeline" && (
                <section className="dossier-section timeline-section">
                  <h3 className="section-heading">Story Evolution Chronology</h3>
                  <div className="timeline-stepper-view">
                    {dossier.milestones.map((m, i) => (
                      <div key={i} className="timeline-node">
                        <div className="node-marker" />
                        <div className="node-content">
                          <div className="node-meta">
                            <span className="node-phase">{m.phase}</span>
                            <span className="node-date">&bull; {m.dateOrEra}</span>
                            {m.source && <span className="node-source">&bull; {m.source}</span>}
                          </div>
                          <h4 className="node-headline">{m.headline}</h4>
                          <p className="node-summary">{m.summary}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {activeTab === "sources" && (
                <section className="dossier-section sources-section">
                  <h3 className="section-heading">Contributing Sources &amp; Verifications</h3>
                  <ul className="dossier-sources-list">
                    {dossier.citedSources.map((src, i) => (
                      <li key={i}>{src}</li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
