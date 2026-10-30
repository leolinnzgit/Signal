"use client";

import { useEffect, useState } from "react";
import { findFollowedTopic, getEntityIcon, loadArticleEntities, type RecognizedEntity } from "./article-entities";
import "./article-entities.css";

export default function ArticleEntities({
  url,
  title,
  paragraphs,
  followedTopics,
  onFollow,
  onOpenTopic,
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
}) {
  const [entities, setEntities] = useState<RecognizedEntity[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url && (!paragraphs || paragraphs.length === 0)) return;
    const abort = new AbortController();
    setLoading(true);

    loadArticleEntities(url, title, paragraphs, abort.signal)
      .then((res) => {
        if (!abort.signal.aborted && res.available) {
          setEntities(res.entities || []);
        }
      })
      .catch(() => {
        // Fall back quietly if Azure Language is disabled or unconfigured
        if (!abort.signal.aborted) setEntities([]);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });

    return () => abort.abort();
  }, [url, title, paragraphs]);

  if (!loading && entities.length === 0) return null;

  return (
    <div className="article-entities-container" role="group" aria-label="Key topics and entities in this story">
      <div className="article-entities-header">
        <span className="article-entities-label">Key Topics &amp; Entities</span>
        {loading && <span className="article-entities-spinner" aria-hidden="true" />}
        {!loading && <span className="article-entities-hint">Tap to follow</span>}
      </div>
      <div className="article-entities-list">
        {entities.map((entity, index) => {
          const followed = findFollowedTopic(followedTopics, entity.text);
          return (
            <button
              key={`${entity.category}-${entity.text}-${index}`}
              type="button"
              className={`article-entity-chip${followed ? " followed" : ""}`}
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
              <span className="entity-follow-state" aria-hidden="true">{followed ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
