"use client";

import { useCallback, useEffect, useState } from "react";
import ArticleAudioPlayer, { type ArticleAudioPlayerProps } from "./ArticleAudioPlayer";
import ArticleReadingText from "./ArticleReadingText";
import { copyArticleSummary, loadArticleSummary, type ArticleSummary } from "./article-summary";
import type { ArticleNarrationSection } from "./headline-audio";

export default function ArticleSummaryPlayer({ url, title, source, paragraphs, storyImageUrl, autoPrepare = false, onReadingSectionChange, onPlaybackStateChange }: ArticleAudioPlayerProps & { url: string }) {
  const [summary, setSummary] = useState<ArticleSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [scope, setScope] = useState(autoPrepare ? "article" : "summary");
  const [reading, setReading] = useState<ArticleNarrationSection | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setSummary(null);
    setCopied(false);
    void loadArticleSummary(url, abort.signal).then((result) => {
      if (!abort.signal.aborted) setSummary(result);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setSummary({ available: false, paragraphs: [],
        reason: reason instanceof Error ? reason.message : "The article summary could not be prepared." });
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => {
      abort.abort();
      onPlaybackStateChange?.(null);
    };
  }, [url, attempt]);

  const updateReading = useCallback((section: ArticleNarrationSection | null, playing: boolean) => {
    setReading(section);
    // Negative indices distinguish summary text from full-article paragraphs.
    onReadingSectionChange?.(scope === "summary" && section && section.paragraphIndex >= 0
      ? { ...section, paragraphIndex: -2 - section.paragraphIndex } : section, playing);
  }, [scope, onReadingSectionChange]);

  function selectScope(next: string) {
    if (next === scope) return;
    setReading(null);
    onReadingSectionChange?.(null, false);
    onPlaybackStateChange?.(null);
    setScope(next);
  }

  async function copySummary() {
    if (!summary?.available) return;
    setCopied(await copyArticleSummary(summary.paragraphs));
  }

  return <section className="article-ai-summary" aria-label="Article summary">
    <div className="article-ai-summary-header">
      <h3>Article summary</h3>
      {summary?.available && <button type="button" className="article-summary-copy-button" onClick={() => copySummary()}>{copied ? "Summary copied" : "Copy summary"}</button>}
    </div>
    {loading && <p role="status">Preparing a summary from the article text…</p>}
    {summary?.available && <>
      <p className="article-summary-caption">AI summary of the available article text.</p>
      {summary.paragraphs.map((text, index) => <p key={index} className="article-reader-summary">
        <ArticleReadingText text={text} paragraphIndex={index} section={scope === "summary" ? reading : null} />
      </p>)}
      <div className="article-audio-mode" role="group" aria-label="Listen to">
        <span className="article-audio-mode-label" aria-hidden="true">Listen</span>
        <button type="button" aria-pressed={scope === "summary"} onClick={() => selectScope("summary")}>Listen to summary</button>
        <button type="button" aria-pressed={scope === "article"} onClick={() => selectScope("article")}>Read full article</button>
      </div>
    </>}
    {summary && !summary.available && <>
      <p role="status">{summary.reason}</p>
      <button type="button" onClick={() => setAttempt((current) => current + 1)}>Retry summary</button>
      {scope !== "article" && <button type="button" onClick={() => selectScope("article")}>Read full article aloud</button>}
    </>}
    {(scope === "article" || summary?.available) && <ArticleAudioPlayer
      key={scope} title={title} source={source} storyUrl={scope === "article" ? url : undefined} storyImageUrl={storyImageUrl}
      paragraphs={scope === "summary" && summary?.available ? summary.paragraphs : paragraphs}
      autoPrepare defaultMode={scope === "summary" ? "recorded" : undefined} summaryOnly={scope === "summary"} onReadingSectionChange={updateReading} onPlaybackStateChange={onPlaybackStateChange} />}
  </section>;
}
