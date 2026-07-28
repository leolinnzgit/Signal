"use client";

import { type CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { suggestNewsSources } from "./source-suggestions";

type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary: string;
  matchedTopics?: string[];
};

export type FollowedArticle = Article & {
  topics: string[];
  providers: string[];
  isBookmarked?: boolean;
  isRead?: boolean;
};

type ExtractedReaderArticle = {
  finalUrl: string;
  byline: string;
  siteName: string;
  publishedAt: string;
  paragraphs: string[];
};

type ReaderContent =
  | { status: "idle" | "loading" }
  | { status: "ready"; article: ExtractedReaderArticle };

type ArticleReaderResponse = {
  available: boolean;
  reason?: string;
  article?: ExtractedReaderArticle;
};

export type StoredArticle = FollowedArticle & {
  firstSeenAt: string;
  lastSeenAt: string;
  isBookmarked: boolean;
  bookmarkedAt: string | null;
  isRead: boolean;
  readAt: string | null;
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
  region: string;
};

type GoogleTrendsResponse = {
  geo: string;
  fetchedAt: string;
  terms: GoogleTrendTerm[];
  error?: string;
};

type LocalWeather = {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  weatherCode: number;
  windSpeed: number;
  isDay: boolean;
  timezone: string;
};

type OpenMeteoResponse = {
  timezone?: string;
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    weather_code?: number;
    wind_speed_10m?: number;
    is_day?: number;
  };
};

type WeatherStatus = "locating" | "ready" | "denied" | "error" | "unsupported";

type MarketQuote = {
  topic: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number;
  change: number;
  percentChange: number;
  quoteTime: string;
  isMarketOpen: boolean | null;
  provider: string;
};

type MarketNotice = {
  topic: string;
  status: "not-found";
  message: string;
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

export type StoryTitleSize = "small" | "medium" | "large";

export type NewsPreferences = {
  topics: string[];
  limit: number;
  storyTitleSize: StoryTitleSize;
  refreshMinutes: number;
  emailSummaryEnabled: boolean;
  articleRetentionDays: number;
  tickerOverrides: Record<string, string>;
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
  resolveFeed?: (
    feed: string,
    existingFeeds: string[],
  ) => Promise<{ feed: string; added: boolean; duplicateOf: string | null; feeds: string[] }>;
};

export type ArticleHistoryPage = {
  articles: StoredArticle[];
  historyTotal: number;
  bookmarkTotal: number;
  matchingTotal: number;
  filterTotal: number;
  hasMore: boolean;
  bookmarkedUrls: string[];
  readUrls: string[];
  topicFacets: ArticleHistoryFacet[];
  providerFacets: ArticleHistoryFacet[];
};

export type ArticleHistoryFacet = { value: string; count: number };

export type TopicRefreshStatus = {
  topic: string;
  lastAttemptedAt: string | null;
  lastSuccessfulAt: string | null;
  nextRefreshAt: string | null;
  lastError: string;
};

export type TopicBriefing = {
  articles: FollowedArticle[];
  topics: TopicRefreshStatus[];
  refreshedAt: string | null;
  historyTotal: number;
  bookmarkTotal: number;
};

export type ArticleHistoryQuery = {
  offset?: number;
  limit?: number;
  search?: string;
  bookmarksOnly?: boolean;
  topic?: string;
  provider?: string;
};

export type ArticleStore = {
  load: (query?: ArticleHistoryQuery) => Promise<ArticleHistoryPage>;
  sync: (articles: FollowedArticle[]) => Promise<ArticleHistoryPage>;
  setBookmark: (url: string, bookmarked: boolean) => Promise<void>;
  setRead: (url: string) => Promise<void>;
};

export type TopicRefreshStore = {
  load: (topic?: string) => Promise<TopicBriefing>;
  refresh: (topic?: string) => Promise<TopicBriefing>;
};

const DEFAULTS: NewsPreferences = {
  topics: ["Artificial intelligence"],
  limit: 20,
  storyTitleSize: "large",
  refreshMinutes: 15,
  emailSummaryEnabled: false,
  articleRetentionDays: 30,
  tickerOverrides: {},
  sources: { google: true, gdelt: true, rssFeeds: [] },
};
const STORY_LIMIT_OPTIONS = [10, ...Array.from({ length: 25 }, (_, index) => (index + 1) * 20)];

const STORAGE_KEY = "signal-news-preferences";
const PENDING_STORAGE_KEY = "signal-news-preferences-pending";
const CONTROLS_STORAGE_KEY = "signal-briefing-controls-expanded";
const CONTROLS_HIDDEN_STORAGE_KEY = "signal-briefing-controls-hidden";
const THEME_STORAGE_KEY = "signal-color-theme";
const ALL_TOPICS = "all";
const ALL_PROVIDERS = "all";
const HISTORY_PAGE_SIZE = 50;
const VISIBLE_TOPIC_FILTERS = 6;
const VISIBLE_SOURCE_FILTERS = 4;
const TOPICS_PER_PROVIDER_BATCH = 8;

type ColorTheme = "light" | "dark";

function timestampValue(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasTimeZone ? normalized : `${normalized}Z`).getTime();
}

function ArrowIcon() {
  return <span aria-hidden="true" className="arrow">&#8599;</span>;
}

function RefreshIcon({ spinning = false }: { spinning?: boolean }) {
  return <span aria-hidden="true" className={spinning ? "refresh-icon spinning" : "refresh-icon"}>&#8635;</span>;
}

function formatAge(value: string) {
  const then = timestampValue(value);
  const diffMinutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatUntil(value: string) {
  const difference = timestampValue(value) - Date.now();
  if (difference <= 0) return "due now";
  const minutes = Math.max(1, Math.ceil(difference / 60000));
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

function topicRefreshLabel(status: TopicRefreshStatus | undefined, refreshMinutes: number) {
  if (!status) return refreshMinutes === 0 ? "Manual refresh only" : "Waiting for first refresh";
  if (!status.lastSuccessfulAt) {
    if (status.lastError) {
      return status.nextRefreshAt
        ? `Refresh failed · retry ${formatUntil(status.nextRefreshAt)}`
        : "Refresh failed · manual retry";
    }
    return status.nextRefreshAt ? `First refresh ${formatUntil(status.nextRefreshAt)}` : "Manual refresh only";
  }

  const lastAttemptedAt = status.lastAttemptedAt ? timestampValue(status.lastAttemptedAt) : 0;
  const lastSuccessfulAt = timestampValue(status.lastSuccessfulAt);
  const latestAttemptFailed = Boolean(status.lastError) && lastAttemptedAt > lastSuccessfulAt;
  if (latestAttemptFailed) {
    const retry = status.nextRefreshAt
      ? ` · retry ${formatUntil(status.nextRefreshAt)}`
      : " · manual retry";
    return `Updated ${formatAge(status.lastSuccessfulAt)} · refresh failed${retry}`;
  }

  const next = status.nextRefreshAt ? ` · next ${formatUntil(status.nextRefreshAt)}` : " · manual";
  return `Updated ${formatAge(status.lastSuccessfulAt)}${next}${status.lastError ? " · some sources failed" : ""}`;
}

function trendTrafficValue(value: string) {
  const match = value.toUpperCase().replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/);
  if (!match) return 0;
  const multiplier = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return Number(match[1]) * multiplier;
}

function trendBubbleSize(value: string, minimum: number, maximum: number) {
  const traffic = trendTrafficValue(value);
  if (traffic <= 0 || maximum <= minimum) return 5.6;
  const normalized = (Math.log10(traffic) - Math.log10(minimum)) / (Math.log10(maximum) - Math.log10(minimum));
  return 5.4 + (Math.max(0, Math.min(1, normalized)) * 4.6);
}

function feedName(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

function canonicalFeedKey(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    for (const name of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(name) || /^(fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function articleKey(article: Article) {
  return article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() || article.url;
}

function mergeTopicBriefingArticles(
  current: FollowedArticle[],
  incoming: FollowedArticle[],
  topic: string,
) {
  const topicKey = topic.toLowerCase();
  const byUrl = new Map<string, FollowedArticle>();

  current.forEach((article) => {
    const remainingTopics = article.topics.filter((candidate) => candidate.toLowerCase() !== topicKey);
    if (remainingTopics.length > 0) byUrl.set(article.url, { ...article, topics: remainingTopics });
  });

  incoming.forEach((article) => {
    const existing = byUrl.get(article.url);
    byUrl.set(article.url, existing
      ? {
          ...article,
          topics: Array.from(new Set([...existing.topics, ...article.topics])),
          providers: Array.from(new Set([...existing.providers, ...article.providers])),
          isBookmarked: article.isBookmarked ?? existing.isBookmarked,
          isRead: article.isRead ?? existing.isRead,
        }
      : article);
  });

  return Array.from(byUrl.values()).sort(
    (left, right) => timestampValue(right.publishedAt) - timestampValue(left.publishedAt),
  );
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

function topicBatches(topics: string[]) {
  return Array.from(
    { length: Math.ceil(topics.length / TOPICS_PER_PROVIDER_BATCH) },
    (_, index) => topics.slice(
      index * TOPICS_PER_PROVIDER_BATCH,
      (index + 1) * TOPICS_PER_PROVIDER_BATCH,
    ),
  );
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
    .filter((topic, index) => savedTopics.findIndex((candidate) => candidate.toLowerCase() === topic.toLowerCase()) === index);
  const rssFeeds = Array.isArray(saved.sources?.rssFeeds)
    ? saved.sources.rssFeeds.filter((feed): feed is string => typeof feed === "string" && feed.startsWith("https://"))
    : [];
  const feedKeys = new Set<string>();
  const rawTickerOverrides = saved.tickerOverrides
    && typeof saved.tickerOverrides === "object"
    && !Array.isArray(saved.tickerOverrides)
      ? saved.tickerOverrides
      : {};
  const tickerOverrides = topics.reduce<Record<string, string>>((result, topic) => {
    const entry = Object.entries(rawTickerOverrides)
      .find(([candidate]) => candidate.toLowerCase() === topic.toLowerCase());
    const symbol = typeof entry?.[1] === "string"
      ? entry[1].trim().replace(/^\$/, "").toUpperCase()
      : "";
    if (/^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(symbol)) result[topic] = symbol;
    return result;
  }, {});

  return {
    topics,
    limit: Number(saved.limit) === 10
      ? 10
      : Math.min(500, Math.max(20, Math.round((Number(saved.limit) || DEFAULTS.limit) / 20) * 20)),
    storyTitleSize: saved.storyTitleSize === "small" || saved.storyTitleSize === "medium" || saved.storyTitleSize === "large"
      ? saved.storyTitleSize
      : DEFAULTS.storyTitleSize,
    refreshMinutes: [0, 5, 15, 30, 60, 120, 180, 240, 300, 360, 420, 480].includes(Number(saved.refreshMinutes))
      ? Number(saved.refreshMinutes)
      : DEFAULTS.refreshMinutes,
    emailSummaryEnabled: saved.emailSummaryEnabled === true,
    articleRetentionDays: [1, 7, 14, 30, 90, 180, 365].includes(Number(saved.articleRetentionDays))
      ? Number(saved.articleRetentionDays)
      : DEFAULTS.articleRetentionDays,
    tickerOverrides,
    sources: {
      google: typeof saved.sources?.google === "boolean" ? saved.sources.google : true,
      gdelt: typeof saved.sources?.gdelt === "boolean" ? saved.sources.gdelt : true,
      rssFeeds: rssFeeds.filter((feed) => {
        const key = canonicalFeedKey(feed);
        return key !== null && !feedKeys.has(key) && Boolean(feedKeys.add(key));
      }).slice(0, 20),
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

function describeWeather(code: number) {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Local weather";
}

function weatherGlyph(code: number, isDay: boolean) {
  if (code === 0) return isDay ? "\u2600" : "\u263E";
  if (code <= 3) return "\u26C5";
  if (code === 45 || code === 48) return "\u224B";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "\u2744";
  if (code >= 95) return "\u26A1";
  return "\u2614";
}

function timezonePlace(timezone: string) {
  const segment = timezone.split("/").at(-1);
  return segment ? segment.replaceAll("_", " ") : "Current location";
}

function formatMarketPrice(price: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? "currency" : "decimal",
      currency: currency || undefined,
      maximumFractionDigits: 2,
    }).format(price);
  } catch {
    return `${currency ? `${currency} ` : ""}${price.toFixed(2)}`;
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
  articleStore?: ArticleStore;
  summarySender?: (summary: NewsSummary) => Promise<string>;
  refreshStore?: TopicRefreshStore;
};

export default function NewsDashboard({ user, signOutPath, onSignOut, onManageAccount, preferencesStore, articleStore, summarySender, refreshStore }: NewsDashboardProps) {
  const [preferences, setPreferences] = useState<NewsPreferences>(DEFAULTS);
  const [topicInput, setTopicInput] = useState("");
  const [rssInput, setRssInput] = useState("");
  const [selectedTopic, setSelectedTopic] = useState(ALL_TOPICS);
  const [recentTopicFilters, setRecentTopicFilters] = useState<string[]>([]);
  const [selectedProvider, setSelectedProvider] = useState(ALL_PROVIDERS);
  const [topicPickerOpen, setTopicPickerOpen] = useState(false);
  const [topicPickerQuery, setTopicPickerQuery] = useState("");
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [sourcePickerQuery, setSourcePickerQuery] = useState("");
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [articles, setArticles] = useState<FollowedArticle[]>([]);
  const [historyArticles, setHistoryArticles] = useState<StoredArticle[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [bookmarkTotal, setBookmarkTotal] = useState(0);
  const [historyMatchingTotal, setHistoryMatchingTotal] = useState(0);
  const [historyFilterTotal, setHistoryFilterTotal] = useState(0);
  const [historyTopicFacets, setHistoryTopicFacets] = useState<ArticleHistoryFacet[]>([]);
  const [historyProviderFacets, setHistoryProviderFacets] = useState<ArticleHistoryFacet[]>([]);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historySearchInput, setHistorySearchInput] = useState("");
  const [historySearch, setHistorySearch] = useState("");
  const [feedView, setFeedView] = useState<"latest" | "history" | "bookmarks">("latest");
  const [bookmarkingUrls, setBookmarkingUrls] = useState<Set<string>>(() => new Set());
  const [fetchedAt, setFetchedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [trendsOpen, setTrendsOpen] = useState(false);
  const [trendingTerms, setTrendingTerms] = useState<GoogleTrendTerm[]>([]);
  const [trendsFetchedAt, setTrendsFetchedAt] = useState("");
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [trendsError, setTrendsError] = useState("");
  const [trendsView, setTrendsView] = useState<"bubbles" | "list">("bubbles");
  const [topicRefreshStates, setTopicRefreshStates] = useState<TopicRefreshStatus[]>([]);
  const [ready, setReady] = useState(false);
  const [heroCompact, setHeroCompact] = useState(false);
  const [currentTime, setCurrentTime] = useState<Date | null>(null);
  const [localWeather, setLocalWeather] = useState<LocalWeather | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<WeatherStatus>("locating");
  const [weatherRetryKey, setWeatherRetryKey] = useState(0);
  const [marketQuote, setMarketQuote] = useState<MarketQuote | null>(null);
  const [marketNotice, setMarketNotice] = useState<MarketNotice | null>(null);
  const [tickerEditorOpen, setTickerEditorOpen] = useState(false);
  const [tickerInput, setTickerInput] = useState("");
  const [tickerValidating, setTickerValidating] = useState(false);
  const [tickerValidationMessage, setTickerValidationMessage] = useState("");
  const [controlsExpanded, setControlsExpanded] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [backToTopVisible, setBackToTopVisible] = useState(false);
  const [readerArticle, setReaderArticle] = useState<FollowedArticle | null>(null);
  const [readerContent, setReaderContent] = useState<ReaderContent>({ status: "idle" });
  const [theme, setTheme] = useState<ColorTheme | null>(null);
  const [rssResolvingFeed, setRssResolvingFeed] = useState<string | null>(null);
  const [rssMessage, setRssMessage] = useState("");
  const [storageStatus, setStorageStatus] = useState<"loading" | "saving" | "saved" | "error" | "local">(
    preferencesStore ? "loading" : "local",
  );
  const requestSequence = useRef(0);
  const historyRequestSequence = useRef(0);
  const heroElement = useRef<HTMLElement>(null);
  const filterStackElement = useRef<HTMLDivElement>(null);
  const storyListElement = useRef<HTMLOListElement>(null);
  const pendingPinnedTopicScroll = useRef<string | null>(null);
  const readerCloseButton = useRef<HTMLButtonElement>(null);
  const readerTrigger = useRef<HTMLAnchorElement | null>(null);
  const readerRequestSequence = useRef(0);
  const lastSavedPreferences = useRef("");
  const latestPreferences = useRef(preferences);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const enabledSourceCount = Number(preferences.sources.google)
    + Number(preferences.sources.gdelt)
    + preferences.sources.rssFeeds.length;
  const rssResolving = rssResolvingFeed !== null;
  const selectedTickerOverride = selectedTopic === ALL_TOPICS
    ? ""
    : Object.entries(preferences.tickerOverrides)
        .find(([topic]) => topic.toLowerCase() === selectedTopic.toLowerCase())?.[1] ?? "";

  const trendTrafficRange = useMemo(() => {
    const values = trendingTerms.map((term) => trendTrafficValue(term.traffic)).filter((value) => value > 0);
    return {
      minimum: values.length > 0 ? Math.min(...values) : 0,
      maximum: values.length > 0 ? Math.max(...values) : 0,
    };
  }, [trendingTerms]);

  const displayedTrendingTerms = useMemo(
    () => trendsView === "bubbles"
      ? [...trendingTerms].sort((left, right) => trendTrafficValue(right.traffic) - trendTrafficValue(left.traffic))
      : trendingTerms,
    [trendingTerms, trendsView],
  );

  const topicRefreshByKey = useMemo(
    () => new Map(topicRefreshStates.map((state) => [state.topic.toLowerCase(), state])),
    [topicRefreshStates],
  );

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
        } else if (!remote.exists) {
          next = normalizePreferences(await preferencesStore.save(DEFAULTS));
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

  const loadHistoryPage = useCallback(async (
    view: "history" | "bookmarks",
    search: string,
    offset = 0,
    topic = ALL_TOPICS,
    provider = ALL_PROVIDERS,
  ) => {
    if (!articleStore) return;
    const runId = ++historyRequestSequence.current;
    setHistoryLoading(true);
    setHistoryError("");
    if (offset === 0) setHistoryArticles([]);
    try {
      const page = await articleStore.load({
        offset,
        limit: HISTORY_PAGE_SIZE,
        search,
        bookmarksOnly: view === "bookmarks",
        topic: topic === ALL_TOPICS ? undefined : topic,
        provider: provider === ALL_PROVIDERS ? undefined : provider,
      });
      if (runId !== historyRequestSequence.current) return;
      setHistoryArticles((current) => {
        if (offset === 0) return page.articles;
        const existing = new Set(current.map((article) => article.url));
        return [...current, ...page.articles.filter((article) => !existing.has(article.url))];
      });
      setHistoryTotal(page.historyTotal);
      setBookmarkTotal(page.bookmarkTotal);
      setHistoryMatchingTotal(page.matchingTotal);
      setHistoryFilterTotal(page.filterTotal);
      setHistoryTopicFacets(page.topicFacets);
      setHistoryProviderFacets(page.providerFacets);
      setHistoryHasMore(page.hasMore);
    } catch (caught) {
      if (runId === historyRequestSequence.current) {
        setHistoryError(caught instanceof Error ? caught.message : "Could not load article history.");
      }
    } finally {
      if (runId === historyRequestSequence.current) setHistoryLoading(false);
    }
  }, [articleStore]);

  useEffect(() => {
    if (!articleStore) return;
    void loadHistoryPage("history", "", 0);
  }, [articleStore, loadHistoryPage]);

  useEffect(() => {
    setControlsExpanded(localStorage.getItem(CONTROLS_STORAGE_KEY) === "true");
    setControlsHidden(localStorage.getItem(CONTROLS_HIDDEN_STORAGE_KEY) === "true");
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    const initialTheme: ColorTheme = saved === "light" || saved === "dark"
      ? saved
      : media.matches ? "dark" : "light";

    document.documentElement.dataset.theme = initialTheme;
    document.documentElement.style.colorScheme = initialTheme;
    setTheme(initialTheme);

    const followSystemTheme = (event: MediaQueryListEvent) => {
      const currentSaved = localStorage.getItem(THEME_STORAGE_KEY);
      if (currentSaved === "light" || currentSaved === "dark") return;
      const nextTheme: ColorTheme = event.matches ? "dark" : "light";
      document.documentElement.dataset.theme = nextTheme;
      document.documentElement.style.colorScheme = nextTheme;
      setTheme(nextTheme);
    };
    media.addEventListener("change", followSystemTheme);
    return () => media.removeEventListener("change", followSystemTheme);
  }, []);

  useEffect(() => {
    if (!ready || loading || heroCompact) return;
    const timeout = window.setTimeout(() => setHeroCompact(true), 300);
    return () => window.clearTimeout(timeout);
  }, [ready, loading, heroCompact]);

  useEffect(() => {
    setCurrentTime(new Date());
    const clock = window.setInterval(() => setCurrentTime(new Date()), 30_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let weatherRefresh: number | undefined;

    if (!("geolocation" in navigator)) {
      setWeatherStatus("unsupported");
      return;
    }

    setWeatherStatus("locating");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const fetchWeather = async () => {
          try {
            const params = new URLSearchParams({
              latitude: coords.latitude.toFixed(4),
              longitude: coords.longitude.toFixed(4),
              current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
              temperature_unit: "celsius",
              wind_speed_unit: "kmh",
              timezone: "auto",
              forecast_days: "1",
            });
            const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
              cache: "no-store",
            });
            if (!response.ok) throw new Error("Weather unavailable");
            const data = (await response.json()) as OpenMeteoResponse;
            const current = data.current;
            if (
              !current
              || typeof current.temperature_2m !== "number"
              || typeof current.apparent_temperature !== "number"
              || typeof current.relative_humidity_2m !== "number"
              || typeof current.weather_code !== "number"
              || typeof current.wind_speed_10m !== "number"
            ) {
              throw new Error("Weather unavailable");
            }
            if (cancelled) return;
            setLocalWeather({
              temperature: current.temperature_2m,
              apparentTemperature: current.apparent_temperature,
              humidity: current.relative_humidity_2m,
              weatherCode: current.weather_code,
              windSpeed: current.wind_speed_10m,
              isDay: current.is_day !== 0,
              timezone: data.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setWeatherStatus("ready");
          } catch {
            if (!cancelled) setWeatherStatus("error");
          }
        };

        void fetchWeather();
        weatherRefresh = window.setInterval(() => void fetchWeather(), 30 * 60 * 1_000);
      },
      (locationError) => {
        if (!cancelled) setWeatherStatus(locationError.code === locationError.PERMISSION_DENIED ? "denied" : "error");
      },
      { enableHighAccuracy: false, maximumAge: 15 * 60 * 1_000, timeout: 12_000 },
    );

    return () => {
      cancelled = true;
      if (weatherRefresh !== undefined) window.clearInterval(weatherRefresh);
    };
  }, [weatherRetryKey]);

  useEffect(() => {
    let cancelled = false;
    if (selectedTopic === ALL_TOPICS) {
      setMarketQuote(null);
      setMarketNotice(null);
      return;
    }

    const loadMarketQuote = async () => {
      try {
        const params = new URLSearchParams({ topic: selectedTopic });
        if (selectedTickerOverride) params.set("symbol", selectedTickerOverride);
        const response = await fetch(`/api/market?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) {
          if (!cancelled) {
            setMarketQuote(null);
            setMarketNotice(null);
          }
          return;
        }
        const data = await response.json() as {
          matched: boolean;
          quote?: MarketQuote;
          topic?: string;
          status?: string;
          message?: string;
        };
        if (!cancelled) {
          setMarketQuote(data.matched && data.quote ? data.quote : null);
          setMarketNotice(
            !data.matched && data.status === "not-found" && data.message
              ? { topic: data.topic || selectedTopic, status: "not-found", message: data.message }
              : null,
          );
        }
      } catch {
        if (!cancelled) {
          setMarketQuote(null);
          setMarketNotice(null);
        }
      }
    };

    setMarketQuote(null);
    setMarketNotice(null);
    void loadMarketQuote();
    const refresh = window.setInterval(() => void loadMarketQuote(), 5 * 60 * 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(refresh);
    };
  }, [selectedTopic, selectedTickerOverride]);

  useEffect(() => {
    setTickerEditorOpen(false);
    setTickerValidationMessage("");
  }, [selectedTopic]);

  const loadNews = useCallback(async (
    next: NewsPreferences,
    options: { quiet?: boolean; emailSummary?: boolean; forceRefresh?: boolean; topic?: string } = {},
  ) => {
    const runId = ++requestSequence.current;
    if (!options.quiet) setLoading(true);
    setError("");
    setNotice("");

    if (refreshStore) {
      try {
        const briefing = options.forceRefresh
          ? await refreshStore.refresh()
          : await refreshStore.load(options.topic);
        if (runId !== requestSequence.current) return;
        setArticles((current) => options.topic
          ? mergeTopicBriefingArticles(current, briefing.articles, options.topic)
          : briefing.articles);
        setTopicRefreshStates(briefing.topics);
        setFetchedAt(briefing.refreshedAt ?? "");
        setHistoryTotal(briefing.historyTotal);
        setBookmarkTotal(briefing.bookmarkTotal);
        if (options.forceRefresh) {
          const partialCount = briefing.topics.filter((state) => state.lastError).length;
          setNotice(partialCount > 0
            ? `Topics refreshed. ${partialCount} ${partialCount === 1 ? "topic has" : "topics have"} a partial source error.`
            : "All topics refreshed and their individual schedules were reset.");
        }
      } catch (caught) {
        if (runId === requestSequence.current) {
          setError(caught instanceof Error ? caught.message : "The briefing could not be refreshed.");
        }
      } finally {
        if (runId === requestSequence.current) setLoading(false);
      }
      return;
    }

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
    if (next.sources.gdelt) {
      requests.push(...topicBatches(next.topics).map((topics) => ({
        topics,
        provider: "gdelt" as const,
        sourceKey: "gdelt",
        sourceLabel: "GDELT",
      })));
    }

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

      let historyNotice = "";
      if (articleStore) {
        try {
          const historyPage = await articleStore.sync(refreshedArticles);
          const bookmarkedUrls = new Set(historyPage.bookmarkedUrls);
          const readUrls = new Set(historyPage.readUrls);
          setHistoryTotal(historyPage.historyTotal);
          setBookmarkTotal(historyPage.bookmarkTotal);
          setArticles(refreshedArticles.map((article) => ({
            ...article,
            isBookmarked: bookmarkedUrls.has(article.url),
            isRead: readUrls.has(article.url),
          })));
        } catch {
          historyNotice = "Stories refreshed, but article history could not be saved.";
        }
      }

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
        historyNotice,
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
  }, [articleStore, refreshStore, summarySender]);

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
    if (!ready || preferences.topics.length === 0 || enabledSourceCount === 0) return;
    if (refreshStore) {
      const interval = window.setInterval(
        () => void loadNews(preferences, { quiet: true }),
        30_000,
      );
      return () => window.clearInterval(interval);
    }
    if (preferences.refreshMinutes === 0) return;
    const interval = window.setInterval(
      () => void loadNews(preferences, { quiet: true, emailSummary: true }),
      preferences.refreshMinutes * 60_000,
    );
    return () => window.clearInterval(interval);
  }, [preferences, ready, enabledSourceCount, loadNews, refreshStore]);

  const viewedArticles = useMemo(
    () => feedView === "latest"
      ? articles
      : historyArticles,
    [articles, feedView, historyArticles],
  );

  const topicFilteredArticles = useMemo(
    () => selectedTopic === ALL_TOPICS
      ? viewedArticles
      : viewedArticles.filter((article) => article.topics.includes(selectedTopic)),
    [selectedTopic, viewedArticles],
  );

  const filteredArticles = useMemo(
    () => selectedProvider === ALL_PROVIDERS
      ? topicFilteredArticles
      : topicFilteredArticles.filter((article) => article.providers.includes(selectedProvider)),
    [topicFilteredArticles, selectedProvider],
  );

  const topicCounts = useMemo(
    () => feedView === "latest"
      ? Object.fromEntries(
        preferences.topics.map((topic) => [topic, viewedArticles.filter((article) => article.topics.includes(topic)).length]),
      )
      : Object.fromEntries(historyTopicFacets.map((facet) => [facet.value, facet.count])),
    [feedView, historyTopicFacets, preferences.topics, viewedArticles],
  );

  const unreadTopicCounts = useMemo(
    () => Object.fromEntries(
      preferences.topics.map((topic) => [
        topic,
        articles.filter((article) =>
          !article.isRead
          && article.topics.some((candidate) => candidate.toLowerCase() === topic.toLowerCase()),
        ).length,
      ]),
    ),
    [articles, preferences.topics],
  );

  const visibleTopicFilters = useMemo(() => {
    const topicsByKey = new Map(preferences.topics.map((topic) => [topic.toLowerCase(), topic]));
    const stacked = recentTopicFilters
      .map((topic) => topicsByKey.get(topic.toLowerCase()))
      .filter((topic): topic is string => Boolean(topic));
    const initial = preferences.topics.slice(0, VISIBLE_TOPIC_FILTERS);
    return [...stacked, ...initial].filter(
      (topic, index, topics) =>
        topics.findIndex((candidate) => candidate.toLowerCase() === topic.toLowerCase()) === index,
    );
  }, [preferences.topics, recentTopicFilters]);

  const nextUnreadTopic = useMemo(() => {
    if (feedView !== "latest" || preferences.topics.length === 0) return "";
    const currentIndex = selectedTopic === ALL_TOPICS
      ? -1
      : preferences.topics.findIndex(
          (topic) => topic.toLowerCase() === selectedTopic.toLowerCase(),
        );
    for (let step = 1; step <= preferences.topics.length; step += 1) {
      const topic = preferences.topics[(currentIndex + step) % preferences.topics.length];
      if (topic.toLowerCase() === selectedTopic.toLowerCase()) continue;
      if ((unreadTopicCounts[topic] ?? 0) > 0) return topic;
    }
    return "";
  }, [feedView, preferences.topics, selectedTopic, unreadTopicCounts]);

  const pickerTopics = useMemo(() => {
    const query = topicPickerQuery.trim().toLowerCase();
    return query
      ? preferences.topics.filter((topic) => topic.toLowerCase().includes(query))
      : preferences.topics;
  }, [preferences.topics, topicPickerQuery]);

  const availableProviders = useMemo(
    () => feedView === "latest"
      ? Array.from(new Set(topicFilteredArticles.flatMap((article) => article.providers))).sort()
      : historyProviderFacets.map((facet) => facet.value),
    [feedView, historyProviderFacets, topicFilteredArticles],
  );

  const providerCounts = useMemo(
    () => feedView === "latest"
      ? Object.fromEntries(
        availableProviders.map((provider) => [
          provider,
          topicFilteredArticles.filter((article) => article.providers.includes(provider)).length,
        ]),
      )
      : Object.fromEntries(historyProviderFacets.map((facet) => [facet.value, facet.count])),
    [availableProviders, feedView, historyProviderFacets, topicFilteredArticles],
  );

  const visibleSourceFilters = useMemo(() => {
    const selected = selectedProvider === ALL_PROVIDERS ? [] : [selectedProvider];
    return [
      ...selected,
      ...availableProviders.filter((provider) => provider !== selectedProvider),
    ].slice(0, VISIBLE_SOURCE_FILTERS);
  }, [availableProviders, selectedProvider]);

  const pickerProviders = useMemo(() => {
    const query = sourcePickerQuery.trim().toLowerCase();
    return query
      ? availableProviders.filter((provider) => provider.toLowerCase().includes(query))
      : availableProviders;
  }, [availableProviders, sourcePickerQuery]);

  const publisherCount = useMemo(
    () => new Set(filteredArticles.map((article) => article.source)).size,
    [filteredArticles],
  );

  const suggestedSources = useMemo(
    () => suggestNewsSources(
      preferences.topics,
      articles.map((article) => article.source),
      preferences.sources.rssFeeds,
    ),
    [articles, preferences.sources.rssFeeds, preferences.topics],
  );

  useEffect(() => {
    if (selectedProvider !== ALL_PROVIDERS && !availableProviders.includes(selectedProvider)) {
      setSelectedProvider(ALL_PROVIDERS);
    }
  }, [availableProviders, selectedProvider]);

  useEffect(() => {
    const updateBackToTopVisibility = () => {
      setBackToTopVisible(window.scrollY > 80);
    };

    updateBackToTopVisibility();
    window.addEventListener("scroll", updateBackToTopVisibility, { passive: true });
    return () => window.removeEventListener("scroll", updateBackToTopVisibility);
  }, []);

  useEffect(() => {
    let frame = 0;
    const updatePinnedFilters = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const filterStack = filterStackElement.current;
        if (!filterStack) return;
        const heroBottom = Math.max(0, heroElement.current?.getBoundingClientRect().bottom ?? 0);
        filterStack.style.setProperty("--filter-sticky-top", `${Math.round(heroBottom)}px`);
        const pinned = filterStack.getBoundingClientRect().top <= heroBottom + 1 && window.scrollY > 0;
        filterStack.classList.toggle("pinned", pinned);
      });
    };

    updatePinnedFilters();
    window.addEventListener("scroll", updatePinnedFilters, { passive: true });
    window.addEventListener("resize", updatePinnedFilters);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePinnedFilters);
    if (heroElement.current) observer?.observe(heroElement.current);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", updatePinnedFilters);
      window.removeEventListener("resize", updatePinnedFilters);
      observer?.disconnect();
      filterStackElement.current?.classList.remove("pinned");
    };
  }, [preferences.topics.length]);

  useEffect(() => {
    if (pendingPinnedTopicScroll.current?.toLowerCase() !== selectedTopic.toLowerCase()
        || filteredArticles.length === 0) return;

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const filterStack = filterStackElement.current;
        const storyList = storyListElement.current;
        if (!filterStack || !storyList) return;

        const filterBottom = filterStack.getBoundingClientRect().bottom;
        const storyTop = window.scrollY + storyList.getBoundingClientRect().top;
        pendingPinnedTopicScroll.current = null;
        window.scrollTo({
          // Stay just beyond the sticky threshold so the filters remain pinned
          // while the first story aligns directly beneath them.
          top: Math.max(0, storyTop - filterBottom + 2),
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [filteredArticles.length, selectedTopic]);

  useEffect(() => {
    if (!readerArticle) return;
    const scrollPosition = window.scrollY;
    const previousRootOverflow = document.documentElement.style.overflow;
    const previousOverflow = document.body.style.overflow;
    const previousPosition = document.body.style.position;
    const previousTop = document.body.style.top;
    const previousWidth = document.body.style.width;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.width = "100%";
    const focusFrame = window.requestAnimationFrame(() => readerCloseButton.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeArticleReader();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      document.documentElement.style.overflow = previousRootOverflow;
      document.body.style.overflow = previousOverflow;
      document.body.style.position = previousPosition;
      document.body.style.top = previousTop;
      document.body.style.width = previousWidth;
      window.scrollTo(0, scrollPosition);
    };
  }, [readerArticle]);

  function addTopic(value: string) {
    const topic = value.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!topic) return false;
    const existing = preferences.topics.find((followed) => followed.toLowerCase() === topic.toLowerCase());
    if (existing) {
      setSelectedTopic(existing);
      promoteTopicFilter(existing);
      setNotice(`You already follow ${existing}.`);
      return false;
    }
    setPreferences((current) => ({ ...current, topics: [...current.topics, topic] }));
    setSelectedTopic(topic);
    promoteTopicFilter(topic);
    setNotice(`Now following ${topic}.`);
    return true;
  }

  function submitTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addTopic(topicInput);
    setTopicInput("");
  }

  function removeTopic(topic: string) {
    setPreferences((current) => ({
      ...current,
      topics: current.topics.filter((followed) => followed !== topic),
      tickerOverrides: Object.fromEntries(
        Object.entries(current.tickerOverrides)
          .filter(([followed]) => followed.toLowerCase() !== topic.toLowerCase()),
      ),
    }));
    setRecentTopicFilters((current) => current.filter((followed) => followed.toLowerCase() !== topic.toLowerCase()));
    if (selectedTopic === topic) setSelectedTopic(ALL_TOPICS);
  }

  function unfollowSelectedTopic() {
    if (selectedTopic === ALL_TOPICS) return;
    const topic = selectedTopic;
    removeTopic(topic);
    setNotice(`Unfollowed ${topic}. Its saved history remains available.`);
  }

  function openTickerEditor() {
    if (selectedTopic === ALL_TOPICS) return;
    setTickerInput(selectedTickerOverride || (
      marketQuote?.topic.toLowerCase() === selectedTopic.toLowerCase() ? marketQuote.symbol : ""
    ));
    setTickerValidationMessage("");
    setTickerEditorOpen(true);
  }

  function closeTickerEditor() {
    if (tickerValidating) return;
    setTickerEditorOpen(false);
    setTickerValidationMessage("");
  }

  async function saveTickerOverride(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedTopic === ALL_TOPICS || tickerValidating) return;
    const symbol = tickerInput.trim().replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(symbol)) {
      setTickerValidationMessage("Use 1–15 letters, numbers, dots or hyphens.");
      return;
    }

    setTickerValidating(true);
    setTickerValidationMessage(`Checking ${symbol}…`);
    try {
      const params = new URLSearchParams({ topic: selectedTopic, symbol });
      const response = await fetch(`/api/market?${params.toString()}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json() as {
        matched?: boolean;
        quote?: MarketQuote;
        error?: string;
      };
      if (!response.ok || !data.matched || !data.quote) {
        throw new Error(data.error || "That ticker could not be verified.");
      }

      setPreferences((current) => ({
        ...current,
        tickerOverrides: {
          ...Object.fromEntries(
            Object.entries(current.tickerOverrides)
              .filter(([topic]) => topic.toLowerCase() !== selectedTopic.toLowerCase()),
          ),
          [selectedTopic]: symbol,
        },
      }));
      setMarketQuote(data.quote);
      setMarketNotice(null);
      setTickerEditorOpen(false);
      setTickerValidationMessage("");
      setNotice(`${symbol} is now the saved stock ticker for ${selectedTopic}.`);
    } catch (caught) {
      setTickerValidationMessage(caught instanceof Error ? caught.message : "That ticker could not be verified.");
    } finally {
      setTickerValidating(false);
    }
  }

  function clearTickerOverride() {
    if (selectedTopic === ALL_TOPICS || !selectedTickerOverride || tickerValidating) return;
    const clearedSymbol = selectedTickerOverride;
    setPreferences((current) => ({
      ...current,
      tickerOverrides: Object.fromEntries(
        Object.entries(current.tickerOverrides)
          .filter(([topic]) => topic.toLowerCase() !== selectedTopic.toLowerCase()),
      ),
    }));
    setTickerEditorOpen(false);
    setTickerValidationMessage("");
    setNotice(`Cleared ${clearedSymbol}. Signal will match ${selectedTopic} automatically.`);
  }

  function promoteTopicFilter(topic: string) {
    if (topic === ALL_TOPICS) return;
    setRecentTopicFilters((current) => [
      topic,
      ...current.filter((followed) => followed.toLowerCase() !== topic.toLowerCase()),
    ]);
  }

  async function addRssFeed(feed: string, displayName = feedName(feed)) {
    try {
      setRssMessage("");
      const url = new URL(feed.trim());
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
      const value = url.toString();
      const key = canonicalFeedKey(value);
      const existing = preferences.sources.rssFeeds.find((item) => canonicalFeedKey(item) === key);
      if (existing) {
        const message = `You already use ${feedName(value)}.`;
        setRssMessage(message);
        setNotice(message);
        return false;
      }
      if (preferences.sources.rssFeeds.length >= 20) {
        const message = "You can add up to 20 publisher feeds.";
        setRssMessage(message);
        setNotice(message);
        return false;
      }

      setRssResolvingFeed(value);
      setRssMessage(`Checking ${displayName}…`);
      if (preferencesStore?.resolveFeed) {
        const result = await preferencesStore.resolveFeed(value, preferences.sources.rssFeeds);
        setPreferences((current) => ({
          ...current,
          sources: { ...current.sources, rssFeeds: result.feeds },
        }));
        if (!result.added) {
          const message = `You already use ${feedName(result.duplicateOf ?? result.feed)}.`;
          setRssMessage(message);
          setNotice(message);
          return false;
        }
      } else {
        setPreferences((current) => ({
          ...current,
          sources: { ...current.sources, rssFeeds: [...current.sources.rssFeeds, value] },
        }));
      }
      const message = `${displayName} added to your news sources.`;
      setRssMessage(message);
      setNotice(message);
      return true;
    } catch (caught) {
      const message = caught instanceof Error && caught.message
        ? caught.message
        : "Enter a complete public HTTPS RSS or Atom feed URL.";
      setRssMessage(message);
      setNotice(message);
      return false;
    } finally {
      setRssResolvingFeed(null);
    }
  }

  function submitRssFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void addRssFeed(rssInput).then((added) => {
      if (added) setRssInput("");
    });
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

  function toggleTheme() {
    const currentTheme = theme ?? (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    const nextTheme: ColorTheme = currentTheme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    setTheme(nextTheme);
  }

  function changeFeedView(next: "latest" | "history" | "bookmarks") {
    setFeedView(next);
    setSelectedTopic(ALL_TOPICS);
    setSelectedProvider(ALL_PROVIDERS);
    setTopicPickerOpen(false);
    setTopicPickerQuery("");
    setSourcePickerOpen(false);
    setSourcePickerQuery("");
    setSourcesExpanded(false);
    setHistorySearchInput("");
    setHistorySearch("");
    setHistoryError("");
    if (next !== "latest") void loadHistoryPage(next, "", 0);
  }

  function selectTopicFilter(topic: string) {
    if (topic !== selectedTopic && filterStackElement.current?.classList.contains("pinned")) {
      pendingPinnedTopicScroll.current = topic;
    }
    setSelectedTopic(topic);
    promoteTopicFilter(topic);
    setTopicPickerOpen(false);
    setTopicPickerQuery("");
    setSourcePickerOpen(false);
    setSourcePickerQuery("");
    if (feedView === "latest") {
      setSelectedProvider(ALL_PROVIDERS);
      if (refreshStore) {
        void loadNews(preferences, {
          quiet: true,
          topic: topic === ALL_TOPICS ? undefined : topic,
        });
      }
    } else {
      void loadHistoryPage(feedView, historySearch, 0, topic, selectedProvider);
    }
  }

  function selectProviderFilter(provider: string) {
    setSelectedProvider(provider);
    setSourcePickerOpen(false);
    setSourcePickerQuery("");
    if (feedView !== "latest") {
      void loadHistoryPage(feedView, historySearch, 0, selectedTopic, provider);
    }
  }

  function submitHistorySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (feedView === "latest") return;
    const search = historySearchInput.trim().replace(/\s+/g, " ").slice(0, 100);
    setHistorySearch(search);
    void loadHistoryPage(feedView, search, 0, selectedTopic, selectedProvider);
  }

  function clearHistorySearch() {
    if (feedView === "latest") return;
    setHistorySearchInput("");
    setHistorySearch("");
    void loadHistoryPage(feedView, "", 0, selectedTopic, selectedProvider);
  }

  function clearHistoryFiltersAndSearch() {
    if (feedView === "latest") return;
    setSelectedTopic(ALL_TOPICS);
    setSelectedProvider(ALL_PROVIDERS);
    setTopicPickerOpen(false);
    setTopicPickerQuery("");
    setSourcePickerOpen(false);
    setSourcePickerQuery("");
    setHistorySearchInput("");
    setHistorySearch("");
    void loadHistoryPage(feedView, "", 0);
  }

  function openArticleReader(article: FollowedArticle, trigger: HTMLAnchorElement) {
    readerTrigger.current = trigger;
    markArticleRead(article);
    setReaderArticle(article);
    setReaderContent({ status: "loading" });
    const requestId = ++readerRequestSequence.current;
    const params = new URLSearchParams({ url: article.url });
    void fetch(`/api/article-reader?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as ArticleReaderResponse;
        if (requestId !== readerRequestSequence.current) return;
        if (data.available && data.article?.paragraphs.length) {
          setReaderContent({ status: "ready", article: data.article });
          return;
        }
        openOriginalAfterReaderFailure(article.url, requestId);
      })
      .catch(() => {
        if (requestId !== readerRequestSequence.current) return;
        openOriginalAfterReaderFailure(article.url, requestId);
      });
  }

  function markArticleRead(article: FollowedArticle) {
    if (article.isRead) return;
    const readAt = new Date().toISOString();
    setArticles((current) => current.map((item) => item.url === article.url
      ? { ...item, isRead: true }
      : item));
    setHistoryArticles((current) => current.map((item) => item.url === article.url
      ? { ...item, isRead: true, readAt }
      : item));
    if (articleStore) {
      void articleStore.setRead(article.url).catch(() => {
        setNotice("The story opened, but its read status could not be saved.");
      });
    }
  }

  function openOriginalAfterReaderFailure(url: string, requestId: number) {
    if (requestId !== readerRequestSequence.current) return;
    const opened = window.open(url, "_blank");
    if (opened) opened.opener = null;
    readerRequestSequence.current += 1;
    setReaderArticle(null);
    setReaderContent({ status: "idle" });
    if (!opened) window.location.assign(url);
  }

  function closeArticleReader() {
    readerRequestSequence.current += 1;
    setReaderArticle(null);
    setReaderContent({ status: "idle" });
    window.requestAnimationFrame(() => readerTrigger.current?.focus());
  }

  async function toggleBookmark(article: FollowedArticle) {
    if (!articleStore || bookmarkingUrls.has(article.url)) return;
    const bookmarked = !article.isBookmarked;
    setBookmarkingUrls((current) => new Set(current).add(article.url));
    try {
      await articleStore.setBookmark(article.url, bookmarked);
      setArticles((current) => current.map((item) => item.url === article.url
        ? { ...item, isBookmarked: bookmarked }
        : item));
      setHistoryArticles((current) => current.map((item) => item.url === article.url
        ? { ...item, isBookmarked: bookmarked, bookmarkedAt: bookmarked ? new Date().toISOString() : null }
        : item));
      setBookmarkTotal((current) => Math.max(0, current + (bookmarked ? 1 : -1)));
      if (feedView === "bookmarks") {
        setHistoryArticles((current) => current.filter((item) => item.url !== article.url || bookmarked));
        setHistoryMatchingTotal((current) => Math.max(0, current + (bookmarked ? 1 : -1)));
      }
      setNotice(bookmarked
        ? "Story bookmarked. It will be kept until you remove the bookmark."
        : "Bookmark removed. The normal history cleanup setting now applies.");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "That bookmark could not be updated.");
    } finally {
      setBookmarkingUrls((current) => {
        const next = new Set(current);
        next.delete(article.url);
        return next;
      });
    }
  }

  const feedTitle = feedView === "bookmarks"
    ? "Bookmarked stories"
    : feedView === "history"
      ? "Article history"
      : selectedTopic === ALL_TOPICS ? "All followed topics" : selectedTopic;
  const clockTimeZone = localWeather?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentTimeLabel = currentTime
    ? currentTime.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: clockTimeZone })
    : "--:--";
  const currentDateLabel = currentTime
    ? currentTime.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: clockTimeZone,
    })
    : "Local date";
  const readerOriginalUrl = readerContent.status === "ready"
    ? readerContent.article.finalUrl
    : readerArticle?.url ?? "";

  return (
    <main className="signal-dashboard" id="top">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Signal home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>SIGNAL</span>
        </a>
        <div className="header-actions">
          <div className="live-status"><span className="pulse" aria-hidden="true" />Live web briefing</div>
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            <span className="theme-toggle-icon" aria-hidden="true">{theme === "dark" ? "\u263E" : "\u2600"}</span>
            <span className="theme-toggle-label">{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Theme"}</span>
          </button>
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

      <section ref={heroElement} className={`hero${controlsHidden ? " controls-hidden" : ""}${heroCompact ? " compact" : ""}`} id="top">
        <div className="hero-copy">
          <p className="eyebrow">Your interests, continuously monitored</p>
          <h1>Stay current on<br />{" "}<em>what matters.</em></h1>
          <p className="lede">One focused briefing across multiple news networks and the publishers you trust.</p>
        </div>
        <aside className="hero-context" aria-label="Local date, time, and weather" aria-live="polite">
          <div className="hero-clock">
            <time className="hero-time" dateTime={currentTime?.toISOString()}>{currentTimeLabel}</time>
            <span className="hero-date">{currentDateLabel}</span>
          </div>
          {weatherStatus === "ready" && localWeather ? (
            <div className="local-weather">
              <span className="weather-glyph" aria-hidden="true">
                {weatherGlyph(localWeather.weatherCode, localWeather.isDay)}
              </span>
              <div className="weather-reading">
                <div>
                  <strong>{Math.round(localWeather.temperature)}°C</strong>
                  <span>{describeWeather(localWeather.weatherCode)}</span>
                </div>
                <small>
                  {timezonePlace(localWeather.timezone)}
                  <span aria-hidden="true"> · </span>
                  Feels {Math.round(localWeather.apparentTemperature)}°
                  <span aria-hidden="true"> · </span>
                  Humidity {Math.round(localWeather.humidity)}%
                  <span aria-hidden="true"> · </span>
                  Wind {Math.round(localWeather.windSpeed)} km/h
                </small>
              </div>
            </div>
          ) : weatherStatus === "locating" ? (
            <div className="weather-message">
              <span className="weather-locating" aria-hidden="true" />
              <span><strong>Finding local weather</strong><small>Allow location access when prompted</small></span>
            </div>
          ) : (
            <div className="weather-message">
              <span className="weather-glyph" aria-hidden="true">{"\u2316"}</span>
              <span>
                <strong>{weatherStatus === "denied" ? "Local weather is off" : "Weather unavailable"}</strong>
                <small>{weatherStatus === "denied" ? "Location access is needed" : "Your clock is still live"}</small>
              </span>
              {weatherStatus !== "unsupported" && (
                <button type="button" onClick={() => setWeatherRetryKey((value) => value + 1)}>
                  Try again
                </button>
              )}
            </div>
          )}
        </aside>
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
                <span><strong>Trending now</strong><small>Up to 5 per English + Mandarin-speaking region</small></span>
                <span className="trends-picker-action">{trendsOpen ? "Hide" : "Browse"}</span>
              </button>
              {trendsOpen && (
                <div className="trends-picker-content" id="google-trending-terms">
                  <div className="trends-picker-meta">
                    <span>{trendsFetchedAt ? `Updated ${formatAge(trendsFetchedAt)}` : "Google Trends"}</span>
                    <button type="button" onClick={() => void loadTrendingTerms()} disabled={trendsLoading}>Refresh</button>
                  </div>
                  <div className="trends-view-controls">
                    {trendsView === "bubbles" ? (
                      <span className="trend-size-key">
                        <span className="trend-size-dots" aria-hidden="true"><i /><i /></span>
                        Circle size = search traffic
                      </span>
                    ) : <span />}
                    <div role="group" aria-label="Choose Google Trends view">
                      <button
                        type="button"
                        className={trendsView === "bubbles" ? "active" : ""}
                        aria-pressed={trendsView === "bubbles"}
                        onClick={() => setTrendsView("bubbles")}
                      >
                        Bubbles
                      </button>
                      <button
                        type="button"
                        className={trendsView === "list" ? "active" : ""}
                        aria-pressed={trendsView === "list"}
                        onClick={() => setTrendsView("list")}
                      >
                        List
                      </button>
                    </div>
                  </div>
                  {trendsLoading && trendingTerms.length === 0 ? (
                    <p className="trends-message">Loading current searches...</p>
                  ) : trendsError ? (
                    <p className="trends-message error">{trendsError}</p>
                  ) : (
                    <div className={`trend-terms ${trendsView}`} aria-label="Current Google trending searches">
                      {displayedTrendingTerms.map((term) => {
                        const followed = preferences.topics.some((topic) => topic.toLowerCase() === term.keyword.toLowerCase());
                        return (
                          <button
                            type="button"
                            key={`${term.region}:${term.keyword}`}
                            disabled={followed}
                            onClick={() => addTopic(term.keyword)}
                            aria-label={`${followed ? "Already following" : "Follow"} ${term.keyword}${term.region ? ` from ${term.region}` : ""}${term.traffic ? `, ${term.traffic} searches` : ""}`}
                            style={trendsView === "bubbles"
                              ? ({ "--trend-size": `${trendBubbleSize(term.traffic, trendTrafficRange.minimum, trendTrafficRange.maximum)}rem` } as CSSProperties)
                              : undefined}
                          >
                            <span>{term.keyword}</span>
                            <small>{[term.region, term.traffic].filter(Boolean).join(" · ")}</small>
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
                  <li key={topic}>
                    <span className="followed-topic-copy">
                      <strong>{topic}</strong>
                      {refreshStore && (
                        <small
                          className={topicRefreshByKey.get(topic.toLowerCase())?.lastError ? "warning" : ""}
                          title={topicRefreshByKey.get(topic.toLowerCase())?.lastError || undefined}
                        >
                          {topicRefreshLabel(topicRefreshByKey.get(topic.toLowerCase()), preferences.refreshMinutes)}
                        </small>
                      )}
                    </span>
                    <button type="button" onClick={() => removeTopic(topic)} aria-label={`Stop following ${topic}`}>&#215;</button>
                  </li>
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

            {suggestedSources.length > 0 && (
              <div className="source-suggestions">
                <div className="source-suggestions-heading">
                  <strong>Suggested publishers</strong>
                  <span>Based on topics you follow</span>
                </div>
                <div className="source-suggestion-list">
                  {suggestedSources.map((source) => (
                    <button
                      type="button"
                      key={source.feed}
                      onClick={() => void addRssFeed(source.feed, source.name)}
                      disabled={rssResolving}
                      aria-label={`Add ${source.name} to news sources`}
                    >
                      <span>
                        <strong>{source.name}</strong>
                        <small>{rssResolvingFeed === source.feed ? `Checking ${source.name}…` : source.description}</small>
                      </span>
                      <b aria-hidden="true">{rssResolvingFeed === source.feed ? "…" : "+"}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {rssMessage && <p className="rss-feedback" role="status">{rssMessage}</p>}

            <form className="rss-form" onSubmit={submitRssFeed}>
              <label htmlFor="rss-feed">Add a publisher RSS or Atom feed</label>
              <div className="rss-input-wrap">
                 <input id="rss-feed" type="url" inputMode="url" value={rssInput} onChange={(event) => setRssInput(event.target.value)} placeholder="https://publisher.com/feed.xml" disabled={rssResolving} />
                 <button type="submit" disabled={rssResolving}>{rssResolving ? "Checking..." : "Add feed"}</button>
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
                {STORY_LIMIT_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div className="field compact-field">
              <label htmlFor="refresh-rate">Refresh</label>
              <select id="refresh-rate" value={preferences.refreshMinutes} onChange={(event) => setPreferences((current) => ({ ...current, refreshMinutes: Number(event.target.value) }))}>
                <option value={0}>Manual</option><option value={5}>Every 5 min</option><option value={15}>Every 15 min</option><option value={30}>Every 30 min</option><option value={60}>Every hour</option><option value={120}>Every 2 hours</option><option value={180}>Every 3 hours</option><option value={240}>Every 4 hours</option><option value={300}>Every 5 hours</option><option value={360}>Every 6 hours</option><option value={420}>Every 7 hours</option><option value={480}>Every 8 hours</option>
              </select>
              {refreshStore && <small className="refresh-setting-note">Each topic keeps its own saved schedule, even while Signal is closed.</small>}
            </div>
          </div>
          <div className="title-size-setting">
            <span>News title size</span>
            <div role="group" aria-label="Choose news title font size">
              {(["small", "medium", "large"] as StoryTitleSize[]).map((size) => (
                <button
                  type="button"
                  key={size}
                  className={preferences.storyTitleSize === size ? "active" : ""}
                  aria-pressed={preferences.storyTitleSize === size}
                  onClick={() => setPreferences((current) => ({ ...current, storyTitleSize: size }))}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>
          {articleStore && (
            <div className="history-retention-setting">
              <label htmlFor="article-retention">Delete unbookmarked stories after</label>
              <select
                id="article-retention"
                value={preferences.articleRetentionDays}
                onChange={(event) => setPreferences((current) => ({
                  ...current,
                  articleRetentionDays: Number(event.target.value),
                }))}
              >
                <option value={1}>1 day</option>
                <option value={7}>1 week</option>
                <option value={14}>2 weeks</option>
                <option value={30}>1 month</option>
                <option value={90}>3 months</option>
                <option value={180}>6 months</option>
                <option value={365}>1 year</option>
              </select>
              <small>Bookmarks are excluded from cleanup and stay saved until you remove them.</small>
            </div>
          )}
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

      <section className={`feed story-title-${preferences.storyTitleSize}`} aria-labelledby="feed-title">
        <div className="feed-heading">
          <div><p className="eyebrow">Latest signal</p><h2 id="feed-title">{feedTitle}</h2></div>
          <div className="feed-actions">
            <div className="feed-meta" aria-live="polite">
              {feedView === "latest"
                ? fetchedAt ? `${filteredArticles.length} stories / ${publisherCount} publishers / updated ${formatAge(fetchedAt)}` : preferences.topics.length > 0 && enabledSourceCount > 0 ? "Gathering recent coverage" : "Add a topic and source to begin"
                : historyLoading && historyArticles.length === 0
                  ? historySearch || selectedTopic !== ALL_TOPICS || selectedProvider !== ALL_PROVIDERS ? "Filtering saved stories" : "Loading saved stories"
                  : historySearch || selectedTopic !== ALL_TOPICS || selectedProvider !== ALL_PROVIDERS
                    ? `${filteredArticles.length} loaded / ${historyMatchingTotal} matching`
                    : feedView === "bookmarks"
                      ? `${filteredArticles.length} loaded / ${bookmarkTotal} bookmarked`
                      : `${filteredArticles.length} loaded / ${historyTotal} stored`}
            </div>
            <div className="feed-action-buttons">
              {selectedTopic !== ALL_TOPICS && (
                <button
                  type="button"
                  className={selectedTickerOverride ? "ticker-config-button active" : "ticker-config-button"}
                  onClick={openTickerEditor}
                  title={`Set the stock ticker for ${selectedTopic}`}
                >
                  <span aria-hidden="true">$</span>
                  {selectedTickerOverride || "Set ticker"}
                </button>
              )}
              {selectedTopic !== ALL_TOPICS && (
                <button
                  type="button"
                  className="unfollow-topic-button"
                  onClick={unfollowSelectedTopic}
                  title={`Unfollow ${selectedTopic}`}
                  aria-label={`Unfollow ${selectedTopic}`}
                >
                  <span aria-hidden="true">&#8722;</span> Unfollow <strong>{selectedTopic}</strong>
                </button>
              )}
              <button className="refresh-button" onClick={() => void loadNews(preferences, { emailSummary: true, forceRefresh: true })} disabled={loading || preferences.topics.length === 0 || enabledSourceCount === 0}><RefreshIcon spinning={loading} /> Refresh</button>
            </div>
          </div>
        </div>

        {tickerEditorOpen && selectedTopic !== ALL_TOPICS && (
          <form className="ticker-editor" onSubmit={saveTickerOverride}>
            <div className="ticker-editor-copy">
              <span>Stock ticker override</span>
              <strong>{selectedTopic}</strong>
              <small>Manual tickers take priority over Signal’s automatic company matching.</small>
            </div>
            <div className="ticker-editor-field">
              <label htmlFor="ticker-override">Ticker symbol</label>
              <input
                id="ticker-override"
                value={tickerInput}
                onChange={(event) => {
                  setTickerInput(event.target.value.toUpperCase().replace(/[^A-Z0-9.^$-]/g, "").slice(0, 16));
                  setTickerValidationMessage("");
                }}
                placeholder="e.g. SPCX"
                maxLength={16}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={tickerValidating}
              />
            </div>
            <div className="ticker-editor-actions">
              <button type="submit" disabled={tickerValidating}>
                {tickerValidating ? "Checking…" : "Verify & save"}
              </button>
              {selectedTickerOverride && (
                <button type="button" className="secondary" onClick={clearTickerOverride} disabled={tickerValidating}>
                  Clear override
                </button>
              )}
              <button type="button" className="secondary" onClick={closeTickerEditor} disabled={tickerValidating}>
                Cancel
              </button>
            </div>
            <p className={tickerValidationMessage && !tickerValidating ? "ticker-editor-message error" : "ticker-editor-message"} aria-live="polite">
              {tickerValidationMessage || "Signal verifies the latest quote before saving."}
            </p>
          </form>
        )}

        {marketQuote && marketQuote.topic.toLowerCase() === selectedTopic.toLowerCase() && (
          <section className="market-snapshot" aria-label={`Market price for ${marketQuote.name}`}>
            <div className="market-match">
              <span className="market-pulse" aria-hidden="true" />
              <div>
                <small>{selectedTickerOverride ? "Manual ticker" : "Market match"}</small>
                <strong>{marketQuote.symbol}</strong>
              </div>
            </div>
            <div className="market-company">
              <strong>{marketQuote.name}</strong>
              <span>{[marketQuote.exchange, marketQuote.currency].filter(Boolean).join(" / ")}</span>
            </div>
            <div className="market-price">
              <strong>{formatMarketPrice(marketQuote.price, marketQuote.currency)}</strong>
              <span className={marketQuote.change > 0 ? "positive" : marketQuote.change < 0 ? "negative" : "unchanged"}>
                {marketQuote.change > 0 ? "+" : ""}
                {marketQuote.change.toFixed(2)}
                <b aria-hidden="true"> / </b>
                {marketQuote.percentChange > 0 ? "+" : ""}
                {marketQuote.percentChange.toFixed(2)}%
              </span>
            </div>
            <p>
              {marketQuote.isMarketOpen === null
                ? "Latest available quote"
                : marketQuote.isMarketOpen ? "Market open" : "Market closed"}
              {marketQuote.quoteTime && <><span aria-hidden="true"> · </span>Quote {marketQuote.quoteTime}</>}
              <span aria-hidden="true"> · </span>{marketQuote.provider}
              <span aria-hidden="true"> · </span>For information only
            </p>
          </section>
        )}
        {marketNotice && marketNotice.topic.toLowerCase() === selectedTopic.toLowerCase() && (
          <section className="market-snapshot market-snapshot-unmatched" aria-label={`Market status for ${selectedTopic}`}>
            <div className="market-match">
              <span className="market-unmatched-mark" aria-hidden="true">?</span>
              <div>
                <small>Market status</small>
                <strong>No match</strong>
              </div>
            </div>
            <div className="market-company">
              <strong>{selectedTopic}</strong>
              <span>{marketNotice.message}</span>
            </div>
            <button type="button" className="market-set-ticker" onClick={openTickerEditor}>Set ticker</button>
          </section>
        )}

        {articleStore && (
          <nav className="history-tabs" aria-label="Choose latest, history, or bookmarked stories">
            <button type="button" className={feedView === "latest" ? "active" : ""} aria-pressed={feedView === "latest"} onClick={() => changeFeedView("latest")}>Latest <span>{articles.length}</span></button>
            <button type="button" className={feedView === "history" ? "active" : ""} aria-pressed={feedView === "history"} onClick={() => changeFeedView("history")}>History <span>{historyTotal}</span></button>
            <button type="button" className={feedView === "bookmarks" ? "active" : ""} aria-pressed={feedView === "bookmarks"} onClick={() => changeFeedView("bookmarks")}>Bookmarks <span>{bookmarkTotal}</span></button>
          </nav>
        )}

        {articleStore && feedView !== "latest" && (
          <form className="history-search" role="search" onSubmit={submitHistorySearch}>
            <label htmlFor="history-search">Search {feedView === "bookmarks" ? "bookmarks" : "history"}</label>
            <div>
              <input
                id="history-search"
                type="search"
                value={historySearchInput}
                onChange={(event) => setHistorySearchInput(event.target.value)}
                placeholder="Titles, summaries, publishers or topics"
                maxLength={100}
              />
              {historySearch && <button type="button" className="history-search-clear" onClick={clearHistorySearch}>Clear</button>}
              <button type="submit" disabled={historyLoading}>Search</button>
            </div>
          </form>
        )}

        {preferences.topics.length > 0 && (
          <div className="filter-stack" ref={filterStackElement}>
            <div className="filter-sticky-heading">
              <div className="filter-sticky-title">
                <span>{feedView === "latest" ? "Current topic" : feedView}</span>
                <strong>{selectedTopic === ALL_TOPICS ? feedTitle : selectedTopic}</strong>
              </div>
              <div className="filter-sticky-summary">
                {marketQuote && marketQuote.topic.toLowerCase() === selectedTopic.toLowerCase() && (
                  <span className="filter-sticky-market" aria-label={`${marketQuote.symbol} ${formatMarketPrice(marketQuote.price, marketQuote.currency)}, ${marketQuote.percentChange >= 0 ? "up" : "down"} ${Math.abs(marketQuote.percentChange).toFixed(2)} percent`}>
                    <b>{marketQuote.symbol}</b>
                    <strong>{formatMarketPrice(marketQuote.price, marketQuote.currency)}</strong>
                    <em className={marketQuote.percentChange > 0 ? "positive" : marketQuote.percentChange < 0 ? "negative" : "unchanged"}>
                      {marketQuote.percentChange > 0 ? "+" : ""}{marketQuote.percentChange.toFixed(2)}%
                    </em>
                  </span>
                )}
                {marketNotice && marketNotice.topic.toLowerCase() === selectedTopic.toLowerCase() && (
                  <button type="button" className="filter-sticky-market unresolved" title={marketNotice.message} onClick={openTickerEditor}>
                    <b>No stock match</b>
                    <strong>Set ticker</strong>
                  </button>
                )}
                <small>{filteredArticles.length} {filteredArticles.length === 1 ? "story" : "stories"}</small>
              </div>
            </div>
            <nav className="topic-filters" aria-label="Filter stories by followed topic">
              <span className="filter-label">Topics</span>
              <button type="button" className={selectedTopic === ALL_TOPICS ? "active" : ""} aria-pressed={selectedTopic === ALL_TOPICS} onClick={() => selectTopicFilter(ALL_TOPICS)}>All <span>{feedView === "latest" ? viewedArticles.length : historyFilterTotal}</span></button>
              {feedView === "latest" && (
                <button
                  type="button"
                  className="topic-next topic-next-unread"
                  disabled={!nextUnreadTopic}
                  onClick={() => nextUnreadTopic && selectTopicFilter(nextUnreadTopic)}
                  title={nextUnreadTopic
                    ? `Go to the next topic with unread stories: ${nextUnreadTopic}`
                    : selectedTopic === ALL_TOPICS ? "All topics are caught up" : "No other topic has unread stories"}
                >
                  {nextUnreadTopic
                    ? <>Next unread: <strong>{nextUnreadTopic}</strong> <span>{unreadTopicCounts[nextUnreadTopic]}</span></>
                    : selectedTopic === ALL_TOPICS ? "All caught up" : "No other unread"}
                </button>
              )}
              {visibleTopicFilters.map((topic) => (
                <button
                  type="button"
                  key={topic}
                  className={selectedTopic === topic ? "active" : ""}
                  aria-pressed={selectedTopic === topic}
                  aria-label={`${topic}, ${topicCounts[topic] ?? 0} stories${(unreadTopicCounts[topic] ?? 0) > 0 ? `, ${unreadTopicCounts[topic]} unread` : ""}`}
                  onClick={() => selectTopicFilter(topic)}
                >
                  {topic}
                  {(unreadTopicCounts[topic] ?? 0) > 0 && <i className="topic-unread-indicator" aria-hidden="true" />}
                  <span>{topicCounts[topic] ?? 0}</span>
                </button>
              ))}
              {preferences.topics.length > visibleTopicFilters.length && (
                <button
                  type="button"
                  className={topicPickerOpen ? "topic-more active" : "topic-more"}
                  aria-expanded={topicPickerOpen}
                  aria-controls="topic-filter-picker"
                  onClick={() => {
                    setSourcePickerOpen(false);
                    setSourcePickerQuery("");
                    setTopicPickerOpen((current) => !current);
                  }}
                >
                  More topics <span>{preferences.topics.length - visibleTopicFilters.length}</span>
                </button>
              )}
            </nav>
            {topicPickerOpen && (
              <div className="topic-filter-picker" id="topic-filter-picker">
                <div className="topic-filter-picker-heading">
                  <div><strong>Choose a topic</strong><span>{preferences.topics.length} followed</span></div>
                  <button type="button" onClick={() => setTopicPickerOpen(false)} aria-label="Close topic picker">&#215;</button>
                </div>
                <input
                  type="search"
                  value={topicPickerQuery}
                  onChange={(event) => setTopicPickerQuery(event.target.value)}
                  placeholder="Find a followed topic"
                  aria-label="Find a followed topic"
                />
                <div className="topic-filter-picker-grid">
                  {pickerTopics.map((topic) => (
                    <button
                      type="button"
                      key={topic}
                      className={selectedTopic === topic ? "active" : ""}
                      aria-pressed={selectedTopic === topic}
                      aria-label={`${topic}, ${topicCounts[topic] ?? 0} stories${(unreadTopicCounts[topic] ?? 0) > 0 ? `, ${unreadTopicCounts[topic]} unread` : ""}`}
                      onClick={() => selectTopicFilter(topic)}
                    >
                      <span>
                        {topic}
                        {(unreadTopicCounts[topic] ?? 0) > 0 && <i className="topic-unread-indicator" aria-hidden="true" />}
                      </span>
                      <b>{topicCounts[topic] ?? 0}</b>
                    </button>
                  ))}
                  {pickerTopics.length === 0 && <p>No followed topics match that search.</p>}
                </div>
              </div>
            )}
            {availableProviders.length > 0 && (
              <div className="source-filter-section">
                <button
                  type="button"
                  className="source-filters-toggle"
                  aria-expanded={sourcesExpanded}
                  aria-controls="source-filter-content"
                  onClick={() => {
                    if (sourcesExpanded) {
                      setSourcePickerOpen(false);
                      setSourcePickerQuery("");
                    }
                    setSourcesExpanded((current) => !current);
                  }}
                >
                  <span className="filter-label">Sources</span>
                  <span className="source-filter-summary">
                    <span>{selectedProvider === ALL_PROVIDERS ? "All sources" : selectedProvider}</span>
                    <b>{filteredArticles.length} {filteredArticles.length === 1 ? "story" : "stories"}</b>
                  </span>
                  <span className="source-filter-toggle-action">{sourcesExpanded ? "Hide" : "Change"} <b aria-hidden="true">{sourcesExpanded ? "\u2212" : "+"}</b></span>
                </button>
                {sourcesExpanded && (
                  <div id="source-filter-content">
                    <nav className="source-filters" aria-label="Filter stories by news source">
                      <button type="button" className={selectedProvider === ALL_PROVIDERS ? "active" : ""} aria-pressed={selectedProvider === ALL_PROVIDERS} onClick={() => selectProviderFilter(ALL_PROVIDERS)}>All sources <span>{feedView === "latest" ? topicFilteredArticles.length : historyFilterTotal}</span></button>
                      {visibleSourceFilters.map((provider) => (
                        <button type="button" key={provider} className={selectedProvider === provider ? "active" : ""} aria-pressed={selectedProvider === provider} onClick={() => selectProviderFilter(provider)}>{provider} <span>{providerCounts[provider] ?? 0}</span></button>
                      ))}
                      {availableProviders.length > VISIBLE_SOURCE_FILTERS && (
                        <button
                          type="button"
                          className={sourcePickerOpen ? "source-more active" : "source-more"}
                          aria-expanded={sourcePickerOpen}
                          aria-controls="source-filter-picker"
                          onClick={() => {
                            setTopicPickerOpen(false);
                            setTopicPickerQuery("");
                            setSourcePickerOpen((current) => !current);
                          }}
                        >
                          More sources <span>{availableProviders.length - visibleSourceFilters.length}</span>
                        </button>
                      )}
                    </nav>
                    {sourcePickerOpen && (
                      <div className="topic-filter-picker source-filter-picker" id="source-filter-picker">
                        <div className="topic-filter-picker-heading">
                          <div><strong>Choose a source</strong><span>{availableProviders.length} available</span></div>
                          <button type="button" onClick={() => setSourcePickerOpen(false)} aria-label="Close source picker">&#215;</button>
                        </div>
                        <input
                          type="search"
                          value={sourcePickerQuery}
                          onChange={(event) => setSourcePickerQuery(event.target.value)}
                          placeholder="Find a news source"
                          aria-label="Find a news source"
                        />
                        <div className="topic-filter-picker-grid">
                          {pickerProviders.map((provider) => (
                            <button
                              type="button"
                              key={provider}
                              className={selectedProvider === provider ? "active" : ""}
                              aria-pressed={selectedProvider === provider}
                              onClick={() => selectProviderFilter(provider)}
                            >
                              <span>{provider}</span><b>{providerCounts[provider] ?? 0}</b>
                            </button>
                          ))}
                          {pickerProviders.length === 0 && <p>No sources match that search.</p>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {notice && <p className="feed-notice" role="status">{notice}</p>}

        {feedView !== "latest" && historyError ? (
          <div className="message-card" role="alert"><p className="message-kicker">History unavailable</p><h3>We couldn&apos;t load your saved stories.</h3><p>{historyError}</p><button onClick={() => void loadHistoryPage(feedView, historySearch, 0, selectedTopic, selectedProvider)}>Try again</button></div>
        ) : feedView !== "latest" && historyLoading && historyArticles.length === 0 ? (
          <div className="loading-list" aria-label="Loading saved stories">{Array.from({ length: 4 }, (_, index) => <div className="loading-row" key={index} />)}</div>
        ) : feedView !== "latest" && filteredArticles.length === 0 ? (
          historySearch || selectedTopic !== ALL_TOPICS || selectedProvider !== ALL_PROVIDERS ? (
            <div className="message-card"><p className="message-kicker">No matches</p><h3>Try broader filters.</h3><p>No saved stories match the current search and filters. Search checks titles, summaries, publishers and topics.</p><button onClick={clearHistoryFiltersAndSearch}>Clear search and filters</button></div>
          ) : (
            <div className="message-card"><p className="message-kicker">Nothing saved here yet</p><h3>{feedView === "bookmarks" ? "Bookmark a story to keep it." : "Refresh your briefing to build history."}</h3><p>{feedView === "bookmarks" ? "Use the bookmark button beside any story. Bookmarks are never removed by automatic cleanup." : "Signal stores refreshed stories in your account and removes old unbookmarked items using your cleanup setting."}</p></div>
          )
        ) : preferences.topics.length === 0 && feedView === "latest" ? (
          <div className="message-card"><p className="message-kicker">Your briefing is empty</p><h3>Add a topic to begin.</h3><p>Your followed topics will appear here as filters, with everything combined under All.</p></div>
        ) : enabledSourceCount === 0 && feedView === "latest" ? (
          <div className="message-card"><p className="message-kicker">No sources selected</p><h3>Choose where Signal should look.</h3><p>Turn on Google News or GDELT, or add a publisher RSS feed.</p></div>
        ) : error && feedView === "latest" ? (
          <div className="message-card" role="alert"><p className="message-kicker">The signal dropped</p><h3>We couldn&apos;t gather the latest stories.</h3><p>{error}</p><button onClick={() => void loadNews(preferences, { emailSummary: true })}>Try again</button></div>
        ) : loading && articles.length === 0 && feedView === "latest" ? (
          <div className="loading-list" aria-label="Loading recent stories">{Array.from({ length: 4 }, (_, index) => <div className="loading-row" key={index} />)}</div>
        ) : filteredArticles.length === 0 ? (
          <div className="message-card"><p className="message-kicker">No coverage found</p><h3>Try a broader filter.</h3><p>Choose All sources or use a more general topic to widen the signal.</p></div>
        ) : (
          <>
            <ol className="story-list" ref={storyListElement}>
              {filteredArticles.map((article, index) => (
                <li key={article.url}>
                <a
                  href={article.url}
                  className="story-link"
                  onClick={(event) => {
                    event.preventDefault();
                    openArticleReader(article, event.currentTarget);
                  }}
                >
                  <span className="story-number">{String(index + 1).padStart(2, "0")}</span>
                  <article>
                    <div className="story-meta"><span className="story-topic">{article.topics.join(" + ")}</span><span className="story-provider">{article.providers.join(" + ")}</span><span>{article.source}</span><span>{formatAge(article.publishedAt)}</span></div>
                    <h3>{article.title}</h3>{article.summary && <p>{article.summary}</p>}
                  </article>
                  <ArrowIcon />
                </a>
                {articleStore && (
                  <button
                    type="button"
                    className={article.isBookmarked ? "bookmark-button active" : "bookmark-button"}
                    onClick={() => void toggleBookmark(article)}
                    disabled={bookmarkingUrls.has(article.url)}
                    aria-pressed={article.isBookmarked === true}
                    aria-label={article.isBookmarked ? `Remove bookmark from ${article.title}` : `Bookmark ${article.title}`}
                    title={article.isBookmarked ? "Remove bookmark" : "Keep forever"}
                  >
                    <span aria-hidden="true">{article.isBookmarked ? "\u2605" : "\u2606"}</span>
                  </button>
                )}
                </li>
              ))}
            </ol>
            {feedView !== "latest" && historyHasMore && (
              <div className="history-load-more">
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={() => void loadHistoryPage(feedView, historySearch, historyArticles.length, selectedTopic, selectedProvider)}
                >
                  {historyLoading ? "Loading…" : `Load ${Math.min(HISTORY_PAGE_SIZE, historyMatchingTotal - historyArticles.length)} more`}
                </button>
                <span>{historyArticles.length} of {historyMatchingTotal} loaded</span>
              </div>
            )}
          </>
        )}
      </section>
      </div>

      {readerArticle && (
        <div
          className="article-reader-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeArticleReader();
          }}
        >
          <section
            className="article-reader"
            role="dialog"
            aria-modal="true"
            aria-labelledby="article-reader-title"
          >
            <header className="article-reader-header">
              <div className="article-reader-toolbar">
                <span className="article-reader-kicker"><span className="pulse" /> Signal reader</span>
                <div className="article-reader-actions">
                  <a href={readerOriginalUrl} target="_blank" rel="noreferrer">
                    Open original <span aria-hidden="true">&#8599;</span>
                  </a>
                  <button
                    ref={readerCloseButton}
                    type="button"
                    onClick={closeArticleReader}
                    aria-label="Close article reader"
                  >
                    &#215;
                  </button>
                </div>
              </div>
              <div className="article-reader-meta">
                <span>{readerArticle.source}</span>
                <span>{formatAge(readerArticle.publishedAt)}</span>
              </div>
              <h2 id="article-reader-title">{readerArticle.title}</h2>
              <p>
                {readerContent.status === "loading"
                  ? "Preparing a clean reading view…"
                  : "Reader view prepared from the publisher’s public article."}
              </p>
            </header>
            <div className="article-reader-body">
              {readerContent.status === "loading" && (
                <div className="article-reader-state" role="status">
                  <span className="article-reader-loader" aria-hidden="true" />
                  <strong>Preparing article</strong>
                  <p>Signal is checking whether the publisher provides a readable version.</p>
                </div>
              )}
              {readerContent.status === "ready" && (
                <article className="article-reader-content">
                  {(readerContent.article.byline || readerContent.article.siteName) && (
                    <p className="article-reader-byline">
                      {[readerContent.article.byline, readerContent.article.siteName]
                        .filter(Boolean)
                        .join(" / ")}
                    </p>
                  )}
                  {readerContent.article.paragraphs.map((paragraph, index) => (
                    <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
                  ))}
                  <div className="article-reader-end">
                    <span>End of reader view</span>
                    <a href={readerOriginalUrl} target="_blank" rel="noreferrer">View original article &#8599;</a>
                  </div>
                </article>
              )}
            </div>
          </section>
        </div>
      )}

      {backToTopVisible && (
        <a
          className="floating-back-to-top"
          href="#top"
          aria-label="Back to top"
          title="Back to top"
        >
          <span aria-hidden="true">&#8593;</span>
        </a>
      )}
      <footer><p><span className="footer-dot" /> SIGNAL gathers public reporting and sends you to the original publisher.</p></footer>
    </main>
  );
}
