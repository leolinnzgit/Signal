import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  EXECUTIVE_SUITES,
  ExecutiveSuite,
  SuiteCategory,
  filterExecutiveSuites,
  getCategoryCounts,
  getRecentSuites,
  recordRecentSuite,
} from "./executive-command-center.ts";
import "./executive-command-center.css";

export interface ExecutiveCommandCenterProps {
  onOpenRadar: () => void;
  onOpenCrisisWarRoom: () => void;
  onOpenCyberIncident: () => void;
  onOpenSanctionsRadar: () => void;
  onOpenSupplyChain: () => void;
  onOpenRegulatoryRadar: () => void;
  onOpenKnowledgeGraph: () => void;
  onOpenHorizonScanner: () => void;
  onOpenCompetitorRadar: () => void;
  onOpenMarketHeatmap: () => void;
  onOpenScenarioSim: () => void;
  onOpenClaimsArbiter: () => void;
  onOpenCSuiteReport: () => void;
  onOpenMeetingPrep: () => void;
  onOpenQuoteExtractor: () => void;
  onOpenCommute: () => void;
  onOpenClockRadio: () => void;
  onOpenQuietHours: () => void;
}

export function ExecutiveCommandCenter(props: ExecutiveCommandCenterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<SuiteCategory>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSuites, setRecentSuites] = useState<ExecutiveSuite[]>([]);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Map suite IDs to handler functions
  const handlerMap = useMemo<Record<string, () => void>>(() => {
    return {
      "radar": props.onOpenRadar,
      "crisis-war-room": props.onOpenCrisisWarRoom,
      "cyber-incident": props.onOpenCyberIncident,
      "sanctions-radar": props.onOpenSanctionsRadar,
      "supply-chain": props.onOpenSupplyChain,
      "regulatory-radar": props.onOpenRegulatoryRadar,
      "knowledge-graph": props.onOpenKnowledgeGraph,
      "horizon-scanner": props.onOpenHorizonScanner,
      "competitor-radar": props.onOpenCompetitorRadar,
      "market-heatmap": props.onOpenMarketHeatmap,
      "scenario-simulator": props.onOpenScenarioSim,
      "claims-arbiter": props.onOpenClaimsArbiter,
      "csuite-report": props.onOpenCSuiteReport,
      "meeting-prep": props.onOpenMeetingPrep,
      "quote-extractor": props.onOpenQuoteExtractor,
      "commute-playlist": props.onOpenCommute,
      "clock-radio": props.onOpenClockRadio,
      "quiet-hours": props.onOpenQuietHours,
    };
  }, [props]);

  // Load recent suites on mount and when menu opens
  useEffect(() => {
    if (isOpen) {
      setRecentSuites(getRecentSuites(EXECUTIVE_SUITES));
    }
  }, [isOpen]);

  // Filtered list of suites
  const filteredSuites = useMemo(() => {
    return filterExecutiveSuites(EXECUTIVE_SUITES, searchQuery, selectedCategory);
  }, [searchQuery, selectedCategory]);

  // Category counts
  const categoryCounts = useMemo(() => {
    return getCategoryCounts(EXECUTIVE_SUITES);
  }, []);

  // Reset active index when query or category changes
  useEffect(() => {
    setActiveIndex(0);
  }, [searchQuery, selectedCategory]);

  // Focus search input on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Launch a suite
  const launchSuite = useCallback((suiteId: string) => {
    recordRecentSuite(suiteId);
    setIsOpen(false);
    setSearchQuery("");
    const handler = handlerMap[suiteId];
    if (handler) {
      handler();
    }
  }, [handlerMap]);

  // Global keyboard shortcut (Ctrl+K or Cmd+K) to open/toggle
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Keyboard navigation inside menu
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev < filteredSuites.length - 1 ? prev + 1 : 0));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : filteredSuites.length - 1));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (filteredSuites[activeIndex]) {
        launchSuite(filteredSuites[activeIndex].id);
      }
    }
  };

  return (
    <div className="executive-command-center-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={`command-center-header-trigger${isOpen ? " is-active" : ""}`}
        onClick={() => setIsOpen((prev) => !prev)}
        title="Executive Command Center & Intelligence Suites (⌘K / Ctrl+K)"
        aria-label="Open Executive Command Center"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <span className="command-center-trigger-icon" aria-hidden="true">⚡</span>
        <span className="command-center-trigger-label">Intelligence Hub</span>
        <span className="command-center-trigger-badge">18</span>
        <span className={`command-center-trigger-chevron${isOpen ? " open" : ""}`} aria-hidden="true">▾</span>
      </button>

      {isOpen && (
        <>
          <div className="command-center-backdrop" onClick={() => setIsOpen(false)} aria-hidden="true" />
          <div
            ref={containerRef}
            className="command-center-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Executive Intelligence Command Center"
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="command-center-header">
              <div className="command-center-title-row">
                <div className="command-center-title">
                  <span className="command-center-badge-icon" aria-hidden="true">⚡</span>
                  <div>
                    <h2>Executive Command Center</h2>
                    <p>18 Specialized Intelligence Radars & Decision Suites</p>
                  </div>
                </div>
                <div className="command-center-header-actions">
                  <span className="command-center-key-hint">⌘K / Esc</span>
                  <button
                    type="button"
                    className="command-center-close-btn"
                    onClick={() => setIsOpen(false)}
                    aria-label="Close Command Center"
                  >
                    &times;
                  </button>
                </div>
              </div>

              {/* Search Bar */}
              <div className="command-center-search-wrap">
                <span className="command-center-search-icon" aria-hidden="true">🔍</span>
                <input
                  ref={searchInputRef}
                  type="text"
                  className="command-center-search-input"
                  placeholder="Filter 18 suites... (e.g. radar, m&a, sanctions, supply chain, audio)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  aria-label="Search intelligence suites"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="command-center-search-clear"
                    onClick={() => setSearchQuery("")}
                    aria-label="Clear search"
                  >
                    &times;
                  </button>
                )}
              </div>

              {/* Category Filter Tabs */}
              <div className="command-center-category-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedCategory === "all"}
                  className={`command-center-tab${selectedCategory === "all" ? " is-active" : ""}`}
                  onClick={() => setSelectedCategory("all")}
                >
                  All ({categoryCounts.all})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedCategory === "risk"}
                  className={`command-center-tab${selectedCategory === "risk" ? " is-active" : ""}`}
                  onClick={() => setSelectedCategory("risk")}
                >
                  🛡️ Risk & Defense ({categoryCounts.risk})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedCategory === "strategy"}
                  className={`command-center-tab${selectedCategory === "strategy" ? " is-active" : ""}`}
                  onClick={() => setSelectedCategory("strategy")}
                >
                  🌐 Strategy & Foresight ({categoryCounts.strategy})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedCategory === "workflow"}
                  className={`command-center-tab${selectedCategory === "workflow" ? " is-active" : ""}`}
                  onClick={() => setSelectedCategory("workflow")}
                >
                  ⚡ Executive Ops ({categoryCounts.workflow})
                </button>
              </div>
            </div>

            {/* Quick Recent Section */}
            {!searchQuery && selectedCategory === "all" && recentSuites.length > 0 && (
              <div className="command-center-recent-strip">
                <span className="command-center-recent-label">Recently Launched:</span>
                <div className="command-center-recent-pills">
                  {recentSuites.map((suite) => (
                    <button
                      key={`recent-${suite.id}`}
                      type="button"
                      className="command-center-recent-pill"
                      onClick={() => launchSuite(suite.id)}
                    >
                      <span className="recent-pill-icon">{suite.icon}</span>
                      <span className="recent-pill-title">{suite.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Suites Content List */}
            <div ref={listRef} className="command-center-suite-list" role="list">
              {filteredSuites.length === 0 ? (
                <div className="command-center-empty">
                  <span className="command-center-empty-icon" aria-hidden="true">🔎</span>
                  <p>No intelligence suites match &ldquo;{searchQuery}&rdquo;</p>
                  <button
                    type="button"
                    className="command-center-empty-clear"
                    onClick={() => {
                      setSearchQuery("");
                      setSelectedCategory("all");
                    }}
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                filteredSuites.map((suite, index) => {
                  const isActive = index === activeIndex;
                  return (
                    <div
                      key={suite.id}
                      role="listitem"
                      className={`command-center-suite-card${isActive ? " is-keyboard-selected" : ""}`}
                      onClick={() => launchSuite(suite.id)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <div className="suite-card-icon-wrap" aria-hidden="true">
                        <span className="suite-card-icon">{suite.icon}</span>
                      </div>
                      <div className="suite-card-main">
                        <div className="suite-card-title-row">
                          <h3 className="suite-card-title">{suite.title}</h3>
                          <span className={`suite-card-tag tag-${suite.category}`}>
                            {suite.categoryLabel}
                          </span>
                        </div>
                        <p className="suite-card-subtitle">{suite.subtitle}</p>
                      </div>
                      <div className="suite-card-action" aria-hidden="true">
                        <span className="suite-card-arrow">&rarr;</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="command-center-footer">
              <span className="command-center-footer-status">
                <span className="command-center-live-dot" aria-hidden="true" />
                18 Executive Intelligence Suites Active
              </span>
              <span className="command-center-footer-shortcuts">
                Use <kbd>&uarr;</kbd> <kbd>&darr;</kbd> to navigate, <kbd>Enter</kbd> to launch, <kbd>Esc</kbd> to dismiss
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
