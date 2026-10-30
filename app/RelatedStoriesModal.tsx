"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArticleStore, FollowedArticle } from "./NewsDashboard";
import type { SignalArticleLink } from "./article-link";
import { calculateEntityFrequency } from "./entity-frequency";
import EntityTimelineSparkline from "./EntityTimelineSparkline";
import "./related-stories.css";

export default function RelatedStoriesModal({
  isOpen,
  entity,
  currentUrl,
  liveArticles,
  articleStore,
  isFollowed,
  onFollow,
  onOpenArticle,
  onClose,
}: {
  isOpen: boolean;
  entity: string;
  currentUrl: string;
  liveArticles: FollowedArticle[];
  articleStore?: ArticleStore;
  isFollowed: boolean;
  onFollow: (entity: string) => void;
  onOpenArticle: (article: SignalArticleLink) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [matchingArticles, setMatchingArticles] = useState<SignalArticleLink[]>([]);
  const [loading, setLoading] = useState(false);
  const stats = useMemo(() => calculateEntityFrequency(entity, liveArticles), [entity, liveArticles]);

  useEffect(() => {
    if (!isOpen || !entity.trim()) return;

    const term = entity.trim().toLowerCase();
    setLoading(true);

    // 1. Check liveArticles first
    const seenUrls = new Set<string>();
    if (currentUrl) seenUrls.add(currentUrl);

    const fromLive: SignalArticleLink[] = [];
    for (const a of liveArticles) {
      if (seenUrls.has(a.url)) continue;
      const titleMatch = a.title.toLowerCase().includes(term);
      const summaryMatch = a.summary ? a.summary.toLowerCase().includes(term) : false;
      const topicMatch = a.topics ? a.topics.some((t) => t.toLowerCase().includes(term)) : false;
      if (titleMatch || summaryMatch || topicMatch) {
        seenUrls.add(a.url);
        fromLive.push({ url: a.url, title: a.title, source: a.source });
      }
    }

    // 2. Query articleStore if available
    if (articleStore) {
      articleStore
        .load({ search: entity.trim(), limit: 15 })
        .then((page) => {
          const fromHistory: SignalArticleLink[] = [];
          for (const a of page.articles) {
            if (seenUrls.has(a.url)) continue;
            seenUrls.add(a.url);
            fromHistory.push({ url: a.url, title: a.title, source: a.source });
          }
          setMatchingArticles([...fromLive, ...fromHistory]);
        })
        .catch(() => {
          setMatchingArticles(fromLive);
        })
        .finally(() => {
          setLoading(false);
        });
    } else {
      setMatchingArticles(fromLive);
      setLoading(false);
    }
  }, [isOpen, entity, currentUrl, liveArticles, articleStore]);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog && dialog.open) dialog.close();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="related-stories-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="related-stories-card">
        <div className="related-stories-header">
          <div>
            <h2>Related stories</h2>
            <p className="related-stories-entity">
              Stories mentioning <strong>{entity}</strong>
            </p>
          </div>
          <button
            type="button"
            className="related-stories-close"
            onClick={onClose}
            aria-label="Close related stories"
          >
            &#215;
          </button>
        </div>

        <div className="related-stories-body">
          {entity.trim() && <EntityTimelineSparkline stats={stats} />}
          {loading && (
            <div className="related-stories-loading">
              <span className="article-entities-spinner" aria-hidden="true" />
              <span>Finding related stories…</span>
            </div>
          )}

          {!loading && matchingArticles.length === 0 && (
            <div className="related-stories-empty">
              <p>No other stories found in your recent feed or saved stories mentioning &ldquo;{entity}&rdquo;.</p>
              {!isFollowed && (
                <button
                  type="button"
                  className="related-stories-follow-btn"
                  onClick={() => {
                    onFollow(entity);
                    onClose();
                  }}
                >
                  Follow {entity} to capture future stories
                </button>
              )}
            </div>
          )}

          {!loading && matchingArticles.length > 0 && (
            <ul className="related-stories-list">
              {matchingArticles.map((article) => (
                <li key={article.url} className="related-story-item">
                  <button
                    type="button"
                    className="related-story-btn"
                    onClick={() => {
                      onOpenArticle(article);
                      onClose();
                    }}
                  >
                    <span className="related-story-title">{article.title}</span>
                    <span className="related-story-source">{article.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="related-stories-footer">
          {!isFollowed ? (
            <button
              type="button"
              className="related-stories-action-btn primary"
              onClick={() => {
                onFollow(entity);
                onClose();
              }}
            >
              + Follow &ldquo;{entity}&rdquo; as a topic
            </button>
          ) : (
            <span className="related-stories-following-tag">✓ Following this topic</span>
          )}
          <button type="button" className="related-stories-action-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
