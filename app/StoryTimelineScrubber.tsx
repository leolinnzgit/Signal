"use client";

import React, { useState } from "react";
import type { TimelineMilestone } from "./daily-briefing-timeline";

export interface StoryTimelineScrubberProps {
  topic: string;
  milestones: TimelineMilestone[];
  onClose?: () => void;
}

export default function StoryTimelineScrubber({
  topic,
  milestones,
  onClose,
}: StoryTimelineScrubberProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (!milestones || milestones.length === 0) return null;

  const current = milestones[activeIndex] || milestones[0];

  return (
    <div className="story-timeline-card" role="region" aria-label={`Story Evolution Timeline: ${topic}`}>
      <div className="timeline-card-header">
        <div className="timeline-header-info">
          <span className="timeline-badge">⏱️ STORY EVOLUTION TIMELINE</span>
          <h3 className="timeline-topic-title">{topic}</h3>
        </div>
        {onClose && (
          <button type="button" className="timeline-close-btn" onClick={onClose} aria-label="Close timeline">
            ✕
          </button>
        )}
      </div>

      {/* Interactive Step Strip */}
      <div className="timeline-stepper" role="tablist" aria-label="Milestone Stages">
        {milestones.map((m, idx) => {
          const isActive = idx === activeIndex;
          const phaseClass = m.phase.toLowerCase().replace(/[^a-z0-9]/g, "-");
          return (
            <button
              key={`${m.phase}-${idx}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`timeline-step-btn ${isActive ? "is-active" : ""} phase-${phaseClass}`}
              onClick={() => setActiveIndex(idx)}
            >
              <span className="timeline-step-dot" aria-hidden="true" />
              <span className="timeline-step-phase">{m.phase}</span>
              <span className="timeline-step-date">{m.dateOrEra}</span>
            </button>
          );
        })}
      </div>

      {/* Active Milestone Card */}
      <div className="timeline-milestone-body">
        <div className="milestone-pill-row">
          <span className={`milestone-phase-pill ${current.phase.toLowerCase().replace(/[^a-z0-9]/g, "-")}`}>
            {current.phase}
          </span>
          <span className="milestone-date-label">{current.dateOrEra}</span>
          {current.source && (
            <span className="milestone-source-label">Source: {current.source}</span>
          )}
        </div>

        <h4 className="milestone-headline">{current.headline}</h4>
        <p className="milestone-summary">{current.summary}</p>

        {current.sourceUrl && (
          <a
            href={current.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="milestone-link"
          >
            Read coverage from {current.source || "publisher"} &rarr;
          </a>
        )}
      </div>
    </div>
  );
}
