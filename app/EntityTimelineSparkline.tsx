"use client";

import type { EntityFrequencyStats } from "./entity-frequency";
import "./entity-frequency.css";

export default function EntityTimelineSparkline({
  stats,
}: {
  stats: EntityFrequencyStats;
}) {
  const maxCount = Math.max(1, ...stats.timeline.map((p) => p.count));

  const getTrendIcon = () => {
    switch (stats.trend) {
      case "surging":
        return "📈";
      case "rising":
        return "↗️";
      case "steady":
        return "📊";
      case "recent":
        return "✨";
      default:
        return "📰";
    }
  };

  return (
    <div
      className="entity-timeline-card"
      role="region"
      aria-label={`Mention frequency for ${stats.entity}`}
    >
      <div className="entity-timeline-header">
        <div className="entity-timeline-title">
          <span className="entity-timeline-count">
            {stats.totalMentions} {stats.totalMentions === 1 ? "story" : "stories"}
          </span>
          <span className="entity-timeline-sub">past {stats.days} days</span>
        </div>
        <span className={`entity-trend-badge trend-${stats.trend}`}>
          <span className="trend-icon" aria-hidden="true">{getTrendIcon()}</span>
          <span className="trend-text">{stats.trendLabel}</span>
        </span>
      </div>

      <div
        className="entity-sparkline"
        role="img"
        aria-label={`7-day mention activity: ${stats.timeline.map((p) => `${p.label} ${p.count}`).join(", ")}`}
      >
        {stats.timeline.map((point) => {
          const heightPercent = point.count === 0 ? 8 : Math.max(14, Math.round((point.count / maxCount) * 100));
          const isPeak = point.count > 0 && point.count === stats.peakCount;
          return (
            <div
              key={point.date}
              className={`entity-sparkline-bar-wrapper${isPeak ? " peak" : ""}`}
              title={`${point.label} (${point.date}): ${point.count} ${point.count === 1 ? "story" : "stories"}`}
            >
              <div className="entity-sparkline-track">
                <div
                  className="entity-sparkline-fill"
                  style={{ height: `${heightPercent}%` }}
                />
              </div>
              <span className="entity-sparkline-label">{point.label}</span>
              {point.count > 0 && (
                <span className="entity-sparkline-count" aria-hidden="true">
                  {point.count}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
