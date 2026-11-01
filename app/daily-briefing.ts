import {
  describeWeather,
  type ClientWeatherAlert,
  type ClientWeatherConditions,
  type LocalWeather,
  type WeatherForecastDay,
} from "./weather-briefing.ts";
import {
  attributeMarketMoversToStories,
  formatMarketPrice,
  sortWatchlistByMagnitude,
  type MarketQuote,
} from "./market-quote.ts";
import type { EntityPulseSummary } from "./entity-pulse.ts";
import type { CatchUpDeltaSummary, SituationRadarSummary } from "./daily-briefing-radar.ts";
import { topicMatchesText } from "./api/news/topic-matching.ts";

export type DailyBriefingStory = {
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  summary?: string;
  matchedTopics?: string[];
  topics?: string[];
  isBookmarked?: boolean;
  isRead?: boolean;
  priorityTopic?: string;
};

export type DailyBriefingParams = {
  weather?: LocalWeather | null;
  forecast?: WeatherForecastDay[];
  alerts?: ClientWeatherAlert[];
  conditions?: ClientWeatherConditions | null;
  marketQuote?: MarketQuote | null;
  marketWatchlist?: readonly MarketQuote[];
  pulse?: EntityPulseSummary | null;
  articles?: DailyBriefingStory[];
  priorityTopics?: readonly string[];
  userTime?: Date;
  userEmail?: string;
  maxLeadStories?: number;
  situationRadar?: SituationRadarSummary | null;
  catchUpDelta?: CatchUpDeltaSummary | null;
};

export type DailyBriefingGlanceWeather = {
  location: string;
  temperature: number;
  apparentTemperature: number;
  condition: string;
  weatherCode: number;
  high?: number;
  low?: number;
  rainChance?: number;
  uvIndex?: number | null;
  uvCategory?: string;
  airQualityIndex?: number | null;
  airQualityCategory?: string;
  alertsCount: number;
  topAlertHeadline?: string;
};

export type DailyBriefingGlanceMarket = {
  topic: string;
  symbol: string;
  name: string;
  price: number;
  currency: string;
  formattedPrice: string;
  change: number;
  percentChange: number;
  isPositive: boolean;
  sparkline?: number[];
  catalystTitle?: string;
  catalystSource?: string;
  catalystUrl?: string;
};

export type DailyBriefingChapterKind =
  | "intro"
  | "situation"
  | "weather"
  | "catchup"
  | "markets"
  | "momentum"
  | "story"
  | "signoff";

export type DailyBriefingChapter = {
  id: string;
  kind: DailyBriefingChapterKind;
  label: string;
  icon: string;
  text: string;
  storyIndex?: number;
  storyUrl?: string;
};

export type DailyBriefingGlancePulse = {
  totalTracked: number;
  totalMentions: number;
  surgingCount: number;
  topSurgingTopic?: string;
  sentimentTone: string;
  sentimentToneLabel: string;
};

export type DailyBriefingData = {
  greeting: string;
  formattedDate: string;
  edition: "morning" | "afternoon" | "evening";
  weatherGlance?: DailyBriefingGlanceWeather;
  marketGlance?: DailyBriefingGlanceMarket;
  marketWatchlistGlance?: DailyBriefingGlanceMarket[];
  pulseGlance?: DailyBriefingGlancePulse;
  situationRadar?: SituationRadarSummary;
  catchUpDelta?: CatchUpDeltaSummary;
  leadStories: DailyBriefingStory[];
  unreadCount: number;
  priorityTopics: string[];
  priorityMatchesCount: number;
  chapters: DailyBriefingChapter[];
  spokenScript: string;
};

export type BriefingSchedulePrefs = {
  enabled: boolean;
  time: string; // "HH:MM" in 24-hour local time
  notify: boolean;
  deliverEmail: boolean;
  prewarmOfflinePack: boolean;
  autoContinueStories: boolean;
  lastTriggeredDate: string; // "YYYY-MM-DD" in local calendar time
};

export const DAILY_BRIEFING_PRIORITY_TOPICS_KEY = "signal:daily-briefing-priority-topics:v1";
export const DAILY_BRIEFING_SCHEDULE_KEY = "signal:daily-briefing-schedule:v1";
export const WAKE_UP_NOTIFICATION_TAG = "signal-daily-briefing";
export const MAX_PRIORITY_TOPICS = 8;

export const DEFAULT_BRIEFING_SCHEDULE: BriefingSchedulePrefs = {
  enabled: false,
  time: "07:00",
  notify: true,
  deliverEmail: false,
  prewarmOfflinePack: true,
  autoContinueStories: false,
  lastTriggeredDate: "",
};

function getSafeStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  if (typeof localStorage !== "undefined") return localStorage;
  return null;
}

/**
 * Normalizes, trims, and deduplicates priority highlight topics (case-insensitively),
 * preserving user casing and priority order up to MAX_PRIORITY_TOPICS.
 */
export function normalizePriorityTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(/\s+/g, " ").trim();
    if (!cleaned || cleaned.length > 80) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= MAX_PRIORITY_TOPICS) break;
  }
  return result;
}

export function loadPriorityTopics(storage?: Storage): string[] {
  try {
    const store = getSafeStorage(storage);
    if (!store) return [];
    const raw = store.getItem(DAILY_BRIEFING_PRIORITY_TOPICS_KEY);
    if (!raw) return [];
    return normalizePriorityTopics(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function savePriorityTopics(topics: readonly string[], storage?: Storage): string[] {
  const normalized = normalizePriorityTopics(topics);
  try {
    const store = getSafeStorage(storage);
    store?.setItem(DAILY_BRIEFING_PRIORITY_TOPICS_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore storage quota errors
  }
  return normalized;
}

export function togglePriorityTopic(current: readonly string[], topic: string): string[] {
  const cleaned = topic.replace(/\s+/g, " ").trim();
  if (!cleaned) return normalizePriorityTopics(current);
  const normalized = normalizePriorityTopics(current);
  const lower = cleaned.toLowerCase();
  if (normalized.some((item) => item.toLowerCase() === lower)) {
    return normalized.filter((item) => item.toLowerCase() !== lower);
  }
  return normalizePriorityTopics([...normalized, cleaned]);
}

/**
 * Matches an article against user-pinned priority topics in priority rank order.
 */
export function matchStoryPriorityTopic(
  story: DailyBriefingStory,
  priorityTopics: readonly string[],
): { topic: string; rank: number } | null {
  if (!priorityTopics.length) return null;
  const storyTags = [...(story.topics ?? []), ...(story.matchedTopics ?? [])]
    .map((t) => t.trim())
    .filter(Boolean);
  const searchable = `${story.title || ""} ${story.summary || ""}`;

  for (let rank = 0; rank < priorityTopics.length; rank++) {
    const priority = priorityTopics[rank];
    const lowerPriority = priority.toLowerCase();
    const tagMatch = storyTags.some(
      (tag) => tag.toLowerCase() === lowerPriority || topicMatchesText(tag, priority),
    );
    if (tagMatch || topicMatchesText(searchable, priority)) {
      return { topic: priority, rank };
    }
  }
  return null;
}

/**
 * Formats a Date into local calendar YYYY-MM-DD key.
 */
export function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses "HH:MM" into minutes since local midnight (0..1439), or null if invalid.
 */
export function parseScheduleTimeMinutes(time: string): number | null {
  if (typeof time !== "string") return null;
  const match = time.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

/**
 * Formats "HH:MM" into human-readable 12-hour clock label (e.g. "7:00 AM", "6:30 PM").
 */
export function formatScheduleTimeDisplay(time: string): string {
  const mins = parseScheduleTimeMinutes(time);
  if (mins === null) return "7:00 AM";
  const hours24 = Math.floor(mins / 60);
  const minutePart = String(mins % 60).padStart(2, "0");
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutePart} ${period}`;
}

export function normalizeBriefingSchedule(value: unknown): BriefingSchedulePrefs {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTime = typeof raw.time === "string" ? raw.time.trim() : DEFAULT_BRIEFING_SCHEDULE.time;
  const parsed = parseScheduleTimeMinutes(rawTime);
  const normalizedTime =
    parsed !== null
      ? `${String(Math.floor(parsed / 60)).padStart(2, "0")}:${String(parsed % 60).padStart(2, "0")}`
      : DEFAULT_BRIEFING_SCHEDULE.time;

  const lastTriggeredDate =
    typeof raw.lastTriggeredDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.lastTriggeredDate)
      ? raw.lastTriggeredDate
      : "";

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_BRIEFING_SCHEDULE.enabled,
    time: normalizedTime,
    notify: typeof raw.notify === "boolean" ? raw.notify : DEFAULT_BRIEFING_SCHEDULE.notify,
    deliverEmail:
      typeof raw.deliverEmail === "boolean"
        ? raw.deliverEmail
        : DEFAULT_BRIEFING_SCHEDULE.deliverEmail,
    prewarmOfflinePack:
      typeof raw.prewarmOfflinePack === "boolean"
        ? raw.prewarmOfflinePack
        : DEFAULT_BRIEFING_SCHEDULE.prewarmOfflinePack,
    autoContinueStories:
      typeof raw.autoContinueStories === "boolean"
        ? raw.autoContinueStories
        : DEFAULT_BRIEFING_SCHEDULE.autoContinueStories,
    lastTriggeredDate,
  };
}

export function loadBriefingSchedule(storage?: Storage): BriefingSchedulePrefs {
  try {
    const store = getSafeStorage(storage);
    if (!store) return { ...DEFAULT_BRIEFING_SCHEDULE };
    const raw = store.getItem(DAILY_BRIEFING_SCHEDULE_KEY);
    if (!raw) return { ...DEFAULT_BRIEFING_SCHEDULE };
    return normalizeBriefingSchedule(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_BRIEFING_SCHEDULE };
  }
}

/**
 * Updates and persists Wake-up Briefing schedule preferences.
 * When enabling or changing the scheduled time:
 * - If the newly configured time has already passed earlier today, marks today as
 *   already elapsed so it cleanly schedules for tomorrow instead of surprise-firing immediately.
 * - If the newly configured time is still upcoming today, clears today's trigger mark
 *   so the user's new time will fire today.
 */
export function updateBriefingSchedule(
  previous: BriefingSchedulePrefs,
  patch: Partial<BriefingSchedulePrefs>,
  now: Date = new Date(),
  storage?: Storage,
): BriefingSchedulePrefs {
  const merged = normalizeBriefingSchedule({ ...previous, ...patch });
  const timeOrEnableChanged =
    (patch.time !== undefined && merged.time !== previous.time) ||
    (patch.enabled === true && !previous.enabled);

  if (timeOrEnableChanged && patch.lastTriggeredDate === undefined && merged.enabled) {
    const scheduledMins = parseScheduleTimeMinutes(merged.time);
    if (scheduledMins !== null) {
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const todayKey = formatLocalDateKey(now);
      if (scheduledMins < nowMins) {
        merged.lastTriggeredDate = todayKey;
      } else if (merged.lastTriggeredDate === todayKey) {
        merged.lastTriggeredDate = "";
      }
    }
  }

  try {
    const store = getSafeStorage(storage);
    store?.setItem(DAILY_BRIEFING_SCHEDULE_KEY, JSON.stringify(merged));
  } catch {
    // Ignore storage quota errors
  }
  return merged;
}

/**
 * Evaluates whether the scheduled Wake-up Briefing should trigger at `now`.
 * Fires at most once per calendar day within [scheduledTime, scheduledTime + catchUpMinutes].
 */
export function shouldTriggerScheduledBriefing(
  prefs: BriefingSchedulePrefs,
  now: Date = new Date(),
  catchUpMinutes = 360,
): boolean {
  if (!prefs.enabled) return false;
  const todayKey = formatLocalDateKey(now);
  if (prefs.lastTriggeredDate === todayKey) return false;
  const scheduledMins = parseScheduleTimeMinutes(prefs.time);
  if (scheduledMins === null) return false;
  const nowMins = now.getHours() * 60 + now.getMinutes();
  return nowMins >= scheduledMins && nowMins <= scheduledMins + Math.max(1, catchUpMinutes);
}

export function markScheduledBriefingTriggered(
  prefs: BriefingSchedulePrefs,
  now: Date = new Date(),
  storage?: Storage,
): BriefingSchedulePrefs {
  const updated: BriefingSchedulePrefs = {
    ...normalizeBriefingSchedule(prefs),
    lastTriggeredDate: formatLocalDateKey(now),
  };
  try {
    const store = getSafeStorage(storage);
    store?.setItem(DAILY_BRIEFING_SCHEDULE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

export async function dispatchWakeUpBriefingNotification(
  briefing: DailyBriefingData,
  env?: {
    Notification?: {
      permission: NotificationPermission;
      new (title: string, options?: NotificationOptions): unknown;
    };
    serviceWorkerReady?: Promise<{
      showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
    }>;
  },
): Promise<boolean> {
  const NotificationApi =
    env?.Notification ?? (typeof Notification !== "undefined" ? Notification : undefined);
  if (!NotificationApi || NotificationApi.permission !== "granted") {
    return false;
  }

  const title = `🗞️ ${briefing.greeting} — Signal Briefing Ready`;
  const leadHeadline = briefing.leadStories[0]?.title;
  const weatherPart = briefing.weatherGlance
    ? `${briefing.weatherGlance.temperature}°C ${briefing.weatherGlance.condition} in ${briefing.weatherGlance.location}. `
    : "";
  const body = leadHeadline
    ? `${weatherPart}Lead: ${leadHeadline}`
    : `${weatherPart}Your executive audio digest for ${briefing.formattedDate} is prewarmed and ready.`;

  const options: NotificationOptions = {
    body,
    icon: "/icons/signal-medallion-192.png",
    badge: "/icons/signal-notification-medallion-96.png",
    tag: WAKE_UP_NOTIFICATION_TAG,
    data: { url: "/?briefing=1" },
  };

  try {
    const swPromise =
      env?.serviceWorkerReady ??
      (typeof navigator !== "undefined" && navigator.serviceWorker
        ? navigator.serviceWorker.ready
        : undefined);
    if (swPromise) {
      const reg = await swPromise;
      if (reg && typeof reg.showNotification === "function") {
        await reg.showNotification(title, options);
        return true;
      }
    }
  } catch {
    // Fall back to direct Notification constructor
  }

  try {
    new NotificationApi(title, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strips HTML tags and collapses whitespace for clean speech synthesis.
 */
function cleanSpeechText(text: string): string {
  if (!text) return "";
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "and")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts the first sentence from a summary string for concise narration.
 */
function extractFirstSentence(summary?: string): string {
  if (!summary) return "";
  const cleaned = cleanSpeechText(summary);
  const match = cleaned.match(/^([^.!?]+[.!?])/);
  return match ? match[1].trim() : cleaned.slice(0, 160).trim();
}

/**
 * Generates an executive daily briefing combining local weather, market movers,
 * entity pulse momentum, personalized priority topic highlights, and lead news stories
 * into structured glances and a radio-ready neural spoken narration script.
 */
export function buildDailyBriefing(params: DailyBriefingParams = {}): DailyBriefingData {
  const {
    weather,
    forecast = [],
    alerts = [],
    conditions,
    marketQuote,
    marketWatchlist = [],
    pulse,
    articles = [],
    priorityTopics: rawPriorityTopics = [],
    userTime = new Date(),
    maxLeadStories = 4,
    situationRadar: rawSituationRadar = null,
    catchUpDelta: rawCatchUpDelta = null,
  } = params;

  const priorityTopics = normalizePriorityTopics(rawPriorityTopics);

  // 1. Time-of-day edition & greeting
  const hour = userTime.getHours();
  const edition: "morning" | "afternoon" | "evening" =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const greeting =
    edition === "morning"
      ? "Good morning"
      : edition === "afternoon"
        ? "Good afternoon"
        : "Good evening";

  const formattedDate = userTime.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const chapters: DailyBriefingChapter[] = [];
  chapters.push({
    id: "intro",
    kind: "intro",
    label: "Intro",
    icon: "🎙️",
    text: `${greeting}. Here is your Signal Executive Briefing for ${formattedDate}.`,
  });

  // 1b. Live Situation Radar (Quakes + GDACS Disasters) — highlighted when elevated/advisory
  const situationRadar =
    rawSituationRadar && rawSituationRadar.level !== "calm" && rawSituationRadar.items.length > 0
      ? rawSituationRadar
      : undefined;
  if (situationRadar?.spokenAlert) {
    chapters.push({
      id: "situation",
      kind: "situation",
      label: "Situation Radar",
      icon: "🚨",
      text: cleanSpeechText(situationRadar.spokenAlert),
    });
  }

  // 2. Weather Glance & Narration
  let weatherGlance: DailyBriefingGlanceWeather | undefined;
  if (weather) {
    const condition = describeWeather(weather.weatherCode);
    const location = weather.locationName || "your area";
    const temp = Math.round(weather.temperature);
    const apparent = Math.round(weather.apparentTemperature);

    const todayDatePrefix = weather.observedAt ? weather.observedAt.slice(0, 10) : "";
    const todayForecast =
      forecast.find((day) => day.date === todayDatePrefix) ?? (forecast.length > 0 ? forecast[0] : undefined);

    const activeAlertsCount = alerts.length;
    const topAlertHeadline = alerts.length > 0 ? cleanSpeechText(alerts[0].headline) : undefined;

    weatherGlance = {
      location,
      temperature: temp,
      apparentTemperature: apparent,
      condition,
      weatherCode: weather.weatherCode,
      high: todayForecast ? Math.round(todayForecast.temperatureMax) : undefined,
      low: todayForecast ? Math.round(todayForecast.temperatureMin) : undefined,
      rainChance: todayForecast ? Math.round(todayForecast.precipitationProbability) : undefined,
      uvIndex: conditions?.uvIndex,
      uvCategory: conditions?.uvCategory,
      airQualityIndex: conditions?.airQualityIndex,
      airQualityCategory: conditions?.airQualityCategory,
      alertsCount: activeAlertsCount,
      topAlertHeadline,
    };

    let weatherLine = `In ${location}, it is currently ${temp} degrees Celsius and ${condition.toLowerCase()}.`;
    if (weatherGlance.high !== undefined && weatherGlance.low !== undefined) {
      weatherLine += ` Today expect a high of ${weatherGlance.high} and a low of ${weatherGlance.low} degrees.`;
    }
    if (weatherGlance.rainChance !== undefined && weatherGlance.rainChance > 20) {
      weatherLine += ` The chance of rain is ${weatherGlance.rainChance} percent.`;
    }
    if (activeAlertsCount > 0 && topAlertHeadline) {
      weatherLine += ` Attention: severe weather alert in effect. ${topAlertHeadline}.`;
    }
    chapters.push({
      id: "weather",
      kind: "weather",
      label: "Weather",
      icon: "⛅",
      text: weatherLine,
    });
  }

  // 2b. "Since Your Last Visit" Catch-Up Delta
  const catchUpDelta =
    rawCatchUpDelta && rawCatchUpDelta.hasChanges ? rawCatchUpDelta : undefined;
  if (catchUpDelta?.spokenCatchUp) {
    chapters.push({
      id: "catchup",
      kind: "catchup",
      label: "Catch-Up",
      icon: "⏱️",
      text: cleanSpeechText(catchUpDelta.spokenCatchUp),
    });
  }

  // 3. Market Movers Glance & Narration (Single Quote + Multi-Ticker Watchlist + Sparklines + Catalyst Attribution)
  let marketGlance: DailyBriefingGlanceMarket | undefined;
  let marketWatchlistGlance: DailyBriefingGlanceMarket[] | undefined;

  const combinedMarketQuotes = sortWatchlistByMagnitude([
    ...marketWatchlist,
    ...(marketQuote ? [marketQuote] : []),
  ]).slice(0, 5);

  if (combinedMarketQuotes.length > 0) {
    const catalysts = attributeMarketMoversToStories(combinedMarketQuotes, articles, 1.0);
    marketWatchlistGlance = combinedMarketQuotes.map((quote) => {
      const symUpper = (quote.symbol || "").trim().toUpperCase();
      const catalyst = catalysts[symUpper];
      return {
        topic: quote.topic,
        symbol: quote.symbol,
        name: quote.name || quote.symbol,
        price: quote.price,
        currency: quote.currency,
        formattedPrice: formatMarketPrice(quote.price, quote.currency),
        change: quote.change,
        percentChange: quote.percentChange,
        isPositive: quote.percentChange >= 0,
        sparkline: Array.isArray(quote.sparkline) ? quote.sparkline : undefined,
        catalystTitle: catalyst?.story.title,
        catalystSource: catalyst?.story.source,
        catalystUrl: catalyst?.story.url,
      };
    });

    marketGlance = marketWatchlistGlance[0];
    const leadQuote = combinedMarketQuotes[0];
    const direction =
      leadQuote.percentChange > 0 ? "up" : leadQuote.percentChange < 0 ? "down" : "unchanged at";
    const absPercent = Math.abs(leadQuote.percentChange).toFixed(2);
    const marketName = leadQuote.name || leadQuote.symbol;
    const marketCurrency = leadQuote.currency ? ` ${leadQuote.currency}` : "";

    let marketLine: string;
    if (marketWatchlistGlance.length === 1) {
      marketLine = `In financial markets, ${marketName} is trading at ${leadQuote.price.toFixed(2)}${marketCurrency}, ${direction} ${absPercent} percent.`;
    } else {
      marketLine = `In financial markets, top mover ${marketName} is trading at ${leadQuote.price.toFixed(2)}${marketCurrency}, ${direction} ${absPercent} percent.`;
      const secondaryMovers = marketWatchlistGlance.slice(1, 3).map((item) => {
        const dir = item.percentChange > 0 ? "up" : item.percentChange < 0 ? "down" : "unchanged at";
        return `${item.symbol} is ${dir} ${Math.abs(item.percentChange).toFixed(2)} percent`;
      });
      if (secondaryMovers.length > 0) {
        marketLine += ` Elsewhere on your watchlist, ${secondaryMovers.join(", and ")}.`;
      }
    }
    chapters.push({
      id: "markets",
      kind: "markets",
      label: "Markets",
      icon: "📈",
      text: marketLine,
    });
  }

  // 4. Entity Pulse Momentum Glance & Narration
  let pulseGlance: DailyBriefingGlancePulse | undefined;
  if (pulse && pulse.totalTracked > 0) {
    const topSurging = pulse.topSurging?.topic;
    const toneLabel = pulse.overallSentiment?.toneLabel || "Steady tone";

    pulseGlance = {
      totalTracked: pulse.totalTracked,
      totalMentions: pulse.totalMentionsThisWeek,
      surgingCount: pulse.surgingCount,
      topSurgingTopic: topSurging,
      sentimentTone: pulse.overallSentiment?.dominantTone || "neutral",
      sentimentToneLabel: toneLabel,
    };

    if (topSurging && (pulse.surgingCount > 0 || (pulse.topSurging?.stats.totalMentions ?? 0) > 0)) {
      const mentions = pulse.topSurging?.stats.totalMentions ?? 0;
      chapters.push({
        id: "momentum",
        kind: "momentum",
        label: "Momentum",
        icon: "⚡",
        text: `In topic momentum, top surging entity is ${topSurging} with ${mentions} mentions this week across your ${pulse.totalTracked} tracked topics.`,
      });
    } else if (pulse.totalMentionsThisWeek > 0) {
      chapters.push({
        id: "momentum",
        kind: "momentum",
        label: "Momentum",
        icon: "⚡",
        text: `In topic momentum, you have ${pulse.totalMentionsThisWeek} mentions this week across ${pulse.totalTracked} tracked topics.`,
      });
    }
  }

  // 5. Lead Stories with Personalized Priority Topic Highlights
  const seenUrls = new Set<string>();
  type RankedStory = {
    story: DailyBriefingStory;
    index: number;
    priorityRank: number | null;
  };
  const rankedArticles: RankedStory[] = [];
  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    if (seenUrls.has(art.url)) continue;
    seenUrls.add(art.url);
    const match = matchStoryPriorityTopic(art, priorityTopics);
    rankedArticles.push({
      story: match ? { ...art, priorityTopic: match.topic } : { ...art },
      index: i,
      priorityRank: match ? match.rank : null,
    });
  }

  const unreadCount = rankedArticles.filter((r) => !r.story.isRead).length;

  // Tier ordering:
  // 0: Unread + Priority (ordered by priorityRank, then feed order)
  // 1: Unread + General (feed order)
  // 2: Read + Priority (ordered by priorityRank, then feed order)
  // 3: Read + General (feed order)
  const sortedForBriefing = [...rankedArticles].sort((a, b) => {
    const tierA = (a.story.isRead ? 2 : 0) + (a.priorityRank !== null ? 0 : 1);
    const tierB = (b.story.isRead ? 2 : 0) + (b.priorityRank !== null ? 0 : 1);
    if (tierA !== tierB) return tierA - tierB;
    if (a.priorityRank !== null && b.priorityRank !== null && a.priorityRank !== b.priorityRank) {
      return a.priorityRank - b.priorityRank;
    }
    return a.index - b.index;
  });

  const leadStories = sortedForBriefing.slice(0, maxLeadStories).map((r) => r.story);
  const priorityMatchesCount = leadStories.filter((s) => Boolean(s.priorityTopic)).length;

  if (leadStories.length > 0) {
    const intros = ["First", "Next", "Also in the news", "Finally"];
    leadStories.forEach((story, idx) => {
      const cleanTitle = cleanSpeechText(story.title);
      const cleanSummary = extractFirstSentence(story.summary);
      const source = story.source ? `from ${story.source}` : "";

      let leadPrefix: string;
      if (story.priorityTopic) {
        const highlightIntro =
          idx === 0
            ? `Starting with your priority topic ${story.priorityTopic}`
            : `Next, on your priority topic ${story.priorityTopic}`;
        leadPrefix = source ? `${highlightIntro}, ${source}` : highlightIntro;
      } else {
        const prefix = intros[idx] || "Additionally";
        leadPrefix = `${prefix}, ${source}`;
      }

      const storyBody =
        cleanSummary && cleanSummary !== cleanTitle
          ? `${leadPrefix}: ${cleanTitle}. ${cleanSummary}`
          : `${leadPrefix}: ${cleanTitle}.`;
      const chapterText =
        idx === 0 ? `Here are your lead stories today. ${storyBody}` : storyBody;

      chapters.push({
        id: `story-${idx + 1}`,
        kind: "story",
        label: story.priorityTopic ? `★ ${story.priorityTopic}` : `Story ${idx + 1}`,
        icon: story.priorityTopic ? "★" : `${idx + 1}`,
        text: chapterText,
        storyIndex: idx,
        storyUrl: story.url,
      });
    });
  }

  // 6. Sign-off
  const signoff =
    edition === "morning"
      ? "That concludes your morning executive briefing. Have a productive day ahead."
      : edition === "afternoon"
        ? "That concludes your afternoon executive briefing. Have a wonderful remainder of the day."
        : "That concludes your evening executive briefing. Rest well and stay informed.";
  chapters.push({
    id: "signoff",
    kind: "signoff",
    label: "Sign-off",
    icon: "✨",
    text: signoff,
  });

  return {
    greeting,
    formattedDate,
    edition,
    weatherGlance,
    marketGlance,
    marketWatchlistGlance,
    pulseGlance,
    situationRadar,
    catchUpDelta,
    leadStories,
    unreadCount,
    priorityTopics,
    priorityMatchesCount,
    chapters,
    spokenScript: chapters.map((ch) => ch.text).join(" "),
  };
}

export async function sendServerBriefingNow(
  options: { sendPush?: boolean; sendEmail?: boolean } = {},
  fetcher: typeof fetch = fetch,
): Promise<{
  ok: boolean;
  sentPush: boolean;
  sentEmail: boolean;
  hostedSharePath?: string | null;
  warning?: string | null;
  error?: string;
}> {
  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!csrf.ok) {
      return { ok: false, sentPush: false, sentEmail: false, error: "Could not authorize delivery request." };
    }
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) {
      return { ok: false, sentPush: false, sentEmail: false, error: "Missing CSRF token." };
    }

    const res = await fetcher("/api/briefing-delivery/send-now", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-XSRF-TOKEN": token,
      },
      body: JSON.stringify({
        sendPush: options.sendPush ?? true,
        sendEmail: options.sendEmail ?? false,
      }),
    });

    if (!res.ok) {
      return {
        ok: false,
        sentPush: false,
        sentEmail: false,
        error: `Delivery failed (${res.status}).`,
      };
    }

    const payload = (await res.json()) as {
      sentPush?: boolean;
      sentEmail?: boolean;
      hostedSharePath?: string | null;
      warning?: string | null;
    };
    return {
      ok: true,
      sentPush: Boolean(payload.sentPush),
      sentEmail: Boolean(payload.sentEmail),
      hostedSharePath: payload.hostedSharePath,
      warning: payload.warning,
    };
  } catch (err) {
    return {
      ok: false,
      sentPush: false,
      sentEmail: false,
      error: err instanceof Error ? err.message : "Delivery request failed.",
    };
  }
}
