"use client";

import React, { useState, useEffect } from "react";
import {
  compileExecutiveDossier,
  formatDossierMarkdown,
  syncDossierToWatch,
  dispatchDossierDigest,
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
  const [syncingWatch, setSyncingWatch] = useState(false);
  const [digestDrawerOpen, setDigestDrawerOpen] = useState(false);
  const [digestEmail, setDigestEmail] = useState("");
  const [digestWebhook, setDigestWebhook] = useState("");
  const [digestDestination, setDigestDestination] = useState<"email" | "webhook" | "both">("email");
  const [dispatchingDigest, setDispatchingDigest] = useState(false);

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

  const handleSyncToWatch = async () => {
    if (!dossier) return;
    setSyncingWatch(true);
    const res = await syncDossierToWatch(dossier);
    setSyncingWatch(false);
    if (res.success) {
      setCopyFeedback(`⌚ Synced "${res.topic}" directly to paired SignalWatch companion!`);
    } else {
      setCopyFeedback(res.error || "Failed to sync dossier to watch.");
    }
    setTimeout(() => setCopyFeedback(""), 4500);
  };

  const handleDispatchDigest = async () => {
    if (!dossier) return;
    setDispatchingDigest(true);
    const res = await dispatchDossierDigest(dossier, {
      destination: digestDestination,
      recipientEmail: digestEmail.trim() || undefined,
      webhookUrl: digestWebhook.trim() || undefined,
    });
    setDispatchingDigest(false);
    setCopyFeedback(res.message);
    if (res.success) {
      setDigestDrawerOpen(false);
    }
    setTimeout(() => setCopyFeedback(""), 5000);
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
              onClick={() => void handleSyncToWatch()}
              disabled={syncingWatch || !dossier}
              title="Sync dossier summary and risks directly to paired SignalWatch"
            >
              {syncingWatch ? "⌚ Syncing..." : "⌚ Sync Watch"}
            </button>
            <button
              type="button"
              className="dossier-btn secondary"
              onClick={() => setDigestDrawerOpen((prev) => !prev)}
              title="Dispatch automated HTML email or webhook digest"
            >
              📧 Dispatch Digest
            </button>
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

        {digestDrawerOpen && (
          <div className="dossier-digest-drawer" role="region" aria-label="Dispatch Executive Digest">
            <h4 className="dossier-digest-title">Automated Executive Digest Dispatch</h4>
            <p className="dossier-digest-desc">
              Transmit this compiled intelligence binder directly to your executive inbox or enterprise webhook channel (Slack / Teams).
            </p>
            <div className="dossier-digest-options">
              <label className="dossier-digest-radio">
                <input
                  type="radio"
                  name="destination"
                  value="email"
                  checked={digestDestination === "email"}
                  onChange={() => setDigestDestination("email")}
                />
                <span>Email Briefing</span>
              </label>
              <label className="dossier-digest-radio">
                <input
                  type="radio"
                  name="destination"
                  value="webhook"
                  checked={digestDestination === "webhook"}
                  onChange={() => setDigestDestination("webhook")}
                />
                <span>Secure Webhook</span>
              </label>
              <label className="dossier-digest-radio">
                <input
                  type="radio"
                  name="destination"
                  value="both"
                  checked={digestDestination === "both"}
                  onChange={() => setDigestDestination("both")}
                />
                <span>Both Channels</span>
              </label>
            </div>
            <div className="dossier-digest-inputs">
              {(digestDestination === "email" || digestDestination === "both") && (
                <input
                  type="email"
                  className="dossier-input-field"
                  placeholder="Recipient Email (leave blank to send to your verified account email)"
                  value={digestEmail}
                  onChange={(e) => setDigestEmail(e.target.value)}
                />
              )}
              {(digestDestination === "webhook" || digestDestination === "both") && (
                <input
                  type="url"
                  className="dossier-input-field"
                  placeholder="https://hooks.slack.com/services/... or Teams webhook URL"
                  value={digestWebhook}
                  onChange={(e) => setDigestWebhook(e.target.value)}
                />
              )}
            </div>
            <div className="dossier-digest-footer">
              <button
                type="button"
                className="dossier-btn secondary"
                onClick={() => setDigestDrawerOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dossier-btn secondary"
                style={{ background: "#0284c7", borderColor: "#38bdf8", color: "#ffffff" }}
                onClick={() => void handleDispatchDigest()}
                disabled={dispatchingDigest}
              >
                {dispatchingDigest ? "Dispatching..." : "🚀 Send Digest Now"}
              </button>
            </div>
          </div>
        )}

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
