"use client";

import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { formatMarketPrice, type MarketQuote } from "./market-quote";
import {
  buildClientStockNewsGraph,
  buildStockNewsChartGeometry,
  fetchStockNewsGraph,
  mergeStockNewsGraphData,
  type GraphArticleLike,
  type StockNewsChartEvent,
  type StockNewsChartMode,
  type StockNewsGraphResponse,
} from "./stock-news-graph";
import "./stock-news-graph.css";

export interface StockNewsGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialSymbol?: string;
  initialTopic?: string;
  initialHighlightUrl?: string;
  articles: readonly GraphArticleLike[];
  liveQuotes: readonly MarketQuote[];
  onOpenArticle?: (url: string) => void;
}

function formatEventDateTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function StockNewsGraphModal({
  isOpen,
  onClose,
  initialSymbol,
  initialTopic,
  initialHighlightUrl,
  articles,
  liveQuotes,
  onOpenArticle,
}: StockNewsGraphModalProps) {
  const gradientId = useId();
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol || "");
  const [selectedTopic, setSelectedTopic] = useState(initialTopic || "");
  const [lookupInput, setLookupInput] = useState("");
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [chartMode, setChartMode] = useState<StockNewsChartMode>("combined");
  const [serverGraph, setServerGraph] = useState<StockNewsGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedEventUrl, setSelectedEventUrl] = useState<string>(initialHighlightUrl || "");
  const [ledgerLimit, setLedgerLimit] = useState(150);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedSymbol(initialSymbol || "");
    setSelectedTopic(initialTopic || "");
    setSelectedEventUrl(initialHighlightUrl || "");
    setLedgerLimit(150);
  }, [isOpen, initialSymbol, initialTopic, initialHighlightUrl]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const abort = new AbortController();
    setLoading(true);
    void fetchStockNewsGraph(
      {
        symbol: selectedSymbol || undefined,
        topic: selectedTopic || undefined,
        days,
      },
      abort.signal,
    ).then((res) => {
      if (!abort.signal.aborted) {
        setServerGraph(res);
        setLoading(false);
      }
    });
    return () => abort.abort();
  }, [isOpen, selectedSymbol, selectedTopic, days]);

  const clientGraph = useMemo(
    () =>
      buildClientStockNewsGraph(articles, liveQuotes, {
        symbol: selectedSymbol || undefined,
        topic: selectedTopic || undefined,
      }),
    [articles, liveQuotes, selectedSymbol, selectedTopic],
  );

  const graph = useMemo(
    () => mergeStockNewsGraphData(serverGraph, clientGraph),
    [serverGraph, clientGraph],
  );

  const geometry = useMemo(
    () => buildStockNewsChartGeometry(graph.pricePoints, graph.events, 760, 280, chartMode, selectedEventUrl),
    [graph.pricePoints, graph.events, chartMode, selectedEventUrl],
  );

  const activeNodeIndex = useMemo(() => {
    if (!geometry || geometry.nodes.length === 0) return -1;
    if (selectedEventUrl) {
      const idx = geometry.nodes.findIndex(
        (n) => n.event.url.trim().toLowerCase() === selectedEventUrl.trim().toLowerCase(),
      );
      if (idx >= 0) return idx;
    }
    return geometry.nodes.length - 1;
  }, [geometry, selectedEventUrl]);

  const activeEvent: StockNewsChartEvent | null =
    geometry && activeNodeIndex >= 0 ? geometry.nodes[activeNodeIndex].event : null;

  if (!isOpen) return null;

  const activeCurrency = graph.activeCurrency || "";
  const strokeColor = geometry?.isUp ?? true ? "var(--market-up, #337a4a)" : "var(--red, #c83f32)";
  const snapshotCount = graph.events.filter((ev) => ev.isRecordedSnapshot).length;
  const positiveCount = graph.events.filter((ev) => ev.percentChange > 0).length;
  const negativeCount = graph.events.filter((ev) => ev.percentChange < 0).length;
  const activeSeriesSummary = graph.availableSeries.find(
    (s) => s.symbol.toUpperCase() === graph.activeSymbol.toUpperCase(),
  );
  const latestDisplayPrice =
    activeSeriesSummary?.latestPrice && activeSeriesSummary.latestPrice > 0
      ? activeSeriesSummary.latestPrice
      : geometry?.lastPrice ?? 0;
  const latestChangePct = activeSeriesSummary?.latestPercentChange ?? 0;

  function handleLookupSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = lookupInput.trim();
    if (!trimmed) return;
    const looksLikeTicker = /^[A-Za-z0-9.^:/-]{1,15}$/.test(trimmed) && (trimmed === trimmed.toUpperCase() || trimmed.includes(":") || trimmed.includes("/"));
    if (looksLikeTicker) {
      setSelectedSymbol(trimmed.toUpperCase());
      setSelectedTopic("");
    } else {
      setSelectedTopic(trimmed);
      setSelectedSymbol("");
    }
    setSelectedEventUrl("");
    setLookupInput("");
  }

  function handleSelectNode(index: number) {
    if (!geometry || index < 0 || index >= geometry.nodes.length) return;
    setSelectedEventUrl(geometry.nodes[index].event.url);
  }

  return (
    <div
      className="stock-news-graph-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stock-news-graph-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="stock-news-graph-card">
        <header className="stock-news-graph-header">
          <div>
            <span className="stock-news-graph-kicker">📈 Stock Price vs. News</span>
            <h2 id="stock-news-graph-title" className="stock-news-graph-title">
              {graph.activeSymbol
                ? `${graph.activeSymbol} · ${graph.activeName || graph.activeTopic}`
                : "Stock Price vs. News Timeline"}
            </h2>
            <p className="stock-news-graph-subtitle">
              {[graph.activeExchange, activeCurrency, graph.activeTopic].filter(Boolean).join(" · ") ||
                "Each news story records the stock quote at the time coverage arrived so price moves and catalysts can be compared."}
            </p>
          </div>
          <button
            type="button"
            className="stock-news-graph-close"
            onClick={onClose}
            aria-label="Close Stock Price vs. News Graph"
          >
            &#215;
          </button>
        </header>

        <div className="stock-news-toolbar">
          <div className="stock-news-series-strip" role="list" aria-label="Tracked stocks with news snapshots">
            {graph.availableSeries.map((series) => {
              const isSelected = series.symbol.toUpperCase() === graph.activeSymbol.toUpperCase();
              const isUp = series.latestPercentChange >= 0;
              return (
                <button
                  key={series.symbol}
                  type="button"
                  role="listitem"
                  className={`stock-news-series-pill${isSelected ? " active" : ""}`}
                  onClick={() => {
                    setSelectedSymbol(series.exchange ? `${series.symbol}:${series.exchange}` : series.symbol);
                    setSelectedTopic(series.topic || "");
                    setSelectedEventUrl("");
                  }}
                >
                  <strong>{series.symbol}</strong>
                  {series.latestPrice > 0 && (
                    <span>{formatMarketPrice(series.latestPrice, series.currency)}</span>
                  )}
                  <span className={`pill-change ${series.latestPercentChange > 0 ? "positive" : series.latestPercentChange < 0 ? "negative" : ""}`}>
                    {isUp && series.latestPercentChange > 0 ? "+" : ""}
                    {series.latestPercentChange.toFixed(2)}%
                  </span>
                  <span className="pill-count">({series.articleCount})</span>
                </button>
              );
            })}
          </div>

          <form className="stock-news-lookup-form" onSubmit={handleLookupSubmit}>
            <input
              type="search"
              value={lookupInput}
              onChange={(event) => setLookupInput(event.target.value)}
              placeholder="Lookup NVDA, AIR:NZX, Apple…"
              aria-label="Lookup stock ticker or company name"
              maxLength={40}
            />
            <button type="submit">Plot</button>
          </form>
        </div>

        <div className="stock-news-controls-row">
          <div className="stock-news-kpi-grid">
            <div className="stock-news-kpi-box">
              <span className="stock-news-kpi-label">Latest Quote</span>
              <span className="stock-news-kpi-value">
                {latestDisplayPrice > 0 ? formatMarketPrice(latestDisplayPrice, activeCurrency) : "—"}
              </span>
              <span className={`stock-news-kpi-sub ${latestChangePct > 0 ? "positive" : latestChangePct < 0 ? "negative" : ""}`}>
                {latestDisplayPrice > 0
                  ? `${latestChangePct > 0 ? "+" : ""}${latestChangePct.toFixed(2)}%`
                  : loading
                    ? "Loading quote…"
                    : "No quote recorded yet"}
              </span>
            </div>
            <div className="stock-news-kpi-box">
              <span className="stock-news-kpi-label">Observed Range</span>
              <span className="stock-news-kpi-value">
                {geometry
                  ? `${formatMarketPrice(Math.min(...graph.pricePoints.map((p) => p.price)), activeCurrency)} – ${formatMarketPrice(Math.max(...graph.pricePoints.map((p) => p.price)), activeCurrency)}`
                  : "—"}
              </span>
              <span className="stock-news-kpi-sub">
                {graph.pricePoints.length} {graph.pricePoints.length === 1 ? "price point" : "price points"} ({days}d window)
              </span>
            </div>
            <div className="stock-news-kpi-box">
              <span className="stock-news-kpi-label">News Catalysts</span>
              <span className="stock-news-kpi-value">{graph.events.length} stories</span>
              <span className="stock-news-kpi-sub">
                {snapshotCount} stamped · {positiveCount} up / {negativeCount} down
              </span>
            </div>
          </div>

          <div className="stock-news-toggles">
            <div className="stock-news-segmented" role="group" aria-label="Timeframe window">
              {([7, 30, 90] as const).map((windowDays) => (
                <button
                  key={windowDays}
                  type="button"
                  className={days === windowDays ? "active" : ""}
                  onClick={() => setDays(windowDays)}
                >
                  {windowDays}d
                </button>
              ))}
            </div>
            <div className="stock-news-segmented" role="group" aria-label="Chart display mode">
              <button
                type="button"
                className={chartMode === "combined" ? "active" : ""}
                onClick={() => setChartMode("combined")}
              >
                Price + News
              </button>
              <button
                type="button"
                className={chartMode === "snapshots" ? "active" : ""}
                onClick={() => setChartMode("snapshots")}
              >
                News Snapshots
              </button>
            </div>
          </div>
        </div>

        <div className="stock-news-chart-panel">
          {loading && !geometry ? (
            <div className="stock-news-empty">Loading stock prices and news history…</div>
          ) : !geometry ? (
            <div className="stock-news-empty">
              No price points or news snapshots are available for {graph.activeSymbol || graph.activeTopic || "this topic"} yet.
              Refresh a followed stock topic or select one of your tracked tickers above.
            </div>
          ) : (
            <>
              <div className="stock-news-svg-wrap">
                <svg
                  className="stock-news-svg"
                  viewBox={`0 0 ${geometry.width} ${geometry.height}`}
                  role="img"
                  aria-label={`Stock price vs. news chart for ${graph.activeSymbol || graph.activeTopic} with ${geometry.nodes.length} news events`}
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={strokeColor} stopOpacity="0.28" />
                      <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
                    </linearGradient>
                  </defs>

                  {geometry.yGridLines.map((line, idx) => (
                    <g key={idx}>
                      <line
                        className="stock-news-grid-line"
                        x1={geometry.plotLeft}
                        y1={line.y}
                        x2={geometry.plotRight}
                        y2={line.y}
                      />
                      <text
                        className="stock-news-axis-label"
                        x={geometry.plotLeft - 8}
                        y={line.y + 4}
                        textAnchor="end"
                      >
                        {formatMarketPrice(line.price, activeCurrency)}
                      </text>
                    </g>
                  ))}

                  {geometry.xTicks.map((tick, idx) => (
                    <text
                      key={idx}
                      className="stock-news-axis-label"
                      x={tick.x}
                      y={geometry.height - 10}
                      textAnchor="middle"
                    >
                      {tick.label}
                    </text>
                  ))}

                  <path d={geometry.areaPath} fill={`url(#${gradientId})`} />
                  <path
                    d={geometry.linePath}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />

                  {geometry.nodes.map((node) => {
                    const isSelected = node.index === activeNodeIndex;
                    const fill =
                      node.isPositive === true
                        ? "var(--market-up, #337a4a)"
                        : node.isPositive === false
                          ? "var(--red, #c83f32)"
                          : "var(--sage, #657364)";
                    return (
                      <g
                        key={`${node.event.url}:${node.index}`}
                        className="stock-news-node-group"
                        role="button"
                        tabIndex={0}
                        aria-label={`Story ${node.index + 1}: ${node.event.title} at ${formatMarketPrice(node.event.price, activeCurrency)}`}
                        onClick={() => handleSelectNode(node.index)}
                        onMouseEnter={() => handleSelectNode(node.index)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleSelectNode(node.index);
                          }
                        }}
                      >
                        {isSelected && (
                          <>
                            <line
                              className="stock-news-event-stem"
                              x1={node.x}
                              y1={node.y + 10}
                              x2={node.x}
                              y2={geometry.plotBottom}
                            />
                            <circle
                              className="stock-news-node-halo"
                              cx={node.x}
                              cy={node.y}
                              r={13}
                              stroke={fill}
                            />
                          </>
                        )}
                        <circle
                          className="stock-news-node-circle"
                          cx={node.x}
                          cy={node.y}
                          r={isSelected ? 9.5 : 7.5}
                          fill={fill}
                        />
                        <text className="stock-news-node-label" x={node.x} y={node.y}>
                          {node.index + 1}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
              <div className="stock-news-legend">
                <div className="stock-news-legend-items">
                  <span>
                    <i className="stock-news-legend-dot" style={{ background: "var(--market-up, #337a4a)" }} />
                    News on up move
                  </span>
                  <span>
                    <i className="stock-news-legend-dot" style={{ background: "var(--red, #c83f32)" }} />
                    News on down move
                  </span>
                  <span>
                    <i className="stock-news-legend-dot" style={{ background: "var(--sage, #657364)" }} />
                    Flat / historical close
                  </span>
                </div>
                <span>Hover or tap any numbered pin to inspect that story&apos;s recorded stock quote</span>
              </div>
            </>
          )}
        </div>

        {activeEvent && (
          <section
            className={`stock-news-callout ${activeEvent.percentChange >= 0 ? "positive" : "negative"}`}
            aria-label="Selected news catalyst"
          >
            <div className="stock-news-callout-copy">
              <div className="stock-news-callout-meta">
                <span className="stock-news-snapshot-tag">
                  #{activeNodeIndex + 1} · {activeEvent.isRecordedSnapshot ? "📸 Recorded snapshot" : "📊 Aligned close"}
                </span>
                <span>{activeEvent.source}</span>
                <span>Published {formatEventDateTime(activeEvent.publishedAtUtc)}</span>
                {activeEvent.quoteTime && <span>Quote {activeEvent.quoteTime}</span>}
                {activeEvent.isMarketOpen !== null && (
                  <span>{activeEvent.isMarketOpen ? "Market open" : "Market closed"}</span>
                )}
              </div>
              <h3 className="stock-news-callout-title">{activeEvent.title}</h3>
            </div>
            <div className="stock-news-callout-actions">
              <div className="stock-news-callout-price">
                <strong>{formatMarketPrice(activeEvent.price, activeEvent.currency || activeCurrency)}</strong>
                <span className={activeEvent.percentChange > 0 ? "positive" : activeEvent.percentChange < 0 ? "negative" : ""}>
                  {activeEvent.percentChange > 0 ? "+" : ""}
                  {activeEvent.percentChange.toFixed(2)}%
                </span>
              </div>
              {geometry && geometry.nodes.length > 1 && (
                <>
                  <button
                    type="button"
                    className="stock-news-nav-btn"
                    disabled={activeNodeIndex <= 0}
                    onClick={() => handleSelectNode(activeNodeIndex - 1)}
                    aria-label="Previous news story on chart"
                  >
                    &larr; Prev
                  </button>
                  <button
                    type="button"
                    className="stock-news-nav-btn"
                    disabled={activeNodeIndex >= geometry.nodes.length - 1}
                    onClick={() => handleSelectNode(activeNodeIndex + 1)}
                    aria-label="Next news story on chart"
                  >
                    Next &rarr;
                  </button>
                </>
              )}
              {onOpenArticle && (
                <button
                  type="button"
                  className="stock-news-read-btn"
                  onClick={() => {
                    onClose();
                    onOpenArticle(activeEvent.url);
                  }}
                >
                  Read Story &rarr;
                </button>
              )}
            </div>
          </section>
        )}

        {graph.events.length > 0 && (
          <div>
            <div className="stock-news-ledger-heading">
              <span>Recorded Price vs. News Timeline ({graph.events.length})</span>
              <span>Newest first</span>
            </div>
            <div className="stock-news-ledger">
              {graph.events
                .slice()
                .reverse()
                .slice(0, ledgerLimit)
                .map((ev, revIdx) => {
                  const nodeMatch = geometry?.nodes.find(
                    (n) => n.event.url.trim().toLowerCase() === ev.url.trim().toLowerCase(),
                  );
                  const isSelected = activeEvent?.url.trim().toLowerCase() === ev.url.trim().toLowerCase();
                  const dirClass =
                    ev.percentChange > 0.001 ? "positive" : ev.percentChange < -0.001 ? "negative" : "";
                  return (
                    <div
                      key={`${ev.url}:${revIdx}`}
                      className={`stock-news-ledger-item${isSelected ? " selected" : ""}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedEventUrl(ev.url)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedEventUrl(ev.url);
                        }
                      }}
                    >
                      <div className="stock-news-ledger-left">
                        <span className={`stock-news-ledger-index ${dirClass}`}>
                          {nodeMatch ? nodeMatch.index + 1 : "•"}
                        </span>
                        <div>
                          <span className="stock-news-ledger-title">{ev.title}</span>
                          <span className="stock-news-ledger-meta">
                            {ev.source} · {formatEventDateTime(ev.publishedAtUtc)}
                            {ev.isRecordedSnapshot ? " · Snapshot saved" : " · Close aligned"}
                          </span>
                        </div>
                      </div>
                      <div className="stock-news-ledger-right">
                        <div className="stock-news-ledger-price">
                          <strong>{formatMarketPrice(ev.price, ev.currency || activeCurrency)}</strong>
                          <small className={dirClass}>
                            {ev.percentChange > 0 ? "+" : ""}
                            {ev.percentChange.toFixed(2)}%
                          </small>
                        </div>
                        {onOpenArticle && (
                          <button
                            type="button"
                            className="stock-news-nav-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              onClose();
                              onOpenArticle(ev.url);
                            }}
                          >
                            Read
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
            {graph.events.length > ledgerLimit && (
              <div style={{ marginTop: "0.75rem", textAlign: "center" }}>
                <button
                  type="button"
                  className="stock-news-nav-btn"
                  onClick={() => setLedgerLimit((prev) => prev + 150)}
                >
                  Show {Math.min(150, graph.events.length - ledgerLimit)} more ({graph.events.length - ledgerLimit} remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
