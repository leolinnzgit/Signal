"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArticleStore, FollowedArticle } from "./NewsDashboard";
import { calculateEntityFrequency } from "./entity-frequency";
import EntityTimelineSparkline from "./EntityTimelineSparkline";
import { fetchMoreCoverage, findCoverageMatches, type CoverageArticle } from "./more-coverage";
import "./related-stories.css";

const EMPTY_ARTICLES: readonly CoverageArticle[] = [];
const publishedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export default function RelatedStoriesModal({
  isOpen,
  entity,
  story,
  currentUrl,
  liveArticles,
  archiveArticles = EMPTY_ARTICLES,
  articleStore,
  isFollowed,
  onFollow,
  onOpenArticle,
  onClose,
}: {
  isOpen: boolean;
  entity: string;
  story?: CoverageArticle;
  currentUrl: string;
  liveArticles: FollowedArticle[];
  archiveArticles?: readonly CoverageArticle[];
  articleStore?: ArticleStore;
  isFollowed: boolean;
  onFollow: (entity: string) => void;
  onOpenArticle: (article: CoverageArticle) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [entityArticles, setEntityArticles] = useState<CoverageArticle[]>([]);
  const [indexed, setIndexed] = useState<{ url: string; articles: CoverageArticle[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const stats = useMemo(() => calculateEntityFrequency(entity, liveArticles), [entity, liveArticles]);
  const matches = useMemo(() => {
    if (!story || !isOpen) return entityArticles;
    return findCoverageMatches(story,
      indexed?.url === story.url ? indexed.articles : EMPTY_ARTICLES,
      [...liveArticles, ...archiveArticles]);
  }, [archiveArticles, entityArticles, indexed, isOpen, liveArticles, story]);

  useEffect(() => {
    if (!isOpen || !story) return;
    const controller = new AbortController();
    setLoading(true);
    setIndexed(null);
    void fetchMoreCoverage(story, controller.signal)
      .then((articles) => {
        if (!controller.signal.aborted) setIndexed({ url: story.url, articles });
      })
      .catch(() => {
        // The feed and loaded history provide related coverage offline as well.
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isOpen, story]);

  useEffect(() => {
    const term = entity.trim().toLowerCase();
    if (!isOpen || story || !term) return;
    let closed = false;
    setLoading(true);

    const seenUrls = new Set([currentUrl]);
    const fromLive: CoverageArticle[] = [];
    for (const article of liveArticles) {
      if (seenUrls.has(article.url)) continue;
      if (article.title.toLowerCase().includes(term) || article.summary?.toLowerCase().includes(term)
          || article.topics?.some((topic) => topic.toLowerCase().includes(term))) {
        seenUrls.add(article.url);
        fromLive.push(article);
      }
    }

    setEntityArticles(fromLive);
    if (!articleStore) {
      setLoading(false);
      return;
    }
    void articleStore.load({ search: entity.trim(), limit: 15 })
      .then((page) => {
        if (closed) return;
        const fromHistory = page.articles.filter((article) => {
          if (seenUrls.has(article.url)) return false;
          seenUrls.add(article.url);
          return true;
        });
        setEntityArticles([...fromLive, ...fromHistory]);
      })
      .catch(() => { /* Feed matches are already available. */ })
      .finally(() => { if (!closed) setLoading(false); });
    return () => { closed = true; };
  }, [isOpen, entity, story, currentUrl, liveArticles, articleStore]);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      className="related-stories-dialog"
      aria-labelledby="related-stories-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="related-stories-card">
        <div className="related-stories-header">
          <div>
            <h2 id="related-stories-title">{story ? "More coverage" : "Related stories"}</h2>
            <p className="related-stories-entity" dir="auto">
              {story ? story.title : <>Stories mentioning <strong>{entity}</strong></>}
            </p>
          </div>
          <button
            type="button"
            className="related-stories-close"
            onClick={onClose}
            aria-label={story ? "Close more coverage" : "Close related stories"}
          >
            &#215;
          </button>
        </div>

        <div className="related-stories-body">
          {!story && entity.trim() && <EntityTimelineSparkline stats={stats} />}
          {loading && (!story || matches.length === 0) && (
            <div className="related-stories-loading" role="status">
              <span className="article-entities-spinner" aria-hidden="true" />
              <span>{story ? "Looking for more coverage…" : "Finding related stories…"}</span>
            </div>
          )}

          {!loading && matches.length === 0 && (
            <div className="related-stories-empty">
              {story ? <p>No matching coverage from other publishers was found.</p> : (
                <>
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
                </>
              )}
            </div>
          )}

          {(!loading || story) && matches.length > 0 && (
            <ul className="related-stories-list">
              {matches.map((article) => {
                const articleDate = Date.parse(article.publishedAt ?? "");
                return (
                  <li key={article.url} className="related-story-item">
                    <button
                      type="button"
                      className="related-story-btn"
                      onClick={() => {
                        onOpenArticle(article);
                        onClose();
                      }}
                    >
                      <span className="related-story-title" dir="auto">{article.title}</span>
                      <span className="related-story-source">
                        {article.source}
                        {story && Number.isFinite(articleDate) && (
                          <> · <time dateTime={article.publishedAt}>{publishedDate.format(articleDate)}</time></>
                        )}
                      </span>
                      {story && article.summary && (
                        <span className="related-story-excerpt" dir="auto">{article.summary}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="related-stories-footer">
          {!story && (isFollowed ? (
            <span className="related-stories-following-tag">✓ Following this topic</span>
          ) : (
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
          ))}
          <button type="button" className="related-stories-action-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
