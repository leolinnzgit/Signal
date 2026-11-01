"use client";

import { useEffect, useRef, useState } from "react";
import type { FollowedArticle } from "./NewsDashboard";
import { getSentimentIcon, resolveArticleSentiment } from "./article-sentiment";
import { loadClusterSynthesis, type ClusterSynthesisResult, type StoryCluster } from "./story-clustering";
import { useSpokenBriefing } from "./useSpokenBriefing";
import "./compare-coverage.css";

export default function CompareCoverageModal({
  cluster,
  isOpen,
  onClose,
  onOpenArticle,
  onListenArticle,
}: {
  cluster: StoryCluster | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenArticle: (article: FollowedArticle) => void;
  onListenArticle?: (article: FollowedArticle) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [synthesis, setSynthesis] = useState<ClusterSynthesisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const briefingAudio = useSpokenBriefing();
  const stopBriefing = briefingAudio.stop;

  useEffect(() => {
    if (!isOpen || !cluster) {
      stopBriefing();
      setSynthesis(null);
      setLoading(false);
      return;
    }

    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }

    let cancelled = false;
    const abort = new AbortController();
    setLoading(true);

    loadClusterSynthesis(cluster.articles, abort.signal)
      .then((res) => {
        if (!cancelled) {
          setSynthesis(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      abort.abort();
      stopBriefing();
      if (dialog && dialog.open) dialog.close();
    };
  }, [isOpen, cluster, stopBriefing]);

  if (!isOpen || !cluster) return null;

  function handleClose() {
    stopBriefing();
    onClose();
  }

  function toggleAudio() {
    if (briefingAudio.isActive) {
      briefingAudio.stop();
    } else if (synthesis && synthesis.paragraphs.length > 0) {
      const textToRead = `${cluster!.articles.length} news sources report on this story. ${synthesis.paragraphs.join(" ")}`;
      briefingAudio.speak(textToRead);
    }
  }

  const distinctSourcesCount = cluster.sources.length;

  return (
    <dialog
      ref={dialogRef}
      className="compare-coverage-dialog"
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) handleClose();
      }}
    >
      <div className="compare-coverage-card">
        {/* Header */}
        <div className="compare-coverage-header">
          <div className="compare-coverage-header-info">
            <span className="compare-coverage-kicker">Multi-source coverage</span>
            <h2>Compare Coverage</h2>
            <p>
              {cluster.articles.length} reports across {distinctSourcesCount} news {distinctSourcesCount === 1 ? "source" : "sources"}
            </p>
          </div>
          <button
            type="button"
            className="compare-coverage-close-btn"
            onClick={handleClose}
            aria-label="Close coverage comparison"
          >
            &#215;
          </button>
        </div>

        <div className="compare-coverage-scroll-body">
          {/* AI Coverage Synthesis */}
          <div className="compare-synthesis-box">
            <div className="compare-synthesis-header">
              <div className="compare-synthesis-title-wrap">
                <span className="synthesis-sparkle-icon" aria-hidden="true">✨</span>
                <strong>Cross-Publisher Synthesis</strong>
                {synthesis && (
                  <span className={`synthesis-source-badge badge-${synthesis.source}`}>
                    {synthesis.source === "azure" ? "Azure AI Language" : "Multi-Source Extractive"}
                  </span>
                )}
              </div>
              {synthesis && synthesis.paragraphs.length > 0 && (
                <button
                  type="button"
                  className={`synthesis-listen-btn${briefingAudio.isActive ? " active" : ""}`}
                  onClick={toggleAudio}
                  aria-pressed={briefingAudio.isActive}
                  title="Listen to synthesized coverage"
                >
                  {briefingAudio.status === "starting"
                    ? "⏳ Preparing…"
                    : briefingAudio.status === "playing"
                      ? "⏹ Stop Audio"
                      : "🔊 Listen"}
                </button>
              )}
            </div>

            {loading ? (
              <div className="compare-synthesis-loading">
                <span className="compare-spinner" aria-hidden="true" />
                <span>Synthesizing perspectives from {cluster.sources.join(", ")}…</span>
              </div>
            ) : synthesis && synthesis.paragraphs.length > 0 ? (
              <div className="compare-synthesis-text">
                {synthesis.paragraphs.map((p, idx) => (
                  <p key={idx}>{p}</p>
                ))}
              </div>
            ) : (
              <p className="compare-synthesis-empty">
                Comparing headlines and perspectives across {distinctSourcesCount} publishers below.
              </p>
            )}
          </div>

          {/* Publisher Breakdown */}
          <div className="compare-publishers-section">
            <div className="compare-publishers-heading">
              <h3>Publisher Reports ({cluster.articles.length})</h3>
              <span className="compare-publishers-sources">
                {cluster.sources.join(" · ")}
              </span>
            </div>

            <div className="compare-publishers-list">
              {cluster.articles.map((article, idx) => {
                const sentiment = resolveArticleSentiment(article);
                return (
                  <article key={article.url || idx} className="compare-publisher-card">
                    <div className="compare-publisher-meta">
                      <div className="publisher-identity">
                        <strong className="publisher-source-name">{article.source}</strong>
                        {article.publishedAt && (
                          <span className="publisher-time">
                            {new Date(article.publishedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        )}
                      </div>
                      <span
                        className={`publisher-sentiment-badge tone-${sentiment.sentiment}`}
                        title={`${sentiment.sentiment.toUpperCase()} tone: ${sentiment.positiveScore * 100}% pos, ${sentiment.negativeScore * 100}% neg`}
                      >
                        <span aria-hidden="true">{getSentimentIcon(sentiment.sentiment)} </span>
                        {sentiment.sentiment.charAt(0).toUpperCase() + sentiment.sentiment.slice(1)}
                      </span>
                    </div>

                    <h4 className="publisher-story-title">
                      <button
                        type="button"
                        className="publisher-title-link"
                        onClick={() => {
                          onOpenArticle(article);
                          handleClose();
                        }}
                      >
                        {article.title}
                      </button>
                    </h4>

                    {article.summary && (
                      <p className="publisher-story-summary">{article.summary}</p>
                    )}

                    <div className="publisher-story-actions">
                      <button
                        type="button"
                        className="publisher-action-btn primary"
                        onClick={() => {
                          onOpenArticle(article);
                          handleClose();
                        }}
                      >
                        Read in Signal ↗
                      </button>
                      {onListenArticle && (
                        <button
                          type="button"
                          className="publisher-action-btn"
                          onClick={() => {
                            onListenArticle(article);
                            handleClose();
                          }}
                        >
                          Listen 🔊
                        </button>
                      )}
                      {article.url && (
                        <a
                          href={article.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="publisher-action-btn secondary"
                        >
                          Original 🌐
                        </a>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
