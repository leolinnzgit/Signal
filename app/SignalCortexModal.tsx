import React, { useEffect, useState, useRef } from "react";
import {
  CortexSearchResponse,
  searchSignalCortex,
  formatCortexDigest,
  getDomainBadgeClass,
} from "./signal-cortex.ts";
import "./signal-cortex.css";

interface SignalCortexModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string }>;
  onOpenSuite: (suiteId: string, focusEntityId?: string) => void;
}

export function SignalCortexModal({
  isOpen,
  onClose,
  articles = [],
  onOpenSuite,
}: SignalCortexModalProps) {
  const [query, setQuery] = useState<string>("");
  const [response, setResponse] = useState<CortexSearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef<boolean>(false);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Global ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Execute search (immediate on open, 200ms debounced on query edits)
  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        setIsSearching(true);
        const res = await searchSignalCortex(query, articles);
        if (!cancelled) setResponse(res);
      } catch (err) {
        console.error("Cortex search error:", err);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    };

    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      void run();
      return () => {
        cancelled = true;
      };
    }

    const timeout = setTimeout(() => {
      void run();
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query, isOpen, articles]);

  if (!isOpen) return null;

  const handleJump = (suiteId: string, hitId?: string) => {
    let focusEntityId: string | undefined;
    if (suiteId === "geopolitical-transit") {
      focusEntityId = hitId === "hit-chokepoint-2" ? "hormuz" : "bab-el-mandeb";
    }
    onClose();
    onOpenSuite(suiteId, focusEntityId);
  };

  const handleCopy = async () => {
    if (!response) return;
    const digest = formatCortexDigest(query, response);
    try {
      await navigator.clipboard.writeText(digest);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Fallback
    }
  };

  return (
    <div
      className="cortex-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cortex-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cortex-modal-container">
        {/* Search Input Bar */}
        <div className="cortex-search-header">
          <span className="cortex-search-icon" aria-hidden="true">🧠</span>
          <input
            ref={searchInputRef}
            type="text"
            className="cortex-search-field"
            placeholder="Search across all 28 intelligence suites, entities, straits, or tariffs..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Query Signal Cortex"
          />
          <span className="cortex-key-badge">ESC to close</span>
          <button
            type="button"
            className="cortex-close-btn"
            onClick={onClose}
            aria-label="Close Signal Cortex"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="cortex-body">
          {/* Suggested Query Chips */}
          {(response?.suggestedQueries || []).length > 0 && (
            <div className="cortex-suggested-row">
              <span style={{ fontSize: "0.72rem", color: "#64748b", fontWeight: 700 }}>
                SUGGESTED:
              </span>
              {response?.suggestedQueries.map((sq, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="cortex-suggested-chip"
                  onClick={() => setQuery(sq)}
                >
                  {sq}
                </button>
              ))}
            </div>
          )}

          {/* Synthesized Box */}
          {response && (
            <div className="cortex-synthesized-box">
              <div className="cortex-synth-header">
                <span className="cortex-synth-tag">
                  {isSearching ? "ANALYZING CROSS-SUITE CORPORA..." : "EXECUTIVE SYNTHESIS"}
                </span>
                <span className="cortex-confidence-pill">
                  {Math.round((response.confidence || 0.94) * 100)}% Confidence
                </span>
              </div>
              <div className="cortex-synth-text">
                {response.synthesizedAnswer}
              </div>
            </div>
          )}

          {/* Cross Domain Hits */}
          <div>
            <div style={{ fontSize: "0.76rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", marginBottom: "0.5rem" }}>
              CROSS-DOMAIN CORRELATIONS ({response?.crossDomainHits.length || 0})
            </div>

            <div className="cortex-hits-list">
              {(response?.crossDomainHits || []).map((hit) => {
                const badge = getDomainBadgeClass(hit.domain);
                return (
                  <div key={hit.id} className="cortex-hit-card">
                    <div className="cortex-hit-header">
                      <span className="cortex-hit-title">{hit.title}</span>
                      <span className={`cortex-domain-badge ${badge.badgeClass}`}>
                        {badge.label}
                      </span>
                    </div>
                    <div className="cortex-hit-snippet">{hit.snippet}</div>
                    <div className="cortex-hit-actions">
                      <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
                        Relevance: {Math.round(hit.relevanceScore * 100)}%
                      </span>
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        {hit.url && (
                          <a
                            href={hit.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: "0.72rem", color: "#38bdf8", textDecoration: "underline" }}
                          >
                            Source ↗
                          </a>
                        )}
                        <button
                          type="button"
                          className="cortex-jump-btn"
                          onClick={() => handleJump(hit.targetSuiteId, hit.id)}
                        >
                          Open in {hit.targetSuiteId} ↗
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="cortex-footer">
          <div>
            <span>Global hotkey: </span>
            <strong style={{ color: "#38bdf8" }}>⌘J / Ctrl+J</strong>
            {copied && <span style={{ marginLeft: "1rem", color: "#10b981", fontWeight: 700 }}>✓ Copied Digest</span>}
          </div>

          <button
            type="button"
            style={{
              background: "rgba(56, 189, 248, 0.15)",
              border: "1px solid rgba(56, 189, 248, 0.3)",
              color: "#38bdf8",
              fontSize: "0.75rem",
              fontWeight: 600,
              padding: "0.3rem 0.75rem",
              borderRadius: "4px",
              cursor: "pointer",
            }}
            onClick={handleCopy}
          >
            📋 Copy Synthesis Digest
          </button>
        </div>
      </div>
    </div>
  );
}
