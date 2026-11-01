"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import type { SignalArticleLink } from "./article-link";
import { getEntityIcon } from "./article-entities";
import { getSentimentIcon } from "./article-sentiment";
import {
  buildEntityPulse,
  buildEntityPulseBriefing,
  sortPulseItems,
  type EntityPulseSort,
} from "./entity-pulse";
import { loadStoredEntityHistory, type SuggestedTopic } from "./suggested-topics";
import EntityTimelineSparkline from "./EntityTimelineSparkline";
import { useSpokenBriefing } from "./useSpokenBriefing";
import VoiceMicButton from "./VoiceMicButton";
import "./entity-pulse.css";

export default function EntityPulseModal({
  isOpen,
  topics,
  articles,
  suggestedTopics = [],
  onClose,
  onSelectTopic,
  onUnfollowTopic,
  onFindRelatedStories,
  onOpenArticle,
  onFollowTopic,
}: {
  isOpen: boolean;
  topics: string[];
  articles: FollowedArticle[];
  suggestedTopics?: SuggestedTopic[];
  onClose: () => void;
  onSelectTopic: (topic: string) => void;
  onUnfollowTopic: (topic: string) => void;
  onFindRelatedStories: (topic: string) => void;
  onOpenArticle: (article: SignalArticleLink) => void;
  onFollowTopic: (topic: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<EntityPulseSort>("momentum");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const pulseAudio = useSpokenBriefing();
  const stopPulseAudio = pulseAudio.stop;

  const storedHistory = useMemo(() => {
    if (typeof window === "undefined") return [];
    return loadStoredEntityHistory();
  }, [isOpen]);

  const pulse = useMemo(() => {
    return buildEntityPulse(topics, articles, storedHistory, 7);
  }, [topics, articles, storedHistory, isOpen]);

  const filteredItems = useMemo(() => {
    let result = pulse.items;

    // Filter by category / surging / sentiment tone
    if (categoryFilter === "surging") {
      result = result.filter((i) => i.stats.trend === "surging");
    } else if (categoryFilter === "positive") {
      result = result.filter((i) => i.sentiment.dominantTone === "positive");
    } else if (categoryFilter === "critical") {
      result = result.filter((i) => i.sentiment.dominantTone === "negative");
    } else if (categoryFilter !== "all") {
      result = result.filter((i) => i.category.toLowerCase() === categoryFilter.toLowerCase());
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (i) =>
          i.topic.toLowerCase().includes(q) ||
          (i.latestArticle && i.latestArticle.title.toLowerCase().includes(q)),
      );
    }

    return sortPulseItems(result, sortBy);
  }, [pulse.items, categoryFilter, searchQuery, sortBy]);

  useEffect(() => {
    if (!isOpen) {
      stopPulseAudio();
      return;
    }
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      stopPulseAudio();
      if (dialog && dialog.open) dialog.close();
    };
  }, [isOpen, stopPulseAudio]);

  if (!isOpen) return null;

  function handleClose() {
    stopPulseAudio();
    onClose();
  }

  function togglePulseBriefing() {
    if (pulseAudio.isActive) {
      pulseAudio.stop();
    } else {
      pulseAudio.speak(buildEntityPulseBriefing(pulse));
    }
  }

  const categories = ["all", "surging", "positive", "critical", "person", "organization", "location"];
  const overall = pulse.overallSentiment;

  let overallKpiDisplay = "—";
  if (overall.analyzedCount > 0) {
    if (overall.dominantTone === "positive") {
      overallKpiDisplay = `😊 ${overall.positivePercent}%`;
    } else if (overall.dominantTone === "negative") {
      overallKpiDisplay = `😟 ${overall.negativePercent}%`;
    } else if (overall.dominantTone === "mixed") {
      overallKpiDisplay = "⚖️ Split";
    } else {
      overallKpiDisplay = "😐 Neutral";
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="entity-pulse-dialog"
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) handleClose();
      }}
    >
      <div className="entity-pulse-modal-card">
        {/* Modal Header */}
        <div className="entity-pulse-modal-header">
          <div className="entity-pulse-header-info">
            <h2>Tracked Topics &amp; Entity Pulse</h2>
            <p>7-day momentum, sentiment tone distribution, and latest coverage across your followed topics.</p>
          </div>
          <div className="entity-pulse-header-actions">
            <button
              type="button"
              className={`entity-pulse-listen-btn${pulseAudio.isActive ? " active" : ""}`}
              onClick={togglePulseBriefing}
              disabled={pulse.totalTracked === 0}
              aria-pressed={pulseAudio.isActive}
              title={
                pulseAudio.isActive
                  ? "Stop News Pulse audio briefing"
                  : "Listen to a spoken summary of your 7-day Entity Pulse"
              }
            >
              {pulseAudio.status === "starting"
                ? "⏳ Preparing…"
                : pulseAudio.status === "playing"
                  ? "⏹ Stop Briefing"
                  : "🔊 Listen to Pulse"}
            </button>
            <button
              type="button"
              className="entity-pulse-close-btn"
              onClick={handleClose}
              aria-label="Close entity pulse"
            >
              &#215;
            </button>
          </div>
        </div>

        {/* KPI Banner */}
        <div className="entity-pulse-kpi-banner">
          <div className="entity-pulse-kpi-card">
            <span className="kpi-value">{pulse.totalTracked}</span>
            <span className="kpi-label">Followed Topics</span>
          </div>
          <div className={`entity-pulse-kpi-card${pulse.surgingCount > 0 ? " surging-active" : ""}`}>
            <span className="kpi-value">
              {pulse.surgingCount > 0 && <span className="kpi-fire" aria-hidden="true">📈 </span>}
              {pulse.surgingCount}
            </span>
            <span className="kpi-label">Surging in News</span>
          </div>
          <div className="entity-pulse-kpi-card">
            <span className="kpi-value">{pulse.totalMentionsThisWeek}</span>
            <span className="kpi-label">Mentions Past 7 Days</span>
          </div>
          <div
            className={`entity-pulse-kpi-card tone-kpi-${overall.dominantTone}`}
            title={
              overall.analyzedCount > 0
                ? `${overall.toneLabel} (${overall.positiveCount} positive · ${overall.neutralCount + overall.mixedCount} neutral/mixed · ${overall.negativeCount} critical)`
                : "No stories analyzed in current feed"
            }
          >
            <span className="kpi-value">{overallKpiDisplay}</span>
            <span className="kpi-label">
              {overall.dominantTone === "positive"
                ? "Positive Tone"
                : overall.dominantTone === "negative"
                  ? "Critical Tone"
                  : "Weekly Tone"}
            </span>
          </div>
        </div>

        {/* Toolbar & Filters */}
        <div className="entity-pulse-toolbar">
          <div className="entity-pulse-search-wrap">
            <div className="voice-input-row">
              <input
                type="search"
                className="entity-pulse-search"
                placeholder="Filter followed topics…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search followed topics"
              />
              <VoiceMicButton
                label="Filter topics by voice"
                onVoiceCommand={(cmd) => {
                  if (cmd.intent === "all-topics") {
                    setSearchQuery("");
                    setCategoryFilter("all");
                  } else if (cmd.intent === "follow" && cmd.query) {
                    onFollowTopic(cmd.query);
                  } else {
                    setSearchQuery(cmd.query);
                  }
                }}
              />
            </div>
          </div>

          <div className="entity-pulse-sort-wrap">
            <label htmlFor="pulse-sort-select">Sort:</label>
            <select
              id="pulse-sort-select"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as EntityPulseSort)}
            >
              <option value="momentum">🔥 Momentum</option>
              <option value="mentions">📊 Most Stories</option>
              <option value="sentiment-positive">😊 Most Positive Tone</option>
              <option value="sentiment-critical">😟 Most Critical Tone</option>
              <option value="recent">⏱ Most Recent</option>
              <option value="alpha">🔤 Alphabetical</option>
            </select>
          </div>
        </div>

        {/* Category Pills */}
        <div className="entity-pulse-category-pills">
          {categories.map((cat) => {
            let label = "All";
            let count = pulse.items.length;
            if (cat === "surging") {
              label = "Surging 🔥";
              count = pulse.surgingCount;
            } else if (cat === "positive") {
              label = "Positive 😊";
              count = pulse.items.filter((i) => i.sentiment.dominantTone === "positive").length;
            } else if (cat === "critical") {
              label = "Critical 😟";
              count = pulse.items.filter((i) => i.sentiment.dominantTone === "negative").length;
            } else if (cat === "person") {
              label = "People 👤";
              count = pulse.items.filter((i) => i.category.toLowerCase() === "person").length;
            } else if (cat === "organization") {
              label = "Organizations 🏢";
              count = pulse.items.filter((i) => i.category.toLowerCase() === "organization").length;
            } else if (cat === "location") {
              label = "Locations 📍";
              count = pulse.items.filter((i) => i.category.toLowerCase() === "location").length;
            }

            return (
              <button
                key={cat}
                type="button"
                className={`pulse-category-pill${categoryFilter === cat ? " active" : ""}`}
                onClick={() => setCategoryFilter(cat)}
              >
                {label} <span className="cat-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* Main Grid */}
        <div className="entity-pulse-scroll-body">
          {filteredItems.length === 0 ? (
            <div className="entity-pulse-empty">
              <p>No tracked topics match the current filter.</p>
              {searchQuery && (
                <button
                  type="button"
                  className="pulse-reset-search-btn"
                  onClick={() => setSearchQuery("")}
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <div className="entity-pulse-grid">
              {filteredItems.map((item) => {
                const sent = item.sentiment;
                const breakdownSummary = `${sent.positiveCount} positive · ${sent.neutralCount + sent.mixedCount} neutral · ${sent.negativeCount} critical`;
                return (
                  <div key={item.topic} className="entity-pulse-card">
                    {/* Card Header */}
                    <div className="pulse-card-header">
                      <div className="pulse-card-entity-title">
                        <span className="pulse-entity-icon" aria-hidden="true">
                          {getEntityIcon(item.category)}
                        </span>
                        <strong className="pulse-entity-name">{item.topic}</strong>
                      </div>
                      <span className={`entity-trend-badge trend-${item.stats.trend}`}>
                        {item.stats.trend === "surging" && "📈 "}
                        {item.stats.trendLabel}
                      </span>
                    </div>

                    {/* Sparkline */}
                    <EntityTimelineSparkline stats={item.stats} />

                    {/* Sentiment Momentum & Tone Distribution Bar */}
                    {sent.analyzedCount > 0 && (
                      <div className="pulse-sentiment-block" title={breakdownSummary}>
                        <div className="pulse-sentiment-header">
                          <span className={`pulse-sentiment-tone tone-${sent.dominantTone}`}>
                            <span aria-hidden="true">{getSentimentIcon(sent.dominantTone)} </span>
                            {sent.toneLabel}
                          </span>
                          {sent.momentum !== "steady" && (
                            <span className={`pulse-sentiment-momentum momentum-${sent.momentum}`}>
                              {sent.momentum === "improving" ? "↗ Improving" : "↘ Turning critical"}
                            </span>
                          )}
                        </div>
                        <div
                          className="pulse-sentiment-bar"
                          role="img"
                          aria-label={`Sentiment breakdown for ${item.topic}: ${breakdownSummary}`}
                        >
                          {sent.positivePercent > 0 && (
                            <span
                              className="pulse-sentiment-seg seg-positive"
                              style={{ width: `${sent.positivePercent}%` }}
                            />
                          )}
                          {sent.neutralPercent > 0 && (
                            <span
                              className="pulse-sentiment-seg seg-neutral"
                              style={{ width: `${sent.neutralPercent}%` }}
                            />
                          )}
                          {sent.negativePercent > 0 && (
                            <span
                              className="pulse-sentiment-seg seg-negative"
                              style={{ width: `${sent.negativePercent}%` }}
                            />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Latest Headline */}
                    {item.latestArticle ? (
                      <div className="pulse-card-headline">
                        <span className="pulse-headline-label">Latest story:</span>
                        <button
                          type="button"
                          className="pulse-headline-link"
                          onClick={() => {
                            onOpenArticle({
                              url: item.latestArticle!.url,
                              title: item.latestArticle!.title,
                              source: item.latestArticle!.source,
                            });
                            handleClose();
                          }}
                        >
                          {item.latestArticle.title}
                        </button>
                        <small className="pulse-headline-source">
                          {item.latestArticle.source}
                          {item.latestArticle.publishedAt && (
                            <> · {new Date(item.latestArticle.publishedAt).toLocaleDateString()}</>
                          )}
                        </small>
                      </div>
                    ) : (
                      <p className="pulse-card-no-story">No articles mentioning this topic in current feed.</p>
                    )}

                    {/* Card Actions */}
                    <div className="pulse-card-actions">
                      <button
                        type="button"
                        className="pulse-action-btn primary"
                        onClick={() => {
                          onSelectTopic(item.topic);
                          handleClose();
                        }}
                        title={`Filter feed to ${item.topic}`}
                      >
                        View feed ↗
                      </button>
                      <button
                        type="button"
                        className="pulse-action-btn"
                        onClick={() => {
                          onFindRelatedStories(item.topic);
                          handleClose();
                        }}
                        title={`Find all stories for ${item.topic}`}
                      >
                        Stories 📰
                      </button>
                      <button
                        type="button"
                        className="pulse-action-btn danger"
                        onClick={() => onUnfollowTopic(item.topic)}
                        title={`Unfollow ${item.topic}`}
                      >
                        Unfollow &#8722;
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Suggested to Follow */}
          {suggestedTopics.length > 0 && (
            <div className="entity-pulse-suggestions">
              <h3>💡 Trending In Your Reading</h3>
              <p>People, organizations, and places frequently appearing in stories you have read:</p>
              <div className="pulse-suggestions-chips">
                {suggestedTopics.slice(0, 6).map((suggested) => (
                  <div key={suggested.text} className="pulse-suggested-chip">
                    <span className="suggested-icon" aria-hidden="true">
                      {getEntityIcon(suggested.category)}
                    </span>
                    <span className="suggested-text">{suggested.text}</span>
                    <button
                      type="button"
                      className="pulse-suggested-add-btn"
                      onClick={() => onFollowTopic(suggested.text)}
                      title={`Follow ${suggested.text}`}
                    >
                      + Follow
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
