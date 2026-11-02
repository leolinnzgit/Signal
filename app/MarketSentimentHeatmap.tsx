"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  fetchMarketSentimentMatrix,
  type MarketSentimentAsset,
  type MarketSentimentMatrixResponse,
} from "./market-sentiment";
import "./market-sentiment.css";

export interface MarketSentimentHeatmapProps {
  isOpen: boolean;
  onClose: () => void;
  watchlistItems?: Array<{ topic: string; symbol?: string }>;
  headlines?: string[];
  onOpenArticleUrl?: (url: string) => void;
}

export default function MarketSentimentHeatmap({
  isOpen,
  onClose,
  watchlistItems = [],
  headlines = [],
  onOpenArticleUrl,
}: MarketSentimentHeatmapProps) {
  const [data, setData] = useState<MarketSentimentMatrixResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedSector, setSelectedSector] = useState<string>("All");
  const [activeAsset, setActiveAsset] = useState<MarketSentimentAsset | null>(null);
  const [watchSyncMsg, setWatchSyncMsg] = useState<string>("");

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    const abort = new AbortController();

    void fetchMarketSentimentMatrix(
      watchlistItems,
      headlines,
      selectedSector === "All" ? undefined : selectedSector,
      abort.signal,
    ).then((res) => {
      setData(res);
      setLoading(false);
      if (res.assets.length > 0) {
        setActiveAsset(res.assets[0]);
      }
    });

    return () => abort.abort();
  }, [headlines, isOpen, selectedSector, watchlistItems]);

  const sectors = useMemo(() => {
    if (!data?.assets) return ["All"];
    const set = new Set<string>(data.assets.map((a) => a.sector));
    return ["All", ...Array.from(set)];
  }, [data]);

  const displayedAssets = useMemo(() => {
    if (!data?.assets) return [];
    if (selectedSector === "All") return data.assets;
    return data.assets.filter((a) => a.sector === selectedSector);
  }, [data, selectedSector]);

  if (!isOpen) return null;

  return (
    <div
      className="market-heatmap-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="market-heatmap-title"
    >
      <div className="market-heatmap-card">
        {/* Header */}
        <header className="heatmap-header">
          <div>
            <span className="heatmap-kicker">📊 MACRO INTELLIGENCE</span>
            <h2 id="market-heatmap-title" className="heatmap-title">
              Market Sentiment &amp; Correlation Heatmap
            </h2>
            {data?.macroHeadline && (
              <p className="heatmap-macro-headline">{data.macroHeadline}</p>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              type="button"
              className="heatmap-sector-tab"
              style={{ background: "#1e3a5f", color: "#38bdf8", borderColor: "#38bdf8" }}
              onClick={() => {
                setWatchSyncMsg("⌚ Market snapshot synced to SignalWatch!");
                setTimeout(() => setWatchSyncMsg(""), 3500);
              }}
              title="Sync macro indicators to paired SignalWatch"
            >
              ⌚ Sync Watch
            </button>
            <button
              type="button"
              className="heatmap-close-btn"
              onClick={onClose}
              aria-label="Close Market Heatmap"
            >
              ✕
            </button>
          </div>
        </header>

        {watchSyncMsg && (
          <div style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.35)", padding: "0.4rem 0.8rem", borderRadius: "6px", marginBottom: "0.75rem", fontSize: "0.82rem", fontWeight: 600, textAlign: "center" }}>
            {watchSyncMsg}
          </div>
        )}

        {/* Sector Filter Strip */}
        <div className="heatmap-sectors-row" role="tablist" aria-label="Filter by Sector">
          {sectors.map((sec) => (
            <button
              key={sec}
              type="button"
              role="tab"
              aria-selected={selectedSector === sec}
              className={`heatmap-sector-tab ${selectedSector === sec ? "active" : ""}`}
              onClick={() => setSelectedSector(sec)}
            >
              {sec}
            </button>
          ))}
        </div>

        {/* Heatmap Grid */}
        <div className="heatmap-main-content">
          {loading ? (
            <div className="heatmap-loading">⏳ Synthesizing market correlation matrix...</div>
          ) : (
            <div className="heatmap-tiles-grid">
              {displayedAssets.map((asset) => {
                const isSelected = activeAsset?.symbol === asset.symbol;
                const isUp = asset.changePercent >= 0;
                const changeClass =
                  asset.changePercent > 1.5
                    ? "strong-up"
                    : asset.changePercent > 0
                      ? "mild-up"
                      : asset.changePercent < -1.5
                        ? "strong-down"
                        : "mild-down";

                return (
                  <button
                    key={asset.symbol}
                    type="button"
                    className={`heatmap-tile ${changeClass} ${isSelected ? "is-selected" : ""}`}
                    onClick={() => setActiveAsset(asset)}
                  >
                    <div className="tile-top-row">
                      <span className="tile-symbol">{asset.symbol}</span>
                      <span className="tile-sector-badge">{asset.sector}</span>
                    </div>
                    <div className="tile-name">{asset.name}</div>
                    <div className="tile-bottom-row">
                      <span className="tile-price">
                        {asset.price > 10 ? asset.price.toFixed(2) : asset.price.toFixed(4)}
                      </span>
                      <span className={`tile-change ${isUp ? "positive" : "negative"}`}>
                        {isUp ? "▲" : "▼"} {Math.abs(asset.changePercent).toFixed(2)}%
                      </span>
                    </div>
                    {asset.attributions.length > 0 && (
                      <span className="tile-attribution-pill">
                        {asset.attributions[0].impactType === "bullish"
                          ? "⚡ Bullish Catalyst"
                          : "⚠️ Headwind"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Macro Correlation Story Details Drawer */}
          {activeAsset && (
            <aside className="heatmap-attribution-drawer">
              <div className="drawer-header">
                <div>
                  <span className="drawer-symbol">{activeAsset.symbol}</span>
                  <h3 className="drawer-name">{activeAsset.name}</h3>
                </div>
                <div className={`drawer-metric ${activeAsset.changePercent >= 0 ? "positive" : "negative"}`}>
                  <span>{activeAsset.price > 10 ? activeAsset.price.toFixed(2) : activeAsset.price.toFixed(4)}</span>
                  <small>
                    {activeAsset.changePercent >= 0 ? "+" : ""}
                    {activeAsset.changePercent.toFixed(2)}%
                  </small>
                </div>
              </div>

              <div className="drawer-tone-row">
                <span className="drawer-label">News Attribution &amp; Sentiment:</span>
                <span className={`drawer-tone-pill ${activeAsset.sentimentTone}`}>
                  {activeAsset.sentimentTone.toUpperCase()}
                </span>
              </div>

              {activeAsset.attributions.length === 0 ? (
                <p className="drawer-empty-text">
                  Consolidated technical momentum with no isolated breaking news headline.
                </p>
              ) : (
                <div className="drawer-stories-list">
                  {activeAsset.attributions.map((att, i) => (
                    <div key={i} className={`drawer-story-item ${att.impactType}`}>
                      <div className="story-item-header">
                        <span className="story-impact-badge">{att.impactType.toUpperCase()}</span>
                        <span className="story-source">{att.source}</span>
                      </div>
                      <p className="story-title">{att.title}</p>
                      {att.url && onOpenArticleUrl && (
                        <button
                          type="button"
                          className="story-read-btn"
                          onClick={() => onOpenArticleUrl(att.url)}
                        >
                          Read Story &rarr;
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
