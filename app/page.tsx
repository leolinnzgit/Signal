"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
};

type FeedResponse = {
  topic: string;
  fetchedAt: string;
  articles: Article[];
  error?: string;
};

type Preferences = {
  topic: string;
  limit: number;
  refreshMinutes: number;
};

const DEFAULTS: Preferences = {
  topic: "Artificial intelligence",
  limit: 6,
  refreshMinutes: 15,
};

const STORAGE_KEY = "signal-news-preferences";

function ArrowIcon() {
  return <span aria-hidden="true" className="arrow">&#8599;</span>;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return (
    <span aria-hidden="true" className={spinning ? "refresh-icon spinning" : "refresh-icon"}>
      &#8635;
    </span>
  );
}

function formatAge(value: string) {
  const then = new Date(value).getTime();
  const diffMinutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Preferences>;
    return {
      topic: typeof saved.topic === "string" && saved.topic.trim() ? saved.topic : DEFAULTS.topic,
      limit: Math.min(10, Math.max(1, Number(saved.limit) || DEFAULTS.limit)),
      refreshMinutes: [0, 5, 15, 30, 60].includes(Number(saved.refreshMinutes))
        ? Number(saved.refreshMinutes)
        : DEFAULTS.refreshMinutes,
    };
  } catch {
    return DEFAULTS;
  }
}

export default function Home() {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULTS);
  const [topicInput, setTopicInput] = useState(DEFAULTS.topic);
  const [articles, setArticles] = useState<Article[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = readPreferences();
    setPreferences(saved);
    setTopicInput(saved.topic);
    setReady(true);
  }, []);

  const loadNews = useCallback(async (next: Preferences, quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ topic: next.topic, limit: String(next.limit) });
      const response = await fetch(`/api/news?${params.toString()}`, { cache: "no-store" });
      const data = (await response.json()) as FeedResponse;
      if (!response.ok) throw new Error(data.error || "The news feed could not be reached.");
      setArticles(data.articles);
      setFetchedAt(data.fetchedAt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The news feed could not be reached.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    void loadNews(preferences);
  }, [preferences.topic, preferences.limit, ready, loadNews]);

  useEffect(() => {
    if (!ready || preferences.refreshMinutes === 0) return;
    const interval = window.setInterval(
      () => void loadNews(preferences, true),
      preferences.refreshMinutes * 60_000,
    );
    return () => window.clearInterval(interval);
  }, [preferences, ready, loadNews]);

  const sources = useMemo(() => new Set(articles.map((article) => article.source)).size, [articles]);

  function submitTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const topic = topicInput.trim();
    if (!topic) return;
    if (topic === preferences.topic) {
      void loadNews(preferences);
      return;
    }
    setPreferences((current) => ({ ...current, topic }));
  }

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Signal home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>SIGNAL</span>
        </a>
        <div className="live-status">
          <span className="pulse" aria-hidden="true" />
          Live web briefing
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your interest, continuously monitored</p>
          <h1>Stay current on<br /><em>what matters.</em></h1>
          <p className="lede">
            A focused stream of recent reporting, gathered around the subject you choose.
          </p>
        </div>

        <form className="control-panel" onSubmit={submitTopic}>
          <div className="field topic-field">
            <label htmlFor="topic">I want to follow</label>
            <div className="topic-input-wrap">
              <input
                id="topic"
                maxLength={80}
                value={topicInput}
                onChange={(event) => setTopicInput(event.target.value)}
                placeholder="e.g. renewable energy"
                autoComplete="off"
              />
              <button type="submit" aria-label="Update topic">
                Follow <span aria-hidden="true">&#8594;</span>
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="field compact-field">
              <label htmlFor="story-limit">Stories</label>
              <select
                id="story-limit"
                value={preferences.limit}
                onChange={(event) => setPreferences((current) => ({ ...current, limit: Number(event.target.value) }))}
              >
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </div>
            <div className="field compact-field">
              <label htmlFor="refresh-rate">Refresh</label>
              <select
                id="refresh-rate"
                value={preferences.refreshMinutes}
                onChange={(event) => {
                  const refreshMinutes = Number(event.target.value);
                  setPreferences((current) => ({ ...current, refreshMinutes }));
                  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...preferences, refreshMinutes }));
                }}
              >
                <option value={0}>Manual</option>
                <option value={5}>Every 5 min</option>
                <option value={15}>Every 15 min</option>
                <option value={30}>Every 30 min</option>
                <option value={60}>Every hour</option>
              </select>
            </div>
          </div>
          <p className="settings-note">Your settings are saved on this device.</p>
        </form>
      </section>

      <section className="feed" aria-labelledby="feed-title">
        <div className="feed-heading">
          <div>
            <p className="eyebrow">Latest signal</p>
            <h2 id="feed-title">{preferences.topic}</h2>
          </div>
          <div className="feed-actions">
            <div className="feed-meta" aria-live="polite">
              {fetchedAt ? `${articles.length} stories · ${sources} sources · updated ${formatAge(fetchedAt)}` : "Gathering recent coverage"}
            </div>
            <button className="refresh-button" onClick={() => void loadNews(preferences)} disabled={loading}>
              <RefreshIcon spinning={loading} /> Refresh
            </button>
          </div>
        </div>

        {error ? (
          <div className="message-card" role="alert">
            <p className="message-kicker">The signal dropped</p>
            <h3>We couldn&apos;t gather the latest stories.</h3>
            <p>{error}</p>
            <button onClick={() => void loadNews(preferences)}>Try again</button>
          </div>
        ) : loading && articles.length === 0 ? (
          <div className="loading-list" aria-label="Loading recent stories">
            {Array.from({ length: 4 }, (_, index) => <div className="loading-row" key={index} />)}
          </div>
        ) : articles.length === 0 ? (
          <div className="message-card">
            <p className="message-kicker">No coverage found</p>
            <h3>Try a broader topic.</h3>
            <p>A shorter or more general phrase usually brings in a stronger signal.</p>
          </div>
        ) : (
          <ol className="story-list">
            {articles.map((article, index) => (
              <li key={`${article.url}-${index}`}>
                <a href={article.url} target="_blank" rel="noreferrer" className="story-link">
                  <span className="story-number">{String(index + 1).padStart(2, "0")}</span>
                  <article>
                    <div className="story-meta">
                      <span>{article.source}</span>
                      <span>{formatAge(article.publishedAt)}</span>
                    </div>
                    <h3>{article.title}</h3>
                    {article.summary && <p>{article.summary}</p>}
                  </article>
                  <ArrowIcon />
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer>
        <p><span className="footer-dot" /> SIGNAL gathers recent public reporting and sends you to the original publisher.</p>
        <a href="#top">Back to top &#8593;</a>
      </footer>
    </main>
  );
}
