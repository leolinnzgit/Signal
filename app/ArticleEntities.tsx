"use client";

import { useEffect, useState } from "react";
import { getEntityIcon, loadArticleEntities, type RecognizedEntity } from "./article-entities";
import "./article-entities.css";

export default function ArticleEntities({
  url,
  title,
  paragraphs,
  onEntitySelect,
}: {
  url: string;
  title: string;
  paragraphs: string[];
  onEntitySelect?: (entityText: string) => void;
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
    <div className="article-entities-container" aria-label="Key entities in this story">
      <div className="article-entities-header">
        <span className="article-entities-label">Key Topics & Entities</span>
        {loading && <span className="article-entities-spinner" aria-hidden="true" />}
      </div>
      <div className="article-entities-list" role="list">
        {entities.map((entity, index) => (
          <button
            key={`${entity.category}-${entity.text}-${index}`}
            type="button"
            className="article-entity-chip"
            title={`${entity.category}: ${entity.text} (Click to search news)`}
            onClick={() => onEntitySelect?.(entity.text)}
          >
            <span className="entity-icon" aria-hidden="true">
              {getEntityIcon(entity.category)}
            </span>
            <span className="entity-name">{entity.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
