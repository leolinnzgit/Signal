"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  matchedTopics?: string[];
};

type FollowedArticle = Article & {
  topics: string[];
  providers: string[];
};

type FeedResponse = {
  topic: string;
  provider: string;
  fetchedAt: string;
  articles: Article[];
  error?: string;
};

type SourcePreferences = {
  google: boolean;
  gdelt: boolean;
  rssFeeds: string[];
};

type Preferences = {
  topics: string[];
  limit: number;
  refreshMinutes: number;
  sources: SourcePreferences;
};

const DEFAULTS: Preferences = {
  topics: ["Artificial intelligence"],
  limit: 6,
  refreshMinutes: 15,
  sources: { google: true, gdelt: true, rssFeeds: [] },
};

const STORAGE_KEY = "signal-news-preferences";
const ALL_TOPICS = "all";
const ALL_PROVIDERS = "all";

function ArrowIcon() {
  return <span aria-hidden="true" className="arrow">&#8599;</span>;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <span aria-hidden="true" className={spinning ? "refresh-icon spinning" : "refresh-icon"}>&#8635;</span>;
}

function formatAge(value: string) {
  const then = new Date(value).getTime();
  const diffMinutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function feedName(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function articleKey(article: Article) {
  return article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || article.url;
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
    const rssFeeds = Array.isArray(saved.sources?.rssFeeds)
      ? saved.sources.rssFeeds.filter((feed): feed is string => typeof feed === "string" && feed.startsWith("https://"))
      : [];

    return {
      topics,
      limit: Math.min(10, Math.max(1, Number(saved.limit) || DEFAULTS.limit)),
      refreshMinutes: [0, 5, 15, 30, 60].includes(Number(saved.refreshMinutes))
        ? Number(saved.refreshMinutes)
        : DEFAULTS.refreshMinutes,
      sources: {
        google: typeof saved.sources?.google === "boolean" ? saved.sources.google : true,
        gdelt: typeof saved.sources?.gdelt === "boolean" ? saved.sources.gdelt : true,
        rssFeeds: Array.from(new Set(rssFeeds)),
      },
    };
  } catch {
    return DEFAULTS;
  }
}

type NewsDashboardProps = {
  user: {
    displayName: string;
    email: string;
    fullName: string | null;
    isLocalPreview: boolean;
  };
  signOutPath: string | null;
};

export default function NewsDashboard({ user, signOutPath }: NewsDashboardProps) {
  const [preferences, setPreferences] = useState<Preferences>(DEFAULTS);
  const [topicInput, setTopicInput] = useState("");
  const [rssInput, setRssInput] = useState("");
  const [selectedTopic, setSelectedTopic] = useState(ALL_TOPICS);
  const [selectedProvider, setSelectedProvider] = useState(ALL_PROVIDERS);
  const [articles, setArticles] = useState<FollowedArticle[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const requestSequence = useRef(0);

  const enabledSourceCount = Number(preferences.sources.google)
    + Number(preferences.sources.gdelt)
    + preferences.sources.rssFeeds.length;

  useEffect(() => {
    setPreferences(readPreferences());
    setReady(true);
  }, []);

  const loadNews = useCallback(async (next: Preferences, quiet = false) => {
    const runId = ++requestSequence.current;
    if (!quiet) setLoading(true);
    setError("");
    setNotice("");

    const requests: Array<{ topics: string[]; provider: string; feed?: string }> = next.topics.flatMap((topic) => [
      ...(next.sources.google ? [{ topic, provider: "google" }] : []),
      ...next.sources.rssFeeds.map((feed) => ({ topic, provider: "rss", feed })),
    ]).map((request) => ({ ...request, topics: [request.topic] }));
    if (next.sources.gdelt) requests.push({ topics: next.topics, provider: "gdelt" });

    if (next.topics.length === 0 || requests.length === 0) {
      setArticles([]);
      setFetchedAt("");
      setLoading(false);
      return;
    }

    try {
      const results = await Promise.allSettled(
        requests.map(async ({ topics, provider, feed }) => {
          const params = new URLSearchParams({ provider, limit: String(next.limit) });
          topics.forEach((topic) => params.append("topic", topic));
          if (feed) params.set("feed", feed);
          const response = await fetch(`/api/news?${params.toString()}`, { cache: "no-store" });
          const data = (await response.json()) as FeedResponse;
          if (!response.ok) throw new Error(data.error || `Could not refresh ${topics.join(", ")}.`);
          return data;
        }),
      );

      if (runId !== requestSequence.current) return;
      const successful = results
        .filter((result): result is PromiseFulfilledResult<FeedResponse> => result.status === "fulfilled")
        .map((result) => result.value);
      if (successful.length === 0) throw new Error("The selected news sources could not be reached.");

      const merged = new Map<string, FollowedArticle>();
      successful.forEach((feed) => {
        feed.articles.forEach((article) => {
          const key = articleKey(article);
          const matchedTopics = article.matchedTopics?.length ? article.matchedTopics : [feed.topic];
          const existing = merged.get(key);
          if (existing) {
            existing.topics = Array.from(new Set([...existing.topics, ...matchedTopics]));
            existing.providers = Array.from(new Set([...existing.providers, feed.provider]));
          } else {
            merged.set(key, { ...article, topics: matchedTopics, providers: [feed.provider] });
          }
        });
      });

      const sorted = Array.from(merged.values()).sort(
        (left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime(),
      );
      const included = new Set<string>();
      next.topics.forEach((topic) => {
        sorted
          .filter((article) => article.topics.includes(topic))
          .slice(0, next.limit)
          .forEach((article) => included.add(articleKey(article)));
      });
      setArticles(sorted.filter((article) => included.has(articleKey(article))));
      setFetchedAt(successful.map((feed) => feed.fetchedAt).sort((left, right) => right.localeCompare(left))[0] ?? "");

      const failedCount = results.length - successful.length;
      if (failedCount > 0) {
        setNotice(`${failedCount} ${failedCount === 1 ? "feed request" : "feed requests"} could not be refreshed this time.`);
      }
    } catch (caught) {
      if (runId === requestSequence.current) {
        setError(caught instanceof Error ? caught.message : "The news sources could not be reached.");
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
  }, [preferences.topics, preferences.limit, preferences.sources, ready, loadNews]);

  useEffect(() => {
    if (!ready || preferences.refreshMinutes === 0 || preferences.topics.length === 0 || enabledSourceCount === 0) return;
    const interval = window.setInterval(
      () => void loadNews(preferences, true),
      preferences.refreshMinutes * 60_000,
    );
    return () => window.clearInterval(interval);
  }, [preferences, ready, enabledSourceCount, loadNews]);

  const topicFilteredArticles = useMemo(
    () => selectedTopic === ALL_TOPICS
      ? articles
      : articles.filter((article) => article.topics.includes(selectedTopic)),
    [articles, selectedTopic],
  );

  const filteredArticles = useMemo(
    () => selectedProvider === ALL_PROVIDERS
      ? topicFilteredArticles
      : topicFilteredArticles.filter((article) => article.providers.includes(selectedProvider)),
    [topicFilteredArticles, selectedProvider],
  );

  const topicCounts = useMemo(
    () => Object.fromEntries(
      preferences.topics.map((topic) => [topic, articles.filter((article) => article.topics.includes(topic)).length]),
    ),
    [articles, preferences.topics],
  );

  const availableProviders = useMemo(
    () => Array.from(new Set(topicFilteredArticles.flatMap((article) => article.providers))).sort(),
    [topicFilteredArticles],
  );

  const providerCounts = useMemo(
    () => Object.fromEntries(
      availableProviders.map((provider) => [
        provider,
        topicFilteredArticles.filter((article) => article.providers.includes(provider)).length,
      ]),
    ),
    [availableProviders, topicFilteredArticles],
  );

  const publisherCount = useMemo(
    () => new Set(filteredArticles.map((article) => article.source)).size,
    [filteredArticles],
  );

  useEffect(() => {
    if (selectedProvider !== ALL_PROVIDERS && !availableProviders.includes(selectedProvider)) {
      setSelectedProvider(ALL_PROVIDERS);
    }
  }, [availableProviders, selectedProvider]);

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
    setPreferences((current) => ({ ...current, topics: current.topics.filter((followed) => followed !== topic) }));
    if (selectedTopic === topic) setSelectedTopic(ALL_TOPICS);
  }

  function submitRssFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const url = new URL(rssInput.trim());
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      const value = url.toString();
      if (preferences.sources.rssFeeds.includes(value)) {
        setNotice(`You already use ${feedName(value)}.`);
      } else {
        setPreferences((current) => ({
          ...current,
          sources: { ...current.sources, rssFeeds: [...current.sources.rssFeeds, value] },
        }));
      }
      setRssInput("");
    } catch {
      setNotice("Enter a complete public HTTPS RSS or Atom feed URL.");
    }
  }

  function removeRssFeed(feed: string) {
    setPreferences((current) => ({
      ...current,
      sources: { ...current.sources, rssFeeds: current.sources.rssFeeds.filter((item) => item !== feed) },
    }));
  }

  const feedTitle = selectedTopic === ALL_TOPICS ? "All followed topics" : selectedTopic;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Signal home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>SIGNAL</span>
        </a>
        <div className="header-actions">
          <div className="live-status"><span className="pulse" aria-hidden="true" />Live web briefing</div>
          <div className="current-user">
            <span className="user-avatar" aria-hidden="true">{user.displayName.charAt(0).toUpperCase()}</span>
            <span className="user-identity">
              <strong>{user.displayName}</strong>
              {user.fullName && <small>{user.email}</small>}
            </span>
            {signOutPath ? <a href={signOutPath}>Sign out</a> : <span className="preview-session">Preview</span>}
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your interests, continuously monitored</p>
          <h1>Stay current on<br /><em>what matters.</em></h1>
          <p className="lede">One focused briefing across multiple news networks and the publishers you trust.</p>
        </div>

        <div className="control-panel">
          <form onSubmit={submitTopic}>
            <div className="field topic-field">
              <label htmlFor="topic">Add a topic to follow</label>
              <div className="topic-input-wrap">
                <input id="topic" maxLength={80} value={topicInput} onChange={(event) => setTopicInput(event.target.value)} placeholder="e.g. renewable energy" autoComplete="off" />
                <button type="submit" aria-label="Add topic">Add <span aria-hidden="true">&#43;</span></button>
              </div>
            </div>
          </form>

          <div className="followed-topics">
            <p className="panel-label">Following {preferences.topics.length}</p>
            {preferences.topics.length > 0 ? (
              <ul>
                {preferences.topics.map((topic) => (
                  <li key={topic}><span>{topic}</span><button type="button" onClick={() => removeTopic(topic)} aria-label={`Stop following ${topic}`}>&#215;</button></li>
                ))}
              </ul>
            ) : <p className="no-topics">Add your first topic to start the briefing.</p>}
          </div>

          <div className="source-settings">
            <p className="panel-label">News sources {enabledSourceCount}</p>
            <div className="source-toggles">
              <label className="source-toggle">
                <input type="checkbox" checked={preferences.sources.google} onChange={(event) => setPreferences((current) => ({ ...current, sources: { ...current.sources, google: event.target.checked } }))} />
                <span><strong>Google News</strong><small>Broad publisher coverage</small></span>
              </label>
              <label className="source-toggle">
                <input type="checkbox" checked={preferences.sources.gdelt} onChange={(event) => setPreferences((current) => ({ ...current, sources: { ...current.sources, gdelt: event.target.checked } }))} />
                <span><strong>GDELT</strong><small>Global news monitoring</small></span>
              </label>
            </div>

            <form className="rss-form" onSubmit={submitRssFeed}>
              <label htmlFor="rss-feed">Add a publisher RSS or Atom feed</label>
              <div className="rss-input-wrap">
                <input id="rss-feed" type="url" inputMode="url" value={rssInput} onChange={(event) => setRssInput(event.target.value)} placeholder="https://publisher.com/feed.xml" />
                <button type="submit">Add feed</button>
              </div>
            </form>

            {preferences.sources.rssFeeds.length > 0 && (
              <ul className="rss-feeds">
                {preferences.sources.rssFeeds.map((feed) => (
                  <li key={feed}><span>{feedName(feed)}</span><button type="button" onClick={() => removeRssFeed(feed)} aria-label={`Remove ${feedName(feed)} feed`}>&#215;</button></li>
                ))}
              </ul>
            )}
          </div>

          <div className="settings-row">
            <div className="field compact-field">
              <label htmlFor="story-limit">Stories per topic</label>
              <select id="story-limit" value={preferences.limit} onChange={(event) => setPreferences((current) => ({ ...current, limit: Number(event.target.value) }))}>
                {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div className="field compact-field">
              <label htmlFor="refresh-rate">Refresh</label>
              <select id="refresh-rate" value={preferences.refreshMinutes} onChange={(event) => setPreferences((current) => ({ ...current, refreshMinutes: Number(event.target.value) }))}>
                <option value={0}>Manual</option><option value={5}>Every 5 min</option><option value={15}>Every 15 min</option><option value={30}>Every 30 min</option><option value={60}>Every hour</option>
              </select>
            </div>
          </div>
          <p className="settings-note">Your topics, sources and settings are saved on this device.</p>
        </div>
      </section>

      <section className="feed" aria-labelledby="feed-title">
        <div className="feed-heading">
          <div><p className="eyebrow">Latest signal</p><h2 id="feed-title">{feedTitle}</h2></div>
          <div className="feed-actions">
            <div className="feed-meta" aria-live="polite">
              {fetchedAt ? `${filteredArticles.length} stories / ${publisherCount} publishers / updated ${formatAge(fetchedAt)}` : preferences.topics.length > 0 && enabledSourceCount > 0 ? "Gathering recent coverage" : "Add a topic and source to begin"}
            </div>
            <button className="refresh-button" onClick={() => void loadNews(preferences)} disabled={loading || preferences.topics.length === 0 || enabledSourceCount === 0}><RefreshIcon spinning={loading} /> Refresh</button>
          </div>
        </div>

        {preferences.topics.length > 0 && (
          <div className="filter-stack">
            <nav className="topic-filters" aria-label="Filter stories by followed topic">
              <span className="filter-label">Topics</span>
              <button type="button" className={selectedTopic === ALL_TOPICS ? "active" : ""} aria-pressed={selectedTopic === ALL_TOPICS} onClick={() => setSelectedTopic(ALL_TOPICS)}>All <span>{articles.length}</span></button>
              {preferences.topics.map((topic) => (
                <button type="button" key={topic} className={selectedTopic === topic ? "active" : ""} aria-pressed={selectedTopic === topic} onClick={() => setSelectedTopic(topic)}>{topic} <span>{topicCounts[topic] ?? 0}</span></button>
              ))}
            </nav>
            {availableProviders.length > 0 && (
              <nav className="source-filters" aria-label="Filter stories by news source">
                <span className="filter-label">Sources</span>
                <button type="button" className={selectedProvider === ALL_PROVIDERS ? "active" : ""} aria-pressed={selectedProvider === ALL_PROVIDERS} onClick={() => setSelectedProvider(ALL_PROVIDERS)}>All sources <span>{topicFilteredArticles.length}</span></button>
                {availableProviders.map((provider) => (
                  <button type="button" key={provider} className={selectedProvider === provider ? "active" : ""} aria-pressed={selectedProvider === provider} onClick={() => setSelectedProvider(provider)}>{provider} <span>{providerCounts[provider] ?? 0}</span></button>
                ))}
              </nav>
            )}
          </div>
        )}

        {notice && <p className="feed-notice" role="status">{notice}</p>}

        {preferences.topics.length === 0 ? (
          <div className="message-card"><p className="message-kicker">Your briefing is empty</p><h3>Add a topic to begin.</h3><p>Your followed topics will appear here as filters, with everything combined under All.</p></div>
        ) : enabledSourceCount === 0 ? (
          <div className="message-card"><p className="message-kicker">No sources selected</p><h3>Choose where Signal should look.</h3><p>Turn on Google News or GDELT, or add a publisher RSS feed.</p></div>
        ) : error ? (
          <div className="message-card" role="alert"><p className="message-kicker">The signal dropped</p><h3>We couldn&apos;t gather the latest stories.</h3><p>{error}</p><button onClick={() => void loadNews(preferences)}>Try again</button></div>
        ) : loading && articles.length === 0 ? (
          <div className="loading-list" aria-label="Loading recent stories">{Array.from({ length: 4 }, (_, index) => <div className="loading-row" key={index} />)}</div>
        ) : filteredArticles.length === 0 ? (
          <div className="message-card"><p className="message-kicker">No coverage found</p><h3>Try a broader filter.</h3><p>Choose All sources or use a more general topic to widen the signal.</p></div>
        ) : (
          <ol className="story-list">
            {filteredArticles.map((article, index) => (
              <li key={articleKey(article)}>
                <a href={article.url} target="_blank" rel="noreferrer" className="story-link">
                  <span className="story-number">{String(index + 1).padStart(2, "0")}</span>
                  <article>
                    <div className="story-meta"><span className="story-topic">{article.topics.join(" + ")}</span><span className="story-provider">{article.providers.join(" + ")}</span><span>{article.source}</span><span>{formatAge(article.publishedAt)}</span></div>
                    <h3>{article.title}</h3>{article.summary && <p>{article.summary}</p>}
                  </article>
                  <ArrowIcon />
                </a>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer><p><span className="footer-dot" /> SIGNAL gathers public reporting and sends you to the original publisher.</p><a href="#top">Back to top &#8593;</a></footer>
    </main>
  );
}
