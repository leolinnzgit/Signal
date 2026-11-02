"use client";

import React, { useState, useEffect } from "react";
import {
  extractQuotes,
  type ExtractedQuoteItem,
  type QuoteExtractionResponse,
} from "./quote-extractor";
import "./quote-extractor.css";

export interface QuoteExtractorModalProps {
  isOpen: boolean;
  onClose: () => void;
  articles?: Array<{ title: string; source: string; url: string; summary?: string; paragraphs?: string[] }>;
  onOpenAudiogram?: (quote: ExtractedQuoteItem) => void;
}

export default function QuoteExtractorModal({
  isOpen,
  onClose,
  articles = [],
  onOpenAudiogram,
}: QuoteExtractorModalProps) {
  const [data, setData] = useState<QuoteExtractionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedStance, setSelectedStance] = useState<string>("ALL");
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>("ALL");

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    void extractQuotes(articles).then((res) => {
      setData(res);
      setLoading(false);
    });
  }, [articles, isOpen]);

  if (!isOpen) return null;

  const quotes = data?.quotes || [];
  const filtered = quotes.filter((q) => {
    if (selectedStance !== "ALL" && q.stance.toUpperCase() !== selectedStance) return false;
    if (selectedSpeaker !== "ALL" && q.speaker !== selectedSpeaker) return false;
    return true;
  });

  return (
    <div className="quote-extractor-backdrop" role="dialog" aria-modal="true" aria-labelledby="quote-modal-title">
      <div className="quote-extractor-modal">
        <header className="quote-extractor-header">
          <h2 id="quote-modal-title" className="quote-extractor-title">
            🎙️ Verbatim Soundbites & Stance Tracker
          </h2>
          <button
            type="button"
            className="quote-extractor-close-btn"
            onClick={onClose}
            aria-label="Close quote extractor"
          >
            &times;
          </button>
        </header>

        <div className="quote-extractor-body">
          <div className="quote-extractor-filters">
            <span style={{ fontSize: "0.8rem", color: "#94a3b8", fontWeight: 700 }}>STANCE:</span>
            {["ALL", "ASSERTIVE", "DEFENSIVE", "CAUTIOUS", "PIVOT"].map((st) => (
              <button
                key={st}
                type="button"
                className={`quote-stance-filter-btn${selectedStance === st ? " active" : ""}`}
                onClick={() => setSelectedStance(st)}
              >
                {st}
              </button>
            ))}

            {data?.discoveredSpeakers && data.discoveredSpeakers.length > 1 && (
              <select
                value={selectedSpeaker}
                onChange={(e) => setSelectedSpeaker(e.target.value)}
                style={{
                  background: "#1e293b",
                  border: "1px solid #334155",
                  color: "#cbd5e1",
                  padding: "0.3rem 0.6rem",
                  borderRadius: "0.375rem",
                  fontSize: "0.8rem",
                  marginLeft: "auto",
                }}
                aria-label="Filter by speaker"
              >
                <option value="ALL">All Leaders & Speakers</option>
                {data.discoveredSpeakers.map((spk, idx) => (
                  <option key={idx} value={spk}>{spk}</option>
                ))}
              </select>
            )}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#94a3b8" }}>
              Extracting on-the-record quotes and classifying executive stances...
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem", color: "#64748b" }}>
              No direct quotes found matching the selected filter criteria.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              {filtered.map((q) => (
                <div key={q.id} className="quote-card">
                  <div className="quote-card-header">
                    <div className="quote-card-speaker-block">
                      <div className="quote-avatar">
                        {q.speaker.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="quote-speaker-name">{q.speaker}</div>
                        <div className="quote-speaker-role">{q.role} &bull; {q.organization}</div>
                      </div>
                    </div>
                    <span className={`quote-stance-badge ${q.stance.toLowerCase()}`}>
                      {q.stance}
                    </span>
                  </div>

                  <p className="quote-text-block">
                    &ldquo;{q.quoteText}&rdquo;
                  </p>

                  <div className="quote-card-footer">
                    <span>Reported by <strong>{q.publisher}</strong></span>
                    {onOpenAudiogram && (
                      <button
                        type="button"
                        onClick={() => onOpenAudiogram(q)}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#38bdf8",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                        }}
                      >
                        🎵 Create Audiogram Snippet &rarr;
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="quote-extractor-footer">
          <span style={{ color: "#64748b", fontSize: "0.8rem" }}>
            Isolating verbatim executive remarks vs. publisher editorial spin
          </span>
          <span style={{ color: "#a855f7", fontSize: "0.85rem", fontWeight: 700 }}>
            {filtered.length} Quote{filtered.length === 1 ? "" : "s"} Tracked
          </span>
        </footer>
      </div>
    </div>
  );
}
