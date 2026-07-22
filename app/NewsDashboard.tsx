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

type GoogleTrendTerm = {
  keyword: string;
  traffic: string;
};

type GoogleTrendsResponse = {
  geo: string;
  fetchedAt: string;
  terms: GoogleTrendTerm[];
  error?: string;
};

type NewsRequest = {
  topics: string[];
  provider: "google" | "gdelt" | "rss";
  feed?: string;
  sourceKey: string;
  sourceLabel: string;
};

export type SourcePreferences = {
  google: boolean;
  gdelt: boolean;
  rssFeeds: string[];
};

export type NewsPreferences = {
  topics: string[];
  limit: number;
  refreshMinutes: number;
  emailSummaryEnabled: boolean;
  sources: SourcePreferences;
};

export type NewsSummary = {
  refreshedAt: string;
  topics: string[];
  articles: FollowedArticle[];
};

export type PreferencesStore = {
  load: () => Promise<{ exists: boolean; preferences: NewsPreferences }>;
  save: (preferences: NewsPreferences) => Promise<NewsPreferences>;
};

const DEFAULTS: NewsPreferences = {
  topics: ["Artificial intelligence"],
  limit: 6,
  refreshMinutes: 15,
  emailSummaryEnabled: false,
  sources: { google: true, gdelt: true, rssFeeds: [] },
};

const STORAGE_KEY = "signal-news-preferences";
const PENDING_STORAGE_KEY = "signal-news-preferences-pending";
const CONTROLS_STORAGE_KEY = "signal-briefing-controls-expanded";
const CONTROLS_HIDDEN_STORAGE_KEY = "signal-briefing-controls-hidden";
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

function providerPriority(provider: string) {
  if (provider.startsWith("RSS / ")) return 0;
  if (provider === "GDELT") return 1;
  return 2;
}

function selectBalancedArticles(candidates: FollowedArticle[], limit: number) {
  const providers = Array.from(new Set(candidates.flatMap((article) => article.providers)))
    .sort((left, right) => providerPriority(left) - providerPriority(right));
  const selected = new Set<string>();

  // Give every available source a turn before taking another story from it.
  // Direct publisher feeds go first so aggregators cannot crowd them out.
  let addedInRound = true;
  while (selected.size < limit && addedInRound) {
    addedInRound = false;
    for (const provider of providers) {
      const next = candidates.find(
        (article) => article.providers.includes(provider) && !selected.has(articleKey(article)),
      );
      if (!next) continue;
      selected.add(articleKey(next));
      addedInRound = true;
      if (selected.size === limit) break;
    }
  }

  for (const article of candidates) {
    if (selected.size === limit) break;
    selected.add(articleKey(article));
  }
  return candidates.filter((article) => selected.has(articleKey(article)));
}

function summarizeSources(labels: string[]) {
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

function normalizePreferences(saved: Partial<NewsPreferences> & { topic?: string }): NewsPreferences {
  const savedTopics = Array.isArray(saved.topics)
    ? saved.topics
      .filter((topic): topic is string => typeof topic === "string" && Boolean(topic.trim()))
      .map((topic) => topic.trim().replace(/\s+/g, " ").slice(0, 80))
    : typeof saved.topic === "string" && saved.topic.trim()
      ? [saved.topic.trim()]
      : DEFAULTS.topics;
  const topics = savedTopics
    .filter((topic, index) => savedTopics.findIndex((candidate) => candidate.toLowerCase() === topic.toLowerCase()) === index)
    .slice(0, 20);
  const rssFeeds = Array.isArray(saved.sources?.rssFeeds)
    ? saved.sources.rssFeeds.filter((feed): feed is string => typeof feed === "string" && feed.startsWith("https://"))
    : [];

  return {
    topics,
    limit: Math.min(10, Math.max(1, Number(saved.limit) || DEFAULTS.limit)),
    refreshMinutes: [0, 5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480].includes(Number(saved.refreshMinutes))
      ? Number(saved.refreshMinutes)
      : DEFAULTS.refreshMinutes,
    emailSummaryEnabled: saved.emailSummaryEnabled === true,
    sources: {
      google: typeof saved.sources?.google === "boolean" ? saved.sources.google : true,
      gdelt: typeof saved.sources?.gdelt === "boolean" ? saved.sources.gdelt : true,
      rssFeeds: Array.from(new Set(rssFeeds)).slice(0, 20),
    },
  };
}

function readStoredPreferences(key: string) {
  if (typeof window === "undefined") return { exists: false, preferences: DEFAULTS };
  const raw = localStorage.getItem(key);
  if (raw === null) return { exists: false, preferences: DEFAULTS };
  try {
    return {
      exists: true,
      preferences: normalizePreferences(JSON.parse(raw) as Partial<NewsPreferences> & { topic?: string }),
    };
  } catch {
    return { exists: true, preferences: DEFAULTS };
  }
}

type NewsDashboardProps = {
  user: {
    displayName: string;
    email: string;
    fullName: string | null;
    isLocalPreview: boolean;
  };
  signOutPath?: string | null;
  onSignOut?: () => void;
  onManageAccount?: () => void;
  preferencesStore?: PreferencesStore;
  summarySender?: (summary: NewsSummary) => Promise<string>;
};

export default function NewsDashboard({ user, signOutPath, onSignOut, onManageAccount, preferencesStore, summarySender }: NewsDashboardProps) {
  const [preferences, setPreferences] = useState<NewsPreferences>(DEFAULTS);
  const [topicInput, setTopicInput] = useState("");
  const [rssInput, setRssInput] = useState("");
  const [selectedTopic, setSelectedTopic] = useState(ALL_TOPICS);
  const [selectedProvider, setSelectedProvider] = useState(ALL_PROVIDERS);
  const [articles, setArticles] = useState<FollowedArticle[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [trendsOpen, setTrendsOpen] = useState(false);
  const [trendingTerms, setTrendingTerms] = useState<GoogleTrendTerm[]>([]);
  const [trendsFetchedAt, setTrendsFetchedAt] = useState("");
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [trendsError, setTrendsError] = useState("");
  const [ready, setReady] = useState(false);
  const [heroCompact, setHeroCompact] = useState(false);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [storageStatus, setStorageStatus] = useState<"loading" | "saving" | "saved" | "error" | "local">(
    preferencesStore ? "loading" : "local",
  );
  const requestSequence = useRef(0);
  const lastSavedPreferences = useRef("");
  const latestPreferences = useRef(preferences);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const enabledSourceCount = Number(preferences.sources.google)
    + Number(preferences.sources.gdelt)
    + preferences.sources.rssFeeds.length;

  useEffect(() => {
    let cancelled = false;

    async function hydratePreferences() {
      const local = readStoredPreferences(STORAGE_KEY);
      if (!preferencesStore) {
        if (!cancelled) {
          setPreferences(local.preferences);
          lastSavedPreferences.current = JSON.stringify(local.preferences);
          setReady(true);
        }
        return;
      }

      const pending = readStoredPreferences(PENDING_STORAGE_KEY);
      try {
        const remote = await preferencesStore.load();
        let next = normalizePreferences(remote.preferences);
        if (pending.exists) {
          next = normalizePreferences(await preferencesStore.save(pending.preferences));
        } else if (!remote.exists && local.exists) {
          next = normalizePreferences(await preferencesStore.save(local.preferences));
        }
        if (cancelled) return;
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(PENDING_STORAGE_KEY);
        setPreferences(next);
        lastSavedPreferences.current = JSON.stringify(next);
        setStorageStatus("saved");
      } catch {
        if (cancelled) return;
        const fallback = pending.exists ? pending.preferences : local.preferences;
        setPreferences(fallback);
        lastSavedPreferences.current = JSON.stringify(fallback);
        setStorageStatus("error");
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void hydratePreferences();
    return () => { cancelled = true; };
  }, [preferencesStore]);

  useEffect(() => {
    latestPreferences.current = preferences;
  }, [preferences]);

  useEffect(() => {
    setControlsExpanded(localStorage.getItem(CONTROLS_STORAGE_KEY) === "true");
    setControlsHidden(localStorage.getItem(CONTROLS_HIDDEN_STORAGE_KEY) === "true");
  }, []);

  useEffect(() => {
    if (!ready || loading || heroCompact) return;
    const timeout = window.setTimeout(() => setHeroCompact(true), 300);
    return () => window.clearTimeout(timeout);
  }, [ready, loading, heroCompact]);

  const loadNews = useCallback(async (
    next: NewsPreferences,
    options: { quiet?: boolean; emailSummary?: boolean } = {},
  ) => {
    const runId = ++requestSequence.current;
    if (!options.quiet) setLoading(true);
    setError("");
    setNotice("");

    const requests: NewsRequest[] = next.topics.flatMap((topic) => [
      ...(next.sources.google ? [{
        topics: [topic],
        provider: "google" as const,
        sourceKey: "google",
        sourceLabel: "Google News",
      }] : []),
      ...next.sources.rssFeeds.map((feed) => ({
        topics: [topic],
        provider: "rss" as const,
        feed,
        sourceKey: `rss:${feed}`,
        sourceLabel: feedName(feed),
      })),
    ]);
    if (next.sources.gdelt) requests.push({
      topics: next.topics,
      provider: "gdelt",
      sourceKey: "gdelt",
      sourceLabel: "GDELT",
    });

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
      const successful = results.flatMap((result, index) => result.status === "fulfilled"
        ? [{ feed: result.value, request: requests[index] }]
        : []);
      if (successful.length === 0) throw new Error("The selected news sources could not be reached.");

      const merged = new Map<string, FollowedArticle>();
      successful.forEach(({ feed }) => {
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
        selectBalancedArticles(
          sorted.filter((article) => article.topics.includes(topic)),
          next.limit,
        ).forEach((article) => included.add(articleKey(article)));
      });
      const refreshedArticles = sorted.filter((article) => included.has(articleKey(article)));
      const refreshedAt = successful.map(({ feed }) => feed.fetchedAt).sort((left, right) => right.localeCompare(left))[0] ?? "";
      setArticles(refreshedArticles);
      setFetchedAt(refreshedAt);

      const sourceOutcomes = new Map<string, { label: string; successes: number; articles: number }>();
      requests.forEach((request, index) => {
        const current = sourceOutcomes.get(request.sourceKey) ?? {
          label: request.sourceLabel,
          successes: 0,
          articles: 0,
        };
        const result = results[index];
        if (result.status === "fulfilled") {
          current.successes += 1;
          current.articles += result.value.articles.length;
        }
        sourceOutcomes.set(request.sourceKey, current);
      });
      const failedSources = Array.from(sourceOutcomes.values())
        .filter((source) => source.successes === 0)
        .map((source) => source.label);
      const emptySources = Array.from(sourceOutcomes.values())
        .filter((source) => source.successes > 0 && source.articles === 0)
        .map((source) => source.label);
      const notices = [
        failedSources.length > 0 ? `Could not refresh ${summarizeSources(failedSources)}.` : "",
        emptySources.length > 0 ? `No followed-topic matches from ${summarizeSources(emptySources)}.` : "",
      ].filter(Boolean);
      if (options.emailSummary && next.emailSummaryEnabled && summarySender) {
        try {
          notices.push(await summarySender({ refreshedAt, topics: next.topics, articles: refreshedArticles }));
        } catch (caught) {
          notices.push(caught instanceof Error
            ? caught.message
            : "The briefing refreshed, but its email summary could not be delivered.");
        }
      }
      if (runId === requestSequence.current && notices.length > 0) setNotice(notices.join(" "));
    } catch (caught) {
      if (runId === requestSequence.current) {
        setError(caught instanceof Error ? caught.message : "The news sources could not be reached.");
      }
    } finally {
      if (runId === requestSequence.current) setLoading(false);
    }
  }, [summarySender]);

  const loadTrendingTerms = useCallback(async () => {
    setTrendsLoading(true);
    setTrendsError("");
    try {
      const response = await fetch("/api/trends", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({})) as GoogleTrendsResponse;
      if (!response.ok) throw new Error(data.error || "Could not load Google Trends.");
      setTrendingTerms(data.terms);
      setTrendsFetchedAt(data.fetchedAt);
    } catch (caught) {
      setTrendsError(caught instanceof Error ? caught.message : "Could not load Google Trends.");
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const serialized = JSON.stringify(preferences);
    if (serialized === lastSavedPreferences.current) return;

    if (!preferencesStore) {
      localStorage.setItem(STORAGE_KEY, serialized);
      lastSavedPreferences.current = serialized;
      setStorageStatus("local");
      return;
    }

    // Keep an immediate browser backup until the ordered SQLite save completes.
    localStorage.setItem(PENDING_STORAGE_KEY, serialized);
    setStorageStatus("saving");
    const requested = preferences;
    const timeout = window.setTimeout(() => {
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          const saved = normalizePreferences(await preferencesStore.save(requested));
          const savedSerialized = JSON.stringify(saved);
          lastSavedPreferences.current = savedSerialized;
          if (localStorage.getItem(PENDING_STORAGE_KEY) === serialized) {
            localStorage.removeItem(PENDING_STORAGE_KEY);
          }
          localStorage.removeItem(STORAGE_KEY);
          if (JSON.stringify(latestPreferences.current) === serialized) {
            if (savedSerialized !== serialized) setPreferences(saved);
            setStorageStatus("saved");
          }
        } catch {
          localStorage.setItem(PENDING_STORAGE_KEY, serialized);
          if (JSON.stringify(latestPreferences.current) === serialized) setStorageStatus("error");
        }
      });
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [preferences, ready, preferencesStore]);

  useEffect(() => {
    if (!ready) return;
    void loadNews(preferences);
  }, [preferences.topics, preferences.limit, preferences.sources, ready, loadNews]);

  useEffect(() => {
    if (!ready || preferences.refreshMinutes === 0 || preferences.topics.length === 0 || enabledSourceCount === 0) return;
    const interval = window.setInterval(
      () => void loadNews(preferences, { quiet: true, emailSummary: true }),
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

  function addTopic(value: string) {
    const topic = value.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!topic) return false;
    if (preferences.topics.length >= 20) {
      setNotice("You can follow up to 20 topics.");
      return false;
    }
    const existing = preferences.topics.find((followed) => followed.toLowerCase() === topic.toLowerCase());
    if (existing) {
      setSelectedTopic(existing);
      setNotice(`You already follow ${existing}.`);
      return false;
    }
    setPreferences((current) => ({ ...current, topics: [...current.topics, topic] }));
    setSelectedTopic(topic);
    setNotice(`Now following ${topic}.`);
    return true;
  }

  function submitTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addTopic(topicInput);
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
      } else if (preferences.sources.rssFeeds.length >= 20) {
        setNotice("You can add up to 20 publisher feeds.");
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

  function toggleControls() {
    setControlsExpanded((current) => {
      const next = !current;
      localStorage.setItem(CONTROLS_STORAGE_KEY, String(next));
      return next;
    });
  }

  function hideControls() {
    localStorage.setItem(CONTROLS_HIDDEN_STORAGE_KEY, "true");
    setControlsHidden(true);
  }

  function showControls() {
    localStorage.setItem(CONTROLS_HIDDEN_STORAGE_KEY, "false");
    setControlsHidden(false);
  }

  const feedTitle = selectedTopic === ALL_TOPICS ? "All followed topics" : selectedTopic;

  return (
    <main className="signal-dashboard">
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
            {onManageAccount && <button type="button" onClick={onManageAccount}>Account</button>}
            {onSignOut
              ? <button type="button" onClick={onSignOut}>Sign out</button>
              : signOutPath
                ? <a href={signOutPath}>Sign out</a>
                : <span className="preview-session">Preview</span>}
          </div>
        </div>
      </header>

      {controlsHidden && (
        <button className="control-panel-reveal" type="button" onClick={showControls}>
          Topics <span aria-hidden="true">&#43;</span>
        </button>
      )}

      <section className={`hero${controlsHidden ? " controls-hidden" : ""}${heroCompact ? " compact" : ""}`} id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your interests, continuously monitored</p>
          <h1>Stay current on<br />{" "}<em>what matters.</em></h1>
          <p className="lede">One focused briefing across multiple news networks and the publishers you trust.</p>
        </div>
      </section>

      <div className={controlsHidden ? "content-layout controls-hidden" : "content-layout"}>

        {!controlsHidden && <div className={controlsExpanded ? "control-panel expanded" : "control-panel"}>
          <div className="control-panel-header">
            <div className="control-panel-heading">
              <h2>Add a topic to follow</h2>
              <p>{preferences.topics.length} followed <span aria-hidden="true">/</span> {enabledSourceCount} sources</p>
            </div>
            <div className="control-panel-actions">
              <button
                type="button"
                className="control-panel-toggle"
                aria-expanded={controlsExpanded}
                aria-controls="briefing-controls"
                onClick={toggleControls}
              >
                {controlsExpanded ? "Collapse" : "Manage"}
                <span className="control-panel-chevron" aria-hidden="true">&#8595;</span>
              </button>
              <button
                type="button"
                className="control-panel-dismiss"
                onClick={hideControls}
                aria-label="Hide topic controls on the right side"
              >
                &#215;
              </button>
            </div>
          </div>

          <div id="briefing-controls" className="control-panel-body" hidden={!controlsExpanded}>
          <form onSubmit={submitTopic}>
            <div className="field topic-field">
              <label htmlFor="topic">Topic</label>
              <div className="topic-input-wrap">
                <input id="topic" maxLength={80} value={topicInput} onChange={(event) => setTopicInput(event.target.value)} placeholder="e.g. renewable energy" autoComplete="off" />
                <button type="submit" aria-label="Add topic">Add <span aria-hidden="true">&#43;</span></button>
              </div>
            </div>
          </form>

          {preferencesStore && (
            <div className={trendsOpen ? "trends-picker open" : "trends-picker"}>
              <button
                type="button"
                className="trends-picker-toggle"
                aria-expanded={trendsOpen}
                aria-controls="google-trending-terms"
                onClick={() => {
                  const next = !trendsOpen;
                  setTrendsOpen(next);
                  if (next && trendingTerms.length === 0 && !trendsLoading) void loadTrendingTerms();
                }}
              >
                <span><strong>Trending now</strong><small>Latest Google searches in New Zealand</small></span>
                <span className="trends-picker-action">{trendsOpen ? "Hide" : "Browse"}</span>
              </button>
              {trendsOpen && (
                <div className="trends-picker-content" id="google-trending-terms">
                  <div className="trends-picker-meta">
                    <span>{trendsFetchedAt ? `Updated ${formatAge(trendsFetchedAt)}` : "Google Trends"}</span>
                    <button type="button" onClick={() => void loadTrendingTerms()} disabled={trendsLoading}>Refresh</button>
                  </div>
                  {trendsLoading && trendingTerms.length === 0 ? (
                    <p className="trends-message">Loading current searches...</p>
                  ) : trendsError ? (
                    <p className="trends-message error">{trendsError}</p>
                  ) : (
                    <div className="trend-terms" aria-label="Current Google trending searches">
                      {trendingTerms.map((term) => {
                        const followed = preferences.topics.some((topic) => topic.toLowerCase() === term.keyword.toLowerCase());
                        return (
                          <button
                            type="button"
                            key={term.keyword}
                            disabled={followed}
                            onClick={() => addTopic(term.keyword)}
                            aria-label={`${followed ? "Already following" : "Follow"} ${term.keyword}${term.traffic ? `, ${term.traffic} searches` : ""}`}
                          >
                            <span>{term.keyword}</span>
                            {term.traffic && <small>{term.traffic}</small>}
                            <b aria-hidden="true">{followed ? "✓" : "+"}</b>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

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
                <option value={0}>Manual</option><option value={5}>Every 5 min</option><option value={15}>Every 15 min</option><option value={30}>Every 30 min</option><option value={60}>Every hour</option><option value={120}>Every 2 hours</option><option value={180}>Every 3 hours</option><option value={240}>Every 4 hours</option><option value={300}>Every 5 hours</option><option value={360}>Every 6 hours</option><option value={420}>Every 7 hours</option><option value={480}>Every 8 hours</option>
              </select>
            </div>
          </div>
          {preferencesStore && summarySender && (
            <label className="email-summary-toggle">
              <input
                type="checkbox"
                checked={preferences.emailSummaryEnabled}
                onChange={(event) => setPreferences((current) => ({
                  ...current,
                  emailSummaryEnabled: event.target.checked,
                }))}
              />
              <span>
                <strong>Email refreshed briefing</strong>
                <small>Send a polished summary to {user.email} after scheduled and manual refreshes.</small>
              </span>
            </label>
          )}
          <p className="settings-note" aria-live="polite">
            {!preferencesStore
              ? "Your topics, sources and settings are saved on this device."
              : storageStatus === "loading"
                ? "Loading your saved account settings..."
                : storageStatus === "saving"
                  ? "Saving settings to your account..."
                  : storageStatus === "error"
                    ? "Could not sync settings. Changes are backed up in this browser and will retry next time."
                    : "Your topics, sources and settings are saved to your account."}
          </p>
          </div>
        </div>}

      <section className="feed" aria-labelledby="feed-title">
        <div className="feed-heading">
          <div><p className="eyebrow">Latest signal</p><h2 id="feed-title">{feedTitle}</h2></div>
          <div className="feed-actions">
            <div className="feed-meta" aria-live="polite">
              {fetchedAt ? `${filteredArticles.length} stories / ${publisherCount} publishers / updated ${formatAge(fetchedAt)}` : preferences.topics.length > 0 && enabledSourceCount > 0 ? "Gathering recent coverage" : "Add a topic and source to begin"}
            </div>
            <button className="refresh-button" onClick={() => void loadNews(preferences, { emailSummary: true })} disabled={loading || preferences.topics.length === 0 || enabledSourceCount === 0}><RefreshIcon spinning={loading} /> Refresh</button>
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
          <div className="message-card" role="alert"><p className="message-kicker">The signal dropped</p><h3>We couldn&apos;t gather the latest stories.</h3><p>{error}</p><button onClick={() => void loadNews(preferences, { emailSummary: true })}>Try again</button></div>
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
      </div>

      <footer><p><span className="footer-dot" /> SIGNAL gathers public reporting and sends you to the original publisher.</p><a href="#top">Back to top &#8593;</a></footer>
    </main>
  );
}
