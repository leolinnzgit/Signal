import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyBriefing,
  DEFAULT_BRIEFING_SCHEDULE,
  dispatchWakeUpBriefingNotification,
  formatLocalDateKey,
  formatScheduleTimeDisplay,
  loadBriefingSchedule,
  loadPriorityTopics,
  markScheduledBriefingTriggered,
  normalizePriorityTopics,
  parseScheduleTimeMinutes,
  savePriorityTopics,
  shouldTriggerScheduledBriefing,
  togglePriorityTopic,
  updateBriefingSchedule,
  WAKE_UP_NOTIFICATION_TAG,
} from "../app/daily-briefing.ts";
import {
  BrowserCacheStorageAudioStore,
  clearOfflineBriefingPack,
  computeBriefingPackId,
  formatAudioByteSize,
  loadAutoOfflineBriefingPref,
  loadOfflineBriefingAudio,
  loadOfflineBriefingPackMeta,
  OFFLINE_BRIEFING_AUDIO_URL,
  OFFLINE_BRIEFING_CACHE_NAME,
  saveAutoOfflineBriefingPref,
  saveOfflineBriefingPack,
} from "../app/daily-briefing-offline.ts";
import { saveOfflineArticleContent } from "../app/offline-prewarm.ts";
import { loadMarketWatchlist, sortWatchlistByMagnitude } from "../app/market-quote.ts";
import {
  briefingSpeechLocale,
  clearBriefingTranslationCache,
  loadBriefingLanguage,
  saveBriefingLanguage,
  translateDailyBriefing,
} from "../app/daily-briefing-translation.ts";
import {
  buildBriefingWatchParts,
  createHostedDailyBriefingShare,
  formatDailyBriefingDigestText,
  resolveBriefingWatchHandoffUrl,
  shareOrCopyDailyBriefingDigest,
} from "../app/daily-briefing-share.ts";
import {
  answerBriefingQuestionLocally,
  askDailyBriefing,
  buildSuggestedBriefingQuestions,
} from "../app/daily-briefing-qa.ts";

function createMemoryStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

function createMockCacheStorage() {
  const cachesMap = new Map();
  return {
    cachesMap,
    async open(name) {
      if (!cachesMap.has(name)) {
        const entries = new Map();
        cachesMap.set(name, {
          entries,
          async put(req, res) {
            const key = typeof req === "string" ? req : req.url;
            entries.set(key, res.clone());
          },
          async match(req) {
            const key = typeof req === "string" ? req : req.url;
            const found = entries.get(key);
            return found ? found.clone() : undefined;
          },
        });
      }
      return cachesMap.get(name);
    },
    async delete(name) {
      return cachesMap.delete(name);
    },
  };
}

function makeFakeWavBlob(extraBytes = 1600) {
  const buf = new Uint8Array(44 + extraBytes);
  const tag = (offset, str) => {
    for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
  };
  tag(0, "RIFF");
  tag(8, "WAVE");
  tag(12, "fmt ");
  tag(36, "data");
  return new Blob([buf], { type: "audio/wav" });
}

test("buildDailyBriefing sets morning greeting for morning hours", () => {
  const morning = new Date(2026, 10, 1, 8, 30);
  const result = buildDailyBriefing({ userTime: morning });
  assert.equal(result.greeting, "Good morning");
  assert.equal(result.edition, "morning");
  assert.match(result.spokenScript, /^Good morning\./);
  assert.match(result.spokenScript, /productive day ahead/);
});

test("buildDailyBriefing sets afternoon greeting for midday hours", () => {
  const afternoon = new Date(2026, 10, 1, 14, 0);
  const result = buildDailyBriefing({ userTime: afternoon });
  assert.equal(result.greeting, "Good afternoon");
  assert.equal(result.edition, "afternoon");
  assert.match(result.spokenScript, /^Good afternoon\./);
  assert.match(result.spokenScript, /remainder of the day/);
});

test("buildDailyBriefing sets evening greeting for night hours", () => {
  const evening = new Date(2026, 10, 1, 19, 45);
  const result = buildDailyBriefing({ userTime: evening });
  assert.equal(result.greeting, "Good evening");
  assert.equal(result.edition, "evening");
  assert.match(result.spokenScript, /^Good evening\./);
  assert.match(result.spokenScript, /Rest well and stay informed/);
});

test("buildDailyBriefing incorporates weather conditions and severe alerts", () => {
  const weather = {
    temperature: 18.6,
    apparentTemperature: 18.0,
    humidity: 70,
    weatherCode: 1, // Partly cloudy
    windSpeed: 14,
    isDay: true,
    timezone: "Pacific/Auckland",
    locationName: "Auckland",
    observedAt: "2026-11-01T08:00:00",
  };
  const forecast = [
    {
      date: "2026-11-01",
      weatherCode: 1,
      temperatureMax: 21.2,
      temperatureMin: 14.1,
      precipitationProbability: 35,
      windSpeed: 15,
    },
  ];
  const alerts = [
    {
      id: "alert-1",
      category: "Met",
      level: "Warning",
      source: "Metservice",
      headline: "Heavy Rain Warning for Auckland North",
      description: "Expect localized downpours",
      areaName: "Auckland",
    },
  ];

  const result = buildDailyBriefing({ weather, forecast, alerts });
  assert.ok(result.weatherGlance);
  assert.equal(result.weatherGlance.location, "Auckland");
  assert.equal(result.weatherGlance.temperature, 19);
  assert.equal(result.weatherGlance.condition, "Partly cloudy");
  assert.equal(result.weatherGlance.alertsCount, 1);
  assert.match(result.spokenScript, /In Auckland, it is currently 19 degrees Celsius and partly cloudy\./);
  assert.match(result.spokenScript, /Today expect a high of 21 and a low of 14 degrees\./);
  assert.match(result.spokenScript, /The chance of rain is 35 percent\./);
  assert.match(result.spokenScript, /Attention: severe weather alert in effect\. Heavy Rain Warning for Auckland North\./);
});

test("buildDailyBriefing incorporates market quote narrative", () => {
  const quote = {
    topic: "S&P 500",
    symbol: "SPX",
    name: "S&P 500 Index",
    exchange: "INDEX",
    currency: "USD",
    price: 5864.67,
    change: 24.3,
    percentChange: 0.42,
    quoteTime: "4:00 PM EST",
    isMarketOpen: false,
    provider: "Financial Modeling Prep",
  };

  const result = buildDailyBriefing({ marketQuote: quote });
  assert.ok(result.marketGlance);
  assert.equal(result.marketGlance.symbol, "SPX");
  assert.equal(result.marketGlance.isPositive, true);
  assert.match(result.spokenScript, /In financial markets, S&P 500 Index is trading at 5864\.67 USD, up 0\.42 percent\./);
});

test("buildDailyBriefing selects unread stories first and narrates lead headlines", () => {
  const articles = [
    {
      title: "Already Read Article",
      url: "https://example.com/read",
      source: "TechCrunch",
      publishedAt: "2026-11-01T07:00:00Z",
      summary: "This was already seen by user.",
      isRead: true,
    },
    {
      title: "New AI Breakthrough in Robotics",
      url: "https://example.com/ai-robotics",
      source: "Reuters",
      publishedAt: "2026-11-01T08:00:00Z",
      summary: "Researchers announced a new multimodal humanoid architecture. The system improves agility.",
      isRead: false,
    },
    {
      title: "Clean Energy Grid Expansion Approved",
      url: "https://example.com/grid",
      source: "Bloomberg",
      publishedAt: "2026-11-01T08:15:00Z",
      summary: "State regulators gave unanimous approval today.",
      isRead: false,
    },
  ];

  const result = buildDailyBriefing({ articles, maxLeadStories: 2 });
  assert.equal(result.unreadCount, 2);
  assert.equal(result.leadStories.length, 2);
  assert.equal(result.leadStories[0].title, "New AI Breakthrough in Robotics");
  assert.equal(result.leadStories[1].title, "Clean Energy Grid Expansion Approved");
  assert.match(result.spokenScript, /Here are your lead stories today\./);
  assert.match(result.spokenScript, /First, from Reuters: New AI Breakthrough in Robotics\. Researchers announced a new multimodal humanoid architecture\./);
  assert.match(result.spokenScript, /Next, from Bloomberg: Clean Energy Grid Expansion Approved\. State regulators gave unanimous approval today\./);
});

test("priority topic helpers normalize, persist, and toggle favorite highlight topics", () => {
  const storage = createMemoryStorage();
  assert.deepEqual(normalizePriorityTopics(["  AI ", "Clean Energy", "ai", "", 42]), [
    "AI",
    "Clean Energy",
  ]);

  savePriorityTopics(["NZ Economy", "AI"], storage);
  assert.deepEqual(loadPriorityTopics(storage), ["NZ Economy", "AI"]);

  const afterRemove = togglePriorityTopic(loadPriorityTopics(storage), "nz economy");
  assert.deepEqual(afterRemove, ["AI"]);

  const afterAdd = togglePriorityTopic(afterRemove, "Clean Energy");
  assert.deepEqual(afterAdd, ["AI", "Clean Energy"]);
});

test("buildDailyBriefing prioritizes pinned highlight topics in rank order and calls them out in speech", () => {
  const articles = [
    {
      title: "Global Shipping Container Volumes Stabilize",
      url: "https://example.com/shipping",
      source: "Financial Times",
      summary: "Port congestion eased across major hubs.",
      topics: ["Logistics"],
      isRead: false,
    },
    {
      title: "AI Chips Set New Data Center Efficiency Record",
      url: "https://example.com/ai-chips",
      source: "Reuters",
      summary: "Next-generation accelerators cut power draw by forty percent.",
      topics: ["Semiconductors"],
      isRead: false,
    },
    {
      title: "Offshore Wind and Clean Energy Storage Surge",
      url: "https://example.com/clean-energy",
      source: "Bloomberg",
      summary: "Grid-scale battery installations doubled this quarter.",
      topics: ["Clean Energy"],
      isRead: false,
    },
    {
      title: "Already Read Clean Energy Report",
      url: "https://example.com/read-energy",
      source: "RNZ",
      summary: "Earlier solar update.",
      topics: ["Clean Energy"],
      isRead: true,
    },
  ];

  const result = buildDailyBriefing({
    articles,
    priorityTopics: ["Clean Energy", "AI"],
    maxLeadStories: 3,
  });

  assert.deepEqual(result.priorityTopics, ["Clean Energy", "AI"]);
  assert.equal(result.priorityMatchesCount, 2);
  assert.equal(result.leadStories.length, 3);
  // 1st: Unread Clean Energy (rank 0), 2nd: Unread AI (rank 1), 3rd: Unread General (ahead of read priority)
  assert.equal(result.leadStories[0].url, "https://example.com/clean-energy");
  assert.equal(result.leadStories[0].priorityTopic, "Clean Energy");
  assert.equal(result.leadStories[1].url, "https://example.com/ai-chips");
  assert.equal(result.leadStories[1].priorityTopic, "AI");
  assert.equal(result.leadStories[2].url, "https://example.com/shipping");
  assert.equal(result.leadStories[2].priorityTopic, undefined);

  assert.match(
    result.spokenScript,
    /Starting with your priority topic Clean Energy, from Bloomberg: Offshore Wind and Clean Energy Storage Surge\./,
  );
  assert.match(
    result.spokenScript,
    /Next, on your priority topic AI, from Reuters: AI Chips Set New Data Center Efficiency Record\./,
  );
  assert.match(
    result.spokenScript,
    /Also in the news, from Financial Times: Global Shipping Container Volumes Stabilize\./,
  );
});

test("Wake-up Briefing schedule parses times, evaluates catch-up windows, and prevents duplicate daily triggers", () => {
  const storage = createMemoryStorage();
  assert.equal(parseScheduleTimeMinutes("07:00"), 420);
  assert.equal(parseScheduleTimeMinutes("18:45"), 1125);
  assert.equal(parseScheduleTimeMinutes("25:00"), null);
  assert.equal(formatScheduleTimeDisplay("07:05"), "7:05 AM");
  assert.equal(formatScheduleTimeDisplay("18:30"), "6:30 PM");

  // Enabling 07:00 while it is already 09:30 schedules cleanly for tomorrow instead of surprise-firing
  const morning930 = new Date(2026, 10, 1, 9, 30);
  let sched = updateBriefingSchedule(
    DEFAULT_BRIEFING_SCHEDULE,
    { enabled: true, time: "07:00" },
    morning930,
    storage,
  );
  assert.equal(sched.lastTriggeredDate, formatLocalDateKey(morning930));
  assert.equal(shouldTriggerScheduledBriefing(sched, morning930), false);

  // Updating alarm to an upcoming time today (10:00 at 09:30) clears today's mark so it fires at 10:00
  sched = updateBriefingSchedule(sched, { time: "10:00" }, morning930, storage);
  assert.equal(sched.lastTriggeredDate, "");
  assert.equal(shouldTriggerScheduledBriefing(sched, morning930), false);

  const morning1005 = new Date(2026, 10, 1, 10, 5);
  assert.equal(shouldTriggerScheduledBriefing(sched, morning1005), true);

  // Once triggered today, does not re-trigger on the same day, then triggers next morning
  sched = markScheduledBriefingTriggered(sched, morning1005, storage);
  assert.equal(shouldTriggerScheduledBriefing(loadBriefingSchedule(storage), morning1005), false);

  const nextMorning = new Date(2026, 10, 2, 10, 15);
  assert.equal(shouldTriggerScheduledBriefing(loadBriefingSchedule(storage), nextMorning), true);
});

test("dispatchWakeUpBriefingNotification routes via service worker with ?briefing=1 launch URL and falls back cleanly", async () => {
  const briefing = buildDailyBriefing({
    userTime: new Date(2026, 10, 1, 7, 0),
    articles: [
      {
        title: "Morning Grid Update",
        url: "https://example.com/morning",
        source: "RNZ",
      },
    ],
  });

  const swCalls = [];
  const sent = await dispatchWakeUpBriefingNotification(briefing, {
    Notification: class FakeNotification {
      static permission = "granted";
    },
    serviceWorkerReady: Promise.resolve({
      async showNotification(title, options) {
        swCalls.push({ title, options });
      },
    }),
  });

  assert.equal(sent, true);
  assert.equal(swCalls.length, 1);
  assert.match(swCalls[0].title, /Good morning/);
  assert.match(swCalls[0].options.body, /Lead: Morning Grid Update/);
  assert.equal(swCalls[0].options.tag, WAKE_UP_NOTIFICATION_TAG);
  assert.deepEqual(swCalls[0].options.data, { url: "/?briefing=1" });

  // Denied permission never dispatches
  const denied = await dispatchWakeUpBriefingNotification(briefing, {
    Notification: class DeniedNotification {
      static permission = "denied";
    },
  });
  assert.equal(denied, false);
});

test("Offline Briefing Pack saves neural WAV audio in Cache Storage and prewarms lead stories", async () => {
  const storage = createMemoryStorage();
  const mockCaches = createMockCacheStorage();
  const audioStore = new BrowserCacheStorageAudioStore(mockCaches);

  // Pre-populate story 1 as already cached offline to verify deduplication
  saveOfflineArticleContent(
    "https://example.com/cached-story",
    {
      title: "Cached Commute Story",
      paragraphs: ["Paragraph one saved earlier."],
    },
    storage,
  );

  const briefing = buildDailyBriefing({
    userTime: new Date(2026, 10, 1, 7, 30),
    priorityTopics: ["AI"],
    articles: [
      {
        title: "Cached Commute Story",
        url: "https://example.com/cached-story",
        source: "Reuters",
        summary: "Already in offline cache.",
        topics: ["AI"],
      },
      {
        title: "Fresh Commute Story",
        url: "https://example.com/fresh-story",
        source: "Bloomberg",
        summary: "Needs reader extraction prewarm.",
      },
    ],
  });

  const fakeWav = makeFakeWavBlob(3200);
  const prewarmCalls = [];
  const progressEvents = [];

  const meta = await saveOfflineBriefingPack({
    briefing,
    language: "en-NZ",
    storage,
    audioStore,
    prepareAudio: async (parts, seconds, lang, signal, fetcher, onProgress) => {
      assert.ok(parts.length >= 1);
      assert.equal(seconds, 3);
      assert.equal(lang, "en-NZ");
      onProgress?.(parts.length, parts.length);
      return { blob: fakeWav, starts: parts.map((_, idx) => idx * 2) };
    },
    prewarmStory: async (article) => {
      prewarmCalls.push(article.url);
      return { success: true, url: article.url, components: ["reader-content"] };
    },
    onProgress: (pct, stage) => {
      progressEvents.push({ pct, stage });
    },
  });

  assert.equal(meta.id, computeBriefingPackId(briefing, "en-NZ"));
  assert.equal(meta.hasNeuralAudio, true);
  assert.equal(meta.audioBytes, fakeWav.size);
  assert.equal(meta.prewarmedStoryCount, 2);
  // Story 1 was already cached, so only story 2 needed network prewarming
  assert.deepEqual(prewarmCalls, ["https://example.com/fresh-story"]);
  assert.equal(progressEvents.at(-1)?.pct, 100);
  assert.equal(formatAudioByteSize(fakeWav.size), "3 KB");

  // Verify Cache Storage holds the WAV response under signal-offline-briefing-v1
  assert.ok(mockCaches.cachesMap.has(OFFLINE_BRIEFING_CACHE_NAME));
  const cacheEntry = mockCaches.cachesMap.get(OFFLINE_BRIEFING_CACHE_NAME);
  assert.ok(cacheEntry.entries.has(OFFLINE_BRIEFING_AUDIO_URL));

  const loadedMeta = loadOfflineBriefingPackMeta(storage);
  assert.ok(loadedMeta);
  assert.equal(loadedMeta.id, meta.id);
  assert.equal(loadedMeta.briefing.leadStories[0].priorityTopic, "AI");

  const loadedAudio = await loadOfflineBriefingAudio(meta.id, audioStore);
  assert.ok(loadedAudio);
  assert.equal(loadedAudio.size, fakeWav.size);

  // Mismatched pack ID returns null rather than playing stale audio for a different script
  const mismatched = await loadOfflineBriefingAudio("briefing-deadbeef", audioStore);
  assert.equal(mismatched, null);

  // Auto-offline preference round-trips cleanly
  assert.equal(loadAutoOfflineBriefingPref(storage), false);
  saveAutoOfflineBriefingPref(true, storage);
  assert.equal(loadAutoOfflineBriefingPref(storage), true);

  // Clear removes both metadata and Cache Storage entry
  await clearOfflineBriefingPack(storage, audioStore);
  assert.equal(loadOfflineBriefingPackMeta(storage), null);
  assert.equal(await loadOfflineBriefingAudio(undefined, audioStore), null);
});

test("Offline Briefing Pack degrades gracefully to text + prewarmed stories if neural TTS fails", async () => {
  const storage = createMemoryStorage();
  const audioStore = new BrowserCacheStorageAudioStore(createMockCacheStorage());
  const briefing = buildDailyBriefing({
    articles: [
      {
        title: "Offline Fallback Story",
        url: "https://example.com/fallback",
        source: "RNZ",
      },
    ],
  });

  const meta = await saveOfflineBriefingPack({
    briefing,
    storage,
    audioStore,
    prepareAudio: async () => {
      throw new Error("TTS temporarily unreachable");
    },
    prewarmStory: async (article) => ({
      success: true,
      url: article.url,
      components: ["reader-content"],
    }),
  });

  assert.equal(meta.hasNeuralAudio, false);
  assert.equal(meta.audioBytes, 0);
  assert.equal(meta.prewarmedStoryCount, 1);
  assert.match(meta.audioWarning ?? "", /TTS temporarily unreachable/);
  assert.ok(loadOfflineBriefingPackMeta(storage));
});


test("Multi-Ticker Market Watchlist sorts by magnitude, forwards ticker overrides, and narrates top + secondary movers", async () => {
  const quotes = [
    {
      topic: "Apple",
      symbol: "AAPL",
      name: "Apple Inc",
      exchange: "NASDAQ",
      currency: "USD",
      price: 228.5,
      change: 0.91,
      percentChange: 0.4,
      quoteTime: "2026-11-01",
      isMarketOpen: true,
      provider: "Twelve Data",
    },
    {
      topic: "Custom Chips",
      symbol: "AVGO",
      name: "Broadcom Inc",
      exchange: "NASDAQ",
      currency: "USD",
      price: 172.1,
      change: -4.95,
      percentChange: -2.8,
      quoteTime: "2026-11-01",
      isMarketOpen: true,
      provider: "Twelve Data",
    },
    {
      topic: "NVIDIA",
      symbol: "NVDA",
      name: "NVIDIA Corp",
      exchange: "NASDAQ",
      currency: "USD",
      price: 138.6,
      change: 5.65,
      percentChange: 4.25,
      quoteTime: "2026-11-01",
      isMarketOpen: true,
      provider: "Twelve Data",
    },
  ];

  const sorted = sortWatchlistByMagnitude([...quotes, quotes[2]]);
  assert.deepEqual(
    sorted.map((q) => q.symbol),
    ["NVDA", "AVGO", "AAPL"],
  );

  let postedBody = null;
  const fakeFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-watchlist-123" }) };
    }
    assert.equal(url, "/api/market/watchlist");
    assert.equal(init.headers["X-XSRF-TOKEN"], "csrf-watchlist-123");
    postedBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ configured: true, quotes }),
    };
  };

  const watchlistRes = await loadMarketWatchlist(
    ["Apple", "Custom Chips", "NVIDIA"],
    { "custom chips": "AVGO" },
    undefined,
    fakeFetcher,
    5,
  );
  assert.equal(watchlistRes.configured, true);
  assert.equal(watchlistRes.quotes.length, 3);
  assert.equal(watchlistRes.quotes[0].symbol, "NVDA");
  assert.deepEqual(postedBody.items[1], { topic: "Custom Chips", symbol: "AVGO" });

  const briefing = buildDailyBriefing({
    userTime: new Date("2026-11-01T08:00:00"),
    marketWatchlist: watchlistRes.quotes,
  });

  assert.equal(briefing.marketGlance?.symbol, "NVDA");
  assert.equal(briefing.marketWatchlistGlance?.length, 3);
  assert.match(briefing.spokenScript, /top mover NVIDIA Corp is trading at 138\.60 USD, up 4\.25 percent/);
  assert.match(
    briefing.spokenScript,
    /Elsewhere on your watchlist, AVGO is down 2\.80 percent, and AAPL is up 0\.40 percent\./,
  );
});

test("Multilingual Executive Briefing persists language, resolves native speech locales, and translates & caches digest", async () => {
  clearBriefingTranslationCache();
  const storage = createMemoryStorage();
  assert.equal(loadBriefingLanguage(storage), "en");
  assert.equal(saveBriefingLanguage("ja-JP", storage), "ja");
  assert.equal(loadBriefingLanguage(storage), "ja");
  assert.equal(briefingSpeechLocale("ja"), "ja-JP");
  assert.equal(briefingSpeechLocale("zh-Hans"), "zh-CN");
  assert.equal(briefingSpeechLocale("es"), "es-ES");

  const englishBriefing = buildDailyBriefing({
    userTime: new Date("2026-11-01T08:00:00"),
    weather: {
      temperature: 19,
      apparentTemperature: 18,
      weatherCode: 2,
      windSpeed: 10,
      observedAt: "2026-11-01T08:00:00",
      locationName: "Auckland",
    },
    articles: [
      {
        title: "Quantum Breakthrough Announced",
        url: "https://example.com/quantum",
        source: "Reuters",
        summary: "Researchers unveiled a fault-tolerant logical qubit milestone.",
      },
    ],
  });

  let snippetCalls = 0;
  const translatorFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-tr-1" }) };
    }
    snippetCalls += 1;
    const { texts, language } = JSON.parse(init.body);
    assert.equal(language, "ja");
    return {
      ok: true,
      json: async () => ({
        available: true,
        language: "ja",
        translations: texts.map((t) => `[JA] ${t}`),
      }),
    };
  };

  const first = await translateDailyBriefing(englishBriefing, "ja", undefined, translatorFetcher);
  assert.equal(first.translated, true);
  assert.equal(first.language, "ja");
  assert.match(first.briefing.greeting, /^\[JA\] Good morning/);
  assert.match(first.briefing.weatherGlance?.condition ?? "", /^\[JA\] /);
  assert.match(first.briefing.leadStories[0].title, /^\[JA\] Quantum Breakthrough Announced/);
  assert.match(first.briefing.spokenScript, /^\[JA\] /);
  assert.equal(snippetCalls, 1);

  // Second request for the identical briefing + language hits in-memory cache with 0 network calls
  const second = await translateDailyBriefing(englishBriefing, "ja", undefined, translatorFetcher);
  assert.equal(second.translated, true);
  assert.equal(snippetCalls, 1);
});

test("Briefing Export, Hosted Share & Watch Handoff format executive text, publish /shared link, and validate public URLs", async () => {
  const briefing = buildDailyBriefing({
    userTime: new Date("2026-11-01T08:00:00"),
    weather: {
      temperature: 21,
      apparentTemperature: 20,
      weatherCode: 0,
      windSpeed: 8,
      observedAt: "2026-11-01T08:00:00",
      locationName: "Wellington",
    },
    marketWatchlist: [
      {
        topic: "NVIDIA",
        symbol: "NVDA",
        name: "NVIDIA Corp",
        exchange: "NASDAQ",
        currency: "USD",
        price: 138.6,
        change: 5.65,
        percentChange: 4.25,
        quoteTime: "2026-11-01",
        isMarketOpen: true,
        provider: "Twelve Data",
      },
    ],
    articles: [
      {
        title: "Localhost Story Should Not Be Used For Watch Handoff",
        url: "http://localhost:3000/internal",
        source: "Local",
      },
      {
        title: "Clean Energy Grid Expansion",
        url: "https://rnz.co.nz/clean-energy",
        source: "RNZ",
        summary: "National grid battery storage doubled this quarter.",
        priorityTopic: "Clean Energy",
      },
    ],
  });

  const digestText = formatDailyBriefingDigestText(briefing);
  assert.match(digestText, /Signal Executive Daily Briefing \(Morning\)/);
  assert.match(digestText, /Weather: 21°C/);
  assert.match(digestText, /Markets: NVDA \+4\.25%/);
  assert.match(digestText, /\[RNZ\] \[★ Clean Energy\] Clean Energy Grid Expansion/);

  let copiedValue = "";
  const copyOutcome = await shareOrCopyDailyBriefingDigest(briefing, {
    clipboard: {
      writeText: async (val) => {
        copiedValue = val;
      },
    },
  });
  assert.equal(copyOutcome, "copied");
  assert.equal(copiedValue, digestText);

  // Watch handoff skips http://localhost and picks the first public HTTPS story URL
  assert.equal(resolveBriefingWatchHandoffUrl(briefing), "https://rnz.co.nz/clean-energy");
  const watchParts = buildBriefingWatchParts(briefing);
  assert.ok(watchParts.length >= 1 && watchParts.every((p) => p.length > 0 && p.length <= 950));

  // Hosted share creates a /shared/<48-hex> link
  const fakeHex48 = "a1b2c3d4e5f6".repeat(4);
  const shareFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-share-1" }) };
    }
    assert.equal(url, "/api/article-shares");
    const body = JSON.parse(init.body);
    assert.match(body.url, /^https:\/\/signal\.news\/briefing\//);
    assert.equal(body.snapshot.language, "es");
    assert.ok(body.snapshot.paragraphs.length >= 3);
    return {
      ok: true,
      json: async () => ({
        path: `/shared/${fakeHex48}`,
        title: body.title,
        language: "es",
        summaryOnly: false,
      }),
    };
  };

  const hosted = await createHostedDailyBriefingShare(
    {
      briefing,
      packId: "briefing-abc123",
      language: "es-ES",
      origin: "https://signal.example.com",
    },
    shareFetcher,
  );
  assert.equal(hosted.url, `https://signal.example.com/shared/${fakeHex48}`);
});

test("Ask Today's Briefing Q&A supports suggested chips, cloud AI answers, and offline pack local Q&A fallback", async () => {
  const briefing = buildDailyBriefing({
    userTime: new Date("2026-11-01T08:00:00"),
    priorityTopics: ["Reserve Bank"],
    weather: {
      temperature: 17,
      apparentTemperature: 16,
      weatherCode: 61,
      windSpeed: 18,
      observedAt: "2026-11-01T08:00:00",
      locationName: "Christchurch",
    },
    forecast: [
      {
        date: "2026-11-01",
        weatherCode: 61,
        temperatureMax: 19,
        temperatureMin: 11,
        precipitationProbability: 80,
      },
    ],
    marketWatchlist: [
      {
        topic: "NVIDIA",
        symbol: "NVDA",
        name: "NVIDIA Corp",
        exchange: "NASDAQ",
        currency: "USD",
        price: 138.6,
        change: 5.65,
        percentChange: 4.25,
        quoteTime: "2026-11-01",
        isMarketOpen: true,
        provider: "Twelve Data",
      },
    ],
    articles: [
      {
        title: "Reserve Bank cuts Official Cash Rate to 4.25%",
        url: "https://rnz.co.nz/rbnz-ocr",
        source: "RNZ",
        summary: "Floating mortgage rates dropped within minutes of the announcement.",
        topics: ["Reserve Bank", "Interest rates"],
      },
      {
        title: "Rocket Lab launches Electron mission from Mahia",
        url: "https://stuff.co.nz/rocket-lab",
        source: "Stuff",
        summary: "Five commercial Earth-observation satellites reached orbit.",
        topics: ["Rocket Lab", "Space"],
      },
    ],
  });

  const suggestions = buildSuggestedBriefingQuestions(briefing);
  assert.equal(suggestions.length, 3);
  assert.match(suggestions[0], /Reserve Bank/);

  // 1. Offline local Q&A answers topic & weather questions with citations
  const offlineOcr = answerBriefingQuestionLocally(
    "What did the Reserve Bank decide on rates?",
    briefing,
  );
  assert.equal(offlineOcr.available, true);
  assert.equal(offlineOcr.mode, "offline-local");
  assert.equal(offlineOcr.citations[0].source, "RNZ");
  assert.match(offlineOcr.answer, /Reserve Bank cuts Official Cash Rate/);

  const offlineUmbrella = await askDailyBriefing({
    question: "Do I need an umbrella for the weather today?",
    briefing,
    isOnline: false,
  });
  assert.equal(offlineUmbrella.mode, "offline-local");
  assert.match(offlineUmbrella.answer, /80% chance of rain/);

  // 2. Cloud Q&A posts to /api/briefing-qa/ask and returns AI synthesized answer + citations
  const qaFetcher = async (url, init) => {
    if (url === "/api/auth/csrf") {
      return { ok: true, json: async () => ({ token: "csrf-qa-1" }) };
    }
    assert.equal(url, "/api/briefing-qa/ask");
    const payload = JSON.parse(init.body);
    assert.equal(payload.language, "fr");
    assert.ok(payload.marketContext.includes("NVDA"));
    return {
      ok: true,
      json: async () => ({
        available: true,
        answer: "La Banque de réserve a abaissé son taux directeur à 4,25 %.",
        mode: "azure-ai",
        citations: [
          {
            url: "https://rnz.co.nz/rbnz-ocr",
            title: "Reserve Bank cuts Official Cash Rate to 4.25%",
            source: "RNZ",
          },
        ],
        language: "fr",
      }),
    };
  };

  const cloudRes = await askDailyBriefing(
    {
      question: "Que fait la Banque de réserve ?",
      briefing,
      language: "fr-FR",
      isOnline: true,
    },
    undefined,
    qaFetcher,
  );
  assert.equal(cloudRes.available, true);
  assert.equal(cloudRes.mode, "azure-ai");
  assert.equal(cloudRes.language, "fr");
  assert.equal(cloudRes.citations.length, 1);
  assert.match(cloudRes.answer, /4,25 %/);
});
