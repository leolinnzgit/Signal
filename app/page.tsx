"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
};

type FollowedArticle = Article & {
  topics: string[];
};

type FeedResponse = {
  topic: string;
  fetchedAt: string;
  articles: Article[];
  error?: string;
};

type Preferences = {
  topics: string[];
  limit: number;
  refreshMinutes: number;
};

const DEFAULTS: Preferences = {
  topics: ["Artificial intelligence"],
  limit: 6,
  refreshMinutes: 15,
};

const STORAGE_KEY = "signal-news-preferences";
const ALL_TOPICS = "all";

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
  return `${Math.round(hours / 24)}d ago`;
}

function readPreferences(): Preferences {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Preferences> & { topic?: string };
    const savedTopics = Array.isArray(saved.topics)
      ? saved.topics.filter((topic): topic is string => typeof topic === "string" && Boolean(topic.trim()))
      : typeof saved.topic === "string" && saved.topic.trim()
        ? [saved.topic.trim()]
        : DEFAULTS.topics;

    const topics = savedTopics.filter(
      (topic, index) => savedTopics.findIndex((candidate) => candidate.toLowerCase() === topic.toLowerCase()) === index,
    );

    return {
      topics,
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
  const [topicInput, setTopicInput] = useState("");
  const [selectedTopic, setSelectedTopic] = useState(ALL_TOPICS);
  const [articles, setArticles] = useState<FollowedArticle[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    setPreferences(readPreferences());
    setReady(true);
  }, []);

  const loadNews = useCallback(async (next: Preferences, quiet = false) => {
    const runId = ++requestSequence.current;
    if (!quiet) setLoading(true);
    setError("");
    setNotice("");

    if (next.topics.length === 0) {
      setArticles([]);
      setFetchedAt("");
      setLoading(false);
      return;
    }

    try {
      const results = await Promise.allSettled(
        next.topics.map(async (topic) => {
          const params = new URLSearchParams({ topic, limit: String(next.limit) });
          const response = await fetch(`/api/news?${params.toString()}`, { cache: "no-store" });
          const data = (await response.json()) as FeedResponse;
          if (!response.ok) throw new Error(data.error || `Could not refresh ${topic}.`);
          return data;
        }),
      );

      if (runId !== requestSequence.current) return;
      const successful = results
        .filter((result): result is PromiseFulfilledResult<FeedResponse> => result.status === "fulfilled")
        .map((result) => result.value);

      if (successful.length === 0) throw new Error("The news feeds could not be reached.");

      const merged = new Map<string, FollowedArticle>();
      successful.forEach((feed) => {
        feed.articles.forEach((article) => {
          const key = article.url || article.title;
          const existing = merged.get(key);
          if (existing) {
            existing.topics = Array.from(new Set([...existing.topics, feed.topic]));
          } else {
            merged.set(key, { ...article, topics: [feed.topic] });
          }
        });
      });

      setArticles(
        Array.from(merged.values()).sort(
          (left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime(),
        ),
      );
      setFetchedAt(
        successful.map((feed) => feed.fetchedAt).sort((left, right) => right.localeCompare(left))[0] ?? "",
      );

      const failedCount = results.length - successful.length;
      if (failedCount > 0) {
        setNotice(`${failedCount} ${failedCount === 1 ? "topic" : "topics"} could not be refreshed this time.`);
      }
    } catch (caught) {
      if (runId === requestSequence.current) {
        setError(caught instanceof Error ? caught.message : "The news feeds could not be reached.");
      }
    } finally {
      if (runId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences, ready]);

  useEffect(() => {
    if (!ready) return;
    void loadNews(preferences);
  }, [preferences.topics, preferences.limit, ready, loadNews]);

  useEffect(() => {
    if (!ready || preferences.refreshMinutes === 0 || preferences.topics.length === 0) return;
    const interval = window.setInterval(
      () => void loadNews(preferences, true),
      preferences.refreshMinutes * 60_000,
    );
    return () => window.clearInterval(interval);
  }, [preferences, ready, loadNews]);

  const filteredArticles = useMemo(
    () => selectedTopic === ALL_TOPICS
      ? articles
      : articles.filter((article) => article.topics.includes(selectedTopic)),
    [articles, selectedTopic],
  );

  const topicCounts = useMemo(
    () => Object.fromEntries(
      preferences.topics.map((topic) => [topic, articles.filter((article) => article.topics.includes(topic)).length]),
    ),
    [articles, preferences.topics],
  );

  const sources = useMemo(
    () => new Set(filteredArticles.map((article) => article.source)).size,
    [filteredArticles],
  );

  function submitTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const topic = topicInput.trim().replace(/\s+/g, " ");
    if (!topic) return;

    const existing = preferences.topics.find((followed) => followed.toLowerCase() === topic.toLowerCase());
    if (existing) {
      setSelectedTopic(existing);
      setNotice(`You already follow ${existing}.`);
      setTopicInput("");
      return;
    }

    setPreferences((current) => ({ ...current, topics: [...current.topics, topic] }));
    setSelectedTopic(topic);
    setTopicInput("");
  }

  function removeTopic(topic: string) {
    setPreferences((current) => ({
      ...current,
      topics: current.topics.filter((followed) => followed !== topic),
    }));
    if (selectedTopic === topic) setSelectedTopic(ALL_TOPICS);
  }

  const feedTitle = selectedTopic === ALL_TOPICS ? "All followed topics" : selectedTopic;

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
          <p className="eyebrow">Your interests, continuously monitored</p>
          <h1>Stay current on<br /><em>what matters.</em></h1>
          <p className="lede">
            One focused briefing for every subject you care about. Add topics as your interests expand.
          </p>
        </div>

        <div className="control-panel">
          <form onSubmit={submitTopic}>
            <div className="field topic-field">
              <label htmlFor="topic">Add a topic to follow</label>
              <div className="topic-input-wrap">
                <input
                  id="topic"
                  maxLength={80}
                  value={topicInput}
                  onChange={(event) => setTopicInput(event.target.value)}
                  placeholder="e.g. renewable energy"
                  autoComplete="off"
                />
                <button type="submit" aria-label="Add topic">
                  Add <span aria-hidden="true">&#43;</span>
                </button>
              </div>
            </div>
          </form>

          <div className="followed-topics">
            <p className="panel-label">Following {preferences.topics.length}</p>
            {preferences.topics.length > 0 ? (
              <ul>
                {preferences.topics.map((topic) => (
                  <li key={topic}>
                    <span>{topic}</span>
                    <button type="button" onClick={() => removeTopic(topic)} aria-label={`Stop following ${topic}`}>
                      &#215;
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="no-topics">Add your first topic to start the briefing.</p>
            )}
          </div>

          <div className="settings-row">
            <div className="field compact-field">
              <label htmlFor="story-limit">Stories per topic</label>
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
                onChange={(event) => setPreferences((current) => ({
                  ...current,
                  refreshMinutes: Number(event.target.value),
                }))}
              >
                <option value={0}>Manual</option>
                <option value={5}>Every 5 min</option>
                <option value={15}>Every 15 min</option>
                <option value={30}>Every 30 min</option>
                <option value={60}>Every hour</option>
              </select>
            </div>
          </div>
          <p className="settings-note">Your followed topics and settings are saved on this device.</p>
        </div>
      </section>

      <section className="feed" aria-labelledby="feed-title">
        <div className="feed-heading">
          <div>
            <p className="eyebrow">Latest signal</p>
            <h2 id="feed-title">{feedTitle}</h2>
          </div>
          <div className="feed-actions">
            <div className="feed-meta" aria-live="polite">
              {fetchedAt
                ? `${filteredArticles.length} stories · ${sources} sources · updated ${formatAge(fetchedAt)}`
                : preferences.topics.length > 0 ? "Gathering recent coverage" : "No topics followed yet"}
            </div>
            <button className="refresh-button" onClick={() => void loadNews(preferences)} disabled={loading || preferences.topics.length === 0}>
              <RefreshIcon spinning={loading} /> Refresh
            </button>
          </div>
        </div>

        {preferences.topics.length > 0 && (
          <nav className="topic-filters" aria-label="Filter stories by followed topic">
            <button
              type="button"
              className={selectedTopic === ALL_TOPICS ? "active" : ""}
              aria-pressed={selectedTopic === ALL_TOPICS}
              onClick={() => setSelectedTopic(ALL_TOPICS)}
            >
              All <span>{articles.length}</span>
            </button>
            {preferences.topics.map((topic) => (
              <button
                type="button"
                key={topic}
                className={selectedTopic === topic ? "active" : ""}
                aria-pressed={selectedTopic === topic}
                onClick={() => setSelectedTopic(topic)}
              >
                {topic} <span>{topicCounts[topic] ?? 0}</span>
              </button>
            ))}
          </nav>
        )}

        {notice && <p className="feed-notice" role="status">{notice}</p>}

        {preferences.topics.length === 0 ? (
          <div className="message-card">
            <p className="message-kicker">Your briefing is empty</p>
            <h3>Add a topic to begin.</h3>
            <p>Your followed topics will appear here as filters, with everything combined under All.</p>
          </div>
        ) : error ? (
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
        ) : filteredArticles.length === 0 ? (
          <div className="message-card">
            <p className="message-kicker">No coverage found</p>
            <h3>Try a broader topic.</h3>
            <p>A shorter or more general phrase usually brings in a stronger signal.</p>
          </div>
        ) : (
          <ol className="story-list">
            {filteredArticles.map((article, index) => (
              <li key={article.url || `${article.title}-${index}`}>
                <a href={article.url} target="_blank" rel="noreferrer" className="story-link">
                  <span className="story-number">{String(index + 1).padStart(2, "0")}</span>
                  <article>
                    <div className="story-meta">
                      <span className="story-topic">{article.topics.join(" + ")}</span>
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
