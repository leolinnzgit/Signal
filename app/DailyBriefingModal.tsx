"use client";

import { useEffect, useMemo, useRef } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import {
  buildDailyBriefing,
  type DailyBriefingData,
} from "./daily-briefing";
import type { LocalWeather, WeatherForecastDay, ClientWeatherAlert, ClientWeatherConditions } from "./weather-briefing";
import type { MarketQuote } from "./market-quote";
import type { EntityPulseSummary } from "./entity-pulse";
import { useSpokenBriefing } from "./useSpokenBriefing";
import "./daily-briefing.css";

function getWeatherIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code === 1 || code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "❄️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95 && code <= 99) return "⛈️";
  return "🌤️";
}

export default function DailyBriefingModal({
  isOpen,
  onClose,
  weather,
  forecast = [],
  alerts = [],
  conditions,
  marketQuote,
  pulse,
  articles = [],
  onOpenArticle,
  onListenArticle,
  userTime,
}: {
  isOpen: boolean;
  onClose: () => void;
  weather?: LocalWeather | null;
  forecast?: WeatherForecastDay[];
  alerts?: ClientWeatherAlert[];
  conditions?: ClientWeatherConditions | null;
  marketQuote?: MarketQuote | null;
  pulse?: EntityPulseSummary | null;
  articles?: FollowedArticle[];
  onOpenArticle?: (article: FollowedArticle) => void;
  onListenArticle?: (article: FollowedArticle) => void;
  userTime?: Date;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const speech = useSpokenBriefing();
  const stopBriefing = speech.stop;

  const briefing: DailyBriefingData = useMemo(() => {
    return buildDailyBriefing({
      weather,
      forecast,
      alerts,
      conditions,
      marketQuote,
      pulse,
      articles,
      userTime,
      maxLeadStories: 4,
    });
  }, [weather, forecast, alerts, conditions, marketQuote, pulse, articles, userTime]);

  // Manage native dialog open/close lifecycle
  useEffect(() => {
    if (!isOpen) {
      stopBriefing();
      return;
    }

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      stopBriefing();
      if (dialog && dialog.open) {
        dialog.close();
      }
    };
  }, [isOpen, onClose, stopBriefing]);

  if (!isOpen) return null;

  const isAudioActive = speech.status === "starting" || speech.status === "playing";

  const handleAudioToggle = () => {
    if (isAudioActive) {
      speech.stop();
    } else {
      speech.speak(briefing.spokenScript);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="daily-briefing-dialog"
      aria-labelledby="daily-briefing-title"
      onMouseDown={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="daily-briefing-card">
        {/* Header */}
        <header className="daily-briefing-header">
          <div className="daily-briefing-title-group">
            <span className="daily-briefing-edition-badge">
              🗞️ {briefing.edition.toUpperCase()} DIGEST
            </span>
            <h2 id="daily-briefing-title" className="daily-briefing-title">
              Executive Daily Briefing
            </h2>
            <p className="daily-briefing-subtitle">
              {briefing.greeting} &bull; {briefing.formattedDate}
            </p>
          </div>
          <div className="daily-briefing-header-actions">
            <button
              type="button"
              className={`daily-briefing-audio-btn ${isAudioActive ? "active" : ""}`}
              onClick={handleAudioToggle}
              title={isAudioActive ? "Stop voice briefing" : "Listen to neural spoken briefing"}
              aria-label={isAudioActive ? "Stop voice briefing" : "Listen to neural spoken briefing"}
            >
              {speech.status === "starting" ? (
                <>⏳ Starting...</>
              ) : speech.status === "playing" ? (
                <>
                  <span className="audio-wave-bars" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  ⏹ Stop Audio
                </>
              ) : (
                <>🔊 Listen to Briefing</>
              )}
            </button>
            <button
              type="button"
              className="daily-briefing-close-btn"
              onClick={onClose}
              title="Close briefing"
              aria-label="Close executive briefing"
            >
              &times;
            </button>
          </div>
        </header>

        {/* Glance KPI Grid */}
        <section className="daily-briefing-glance-grid" aria-label="Executive briefing glance">
          {/* Weather Glance */}
          <article className="glance-card weather-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">
                {briefing.weatherGlance ? getWeatherIcon(briefing.weatherGlance.weatherCode) : "⛅"}
              </span>
              <span className="glance-card-label">Local Weather</span>
            </div>
            {briefing.weatherGlance ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>{briefing.weatherGlance.temperature}&deg;C</strong>
                  <span className="glance-stat-condition">{briefing.weatherGlance.condition}</span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.weatherGlance.location}</span>
                  {briefing.weatherGlance.high !== undefined && (
                    <span> &bull; H: {briefing.weatherGlance.high}&deg; / L: {briefing.weatherGlance.low}&deg;</span>
                  )}
                </p>
                {briefing.weatherGlance.alertsCount > 0 && (
                  <div className="glance-alert-pill" title={briefing.weatherGlance.topAlertHeadline}>
                    ⚠️ {briefing.weatherGlance.alertsCount} weather alert active
                  </div>
                )}
              </div>
            ) : (
              <div className="glance-card-empty">Local weather unavailable</div>
            )}
          </article>

          {/* Market Glance */}
          <article className="glance-card market-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">📈</span>
              <span className="glance-card-label">Financial Markets</span>
            </div>
            {briefing.marketGlance ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>{briefing.marketGlance.symbol}</strong>
                  <span
                    className={`glance-stat-pill ${
                      briefing.marketGlance.change > 0
                        ? "positive"
                        : briefing.marketGlance.change < 0
                          ? "negative"
                          : "neutral"
                    }`}
                  >
                    {briefing.marketGlance.change > 0 ? "+" : ""}
                    {briefing.marketGlance.percentChange.toFixed(2)}%
                  </span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.marketGlance.name}</span>
                  <span> &bull; {briefing.marketGlance.formattedPrice}</span>
                </p>
              </div>
            ) : (
              <div className="glance-card-empty">
                Follow a stock or index topic to see live quotes
              </div>
            )}
          </article>

          {/* Pulse Momentum Glance */}
          <article className="glance-card pulse-glance">
            <div className="glance-card-header">
              <span className="glance-card-icon" aria-hidden="true">⚡</span>
              <span className="glance-card-label">Topic Momentum</span>
            </div>
            {briefing.pulseGlance && briefing.pulseGlance.totalTracked > 0 ? (
              <div className="glance-card-content">
                <div className="glance-main-stat">
                  <strong>
                    {briefing.pulseGlance.topSurgingTopic || `${briefing.pulseGlance.totalTracked} Topics`}
                  </strong>
                  <span className="glance-sentiment-badge">
                    {briefing.pulseGlance.sentimentToneLabel}
                  </span>
                </div>
                <p className="glance-subtext">
                  <span>{briefing.pulseGlance.totalMentions} mentions this week</span>
                  {briefing.pulseGlance.surgingCount > 0 && (
                    <span> &bull; {briefing.pulseGlance.surgingCount} surging</span>
                  )}
                </p>
              </div>
            ) : (
              <div className="glance-card-empty">Follow topics to monitor momentum</div>
            )}
          </article>
        </section>

        {/* Lead Stories */}
        <section className="daily-briefing-lead-stories" aria-label="Lead news stories">
          <div className="daily-briefing-section-heading">
            <h3>Lead Stories</h3>
            {briefing.unreadCount > 0 && (
              <span className="unread-counter-badge">
                {briefing.unreadCount} unread
              </span>
            )}
          </div>

          {briefing.leadStories.length === 0 ? (
            <div className="daily-briefing-empty-stories">
              No recent news stories found for your followed topics.
            </div>
          ) : (
            <div className="daily-briefing-story-list">
              {briefing.leadStories.map((story) => {
                const articleRecord = articles.find((a) => a.url === story.url);
                return (
                  <article key={story.url} className="briefing-story-item">
                    <div className="briefing-story-meta">
                      <span className="briefing-story-source">{story.source}</span>
                      {story.isRead ? (
                        <span className="briefing-story-read-indicator">Read</span>
                      ) : (
                        <span className="briefing-story-unread-indicator">New</span>
                      )}
                    </div>
                    <h4 className="briefing-story-title">
                      {onOpenArticle && articleRecord ? (
                        <button
                          type="button"
                          className="briefing-story-title-link"
                          onClick={() => {
                            onClose();
                            onOpenArticle(articleRecord);
                          }}
                        >
                          {story.title}
                        </button>
                      ) : (
                        <a href={story.url} target="_blank" rel="noopener noreferrer">
                          {story.title}
                        </a>
                      )}
                    </h4>
                    {story.summary && (
                      <p className="briefing-story-summary">{story.summary}</p>
                    )}
                    <div className="briefing-story-actions">
                      {onOpenArticle && articleRecord && (
                        <button
                          type="button"
                          className="briefing-story-action-btn"
                          onClick={() => {
                            onClose();
                            onOpenArticle(articleRecord);
                          }}
                        >
                          Read in Signal &rarr;
                        </button>
                      )}
                      {onListenArticle && articleRecord && (
                        <button
                          type="button"
                          className="briefing-story-action-btn secondary"
                          onClick={() => onListenArticle(articleRecord)}
                          title="Listen to story headline"
                        >
                          🔊 Listen
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Spoken Script Transcript Accordion */}
        <details className="daily-briefing-transcript-section">
          <summary className="daily-briefing-transcript-summary">
            📜 View Full Narration Transcript
          </summary>
          <div className="daily-briefing-transcript-body">
            <p>{briefing.spokenScript}</p>
          </div>
        </details>
      </div>
    </dialog>
  );
}
