"use client";

import { useEffect, useState } from "react";
import { findFollowedTopic, getEntityIcon, loadArticleEntities, type RecognizedEntity } from "./article-entities";
import { loadArticleSentiment, getSentimentIcon, type ArticleSentimentResponse } from "./article-sentiment";
import { calculateEntityFrequency } from "./entity-frequency";
import type { FollowedArticle } from "./NewsDashboard";
import { recordReadArticleEntities } from "./suggested-topics";
import "./article-entities.css";

export default function ArticleEntities({
  url,
  title,
  paragraphs,
  followedTopics,
  onFollow,
  onOpenTopic,
  onFindRelatedStories,
  liveArticles,
}: {
  url: string;
  title: string;
  paragraphs: string[];
  /** Topics the reader already follows; matching chips show as followed. */
  followedTopics: string[];
  /** Quick-adds an entity as a followed topic without leaving the reader. */
  onFollow: (entityText: string) => void;
  /** Opens the feed for an entity that is already followed. */
  onOpenTopic: (topic: string) => void;
  /** Opens related stories modal for an entity. */
  onFindRelatedStories?: (entityText: string) => void;
  /** Live articles for calculating mention frequency and trends. */
  liveArticles?: FollowedArticle[];
}) {
  const [entities, setEntities] = useState<RecognizedEntity[]>([]);
  const [sentiment, setSentiment] = useState<ArticleSentimentResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url && (!paragraphs || paragraphs.length === 0)) return;
    const abort = new AbortController();
    setLoading(true);

    const nerPromise = loadArticleEntities(url, title, paragraphs, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted && res.available) {
          const loaded = res.entities || [];
          setEntities(loaded);
          if (loaded.length > 0) recordReadArticleEntities(url, loaded);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setEntities([]);
      });

    const sentimentPromise = loadArticleSentiment(url, title, paragraphs, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted && res.available) {
          setSentiment(res);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setSentiment(null);
      });

    Promise.allSettled([nerPromise, sentimentPromise]).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });

    return () => abort.abort();
  }, [url, title, paragraphs]);

  if (!loading && entities.length === 0 && !sentiment) return null;

  return (
    <div className="article-entities-container" role="group" aria-label="Key topics and tone in this story">
      <div className="article-entities-header">
        <div className="article-entities-header-left">
          <span className="article-entities-label">Key Topics &amp; Entities</span>
          {sentiment && sentiment.available && (
            <span
              className={`article-sentiment-pill sentiment-${sentiment.sentiment}`}
              title={`Tone: ${sentiment.sentiment} (${Math.round(sentiment.positiveScore * 100)}% positive, ${Math.round(sentiment.neutralScore * 100)}% neutral, ${Math.round(sentiment.negativeScore * 100)}% negative)`}
            >
              <span className="sentiment-icon" aria-hidden="true">{getSentimentIcon(sentiment.sentiment)}</span>
              <span className="sentiment-text">{sentiment.sentiment.charAt(0).toUpperCase() + sentiment.sentiment.slice(1)}</span>
            </span>
          )}
        </div>
        {loading && <span className="article-entities-spinner" aria-hidden="true" />}
        {!loading && <span className="article-entities-hint">Tap + to follow · 📰 for stories</span>}
      </div>
      {entities.length > 0 && (
        <div className="article-entities-list">
          {entities.map((entity, index) => {
            const followed = findFollowedTopic(followedTopics, entity.text);
            const freq = liveArticles ? calculateEntityFrequency(entity.text, liveArticles) : null;
            return (
              <div
                key={`${entity.category}-${entity.text}-${index}`}
                className={`article-entity-group${followed ? " followed" : ""}`}
              >
                <button
                  type="button"
                  className="article-entity-chip"
                  aria-label={followed
                    ? `Following ${followed}. Open its stories.`
                    : `Follow ${entity.text} as a topic`}
                  title={followed
                    ? `${entity.category}: following ${followed} — tap to open its stories`
                    : `${entity.category}: tap to follow ${entity.text}`}
                  onClick={() => (followed ? onOpenTopic(followed) : onFollow(entity.text))}
                >
                  <span className="entity-icon" aria-hidden="true">
                    {getEntityIcon(entity.category)}
                  </span>
                  <span className="entity-name">{entity.text}</span>
                  {freq && freq.totalMentions >= 2 && (
                    <span
                      className={`entity-frequency-pill${freq.trend === "surging" ? " surging" : ""}`}
                      title={freq.trend === "surging" ? `Surging in news (${freq.totalMentions} stories)` : `${freq.totalMentions} stories this week`}
                    >
                      {freq.trend === "surging" ? "📈" : freq.totalMentions}
                    </span>
                  )}
                  <span className="entity-follow-state" aria-hidden="true">{followed ? "✓" : "+"}</span>
                </button>
                {onFindRelatedStories && (
                  <button
                    type="button"
                    className="entity-related-stories-btn"
                    aria-label={`Find related stories for ${entity.text}`}
                    title={`Find stories mentioning ${entity.text}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onFindRelatedStories(entity.text);
                    }}
                  >
                    📰
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
