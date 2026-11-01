import {
  describeWeather,
  type ClientWeatherAlert,
  type ClientWeatherConditions,
  type LocalWeather,
  type WeatherForecastDay,
} from "./weather-briefing.ts";
import { formatMarketPrice, type MarketQuote } from "./market-quote.ts";
import type { EntityPulseSummary } from "./entity-pulse.ts";

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
};

export type DailyBriefingParams = {
  weather?: LocalWeather | null;
  forecast?: WeatherForecastDay[];
  alerts?: ClientWeatherAlert[];
  conditions?: ClientWeatherConditions | null;
  marketQuote?: MarketQuote | null;
  pulse?: EntityPulseSummary | null;
  articles?: DailyBriefingStory[];
  userTime?: Date;
  userEmail?: string;
  maxLeadStories?: number;
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
  pulseGlance?: DailyBriefingGlancePulse;
  leadStories: DailyBriefingStory[];
  unreadCount: number;
  spokenScript: string;
};

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
 * entity pulse momentum, and lead news stories into structured glances and a
 * radio-ready neural spoken narration script.
 */
export function buildDailyBriefing(params: DailyBriefingParams = {}): DailyBriefingData {
  const {
    weather,
    forecast = [],
    alerts = [],
    conditions,
    marketQuote,
    pulse,
    articles = [],
    userTime = new Date(),
    maxLeadStories = 4,
  } = params;

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

  const spokenSections: string[] = [];
  spokenSections.push(`${greeting}. Here is your Signal Executive Briefing for ${formattedDate}.`);

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
    spokenSections.push(weatherLine);
  }

  // 3. Market Movers Glance & Narration
  let marketGlance: DailyBriefingGlanceMarket | undefined;
  if (marketQuote) {
    const formattedPrice = formatMarketPrice(marketQuote.price, marketQuote.currency);
    const isPositive = marketQuote.percentChange >= 0;

    marketGlance = {
      topic: marketQuote.topic,
      symbol: marketQuote.symbol,
      name: marketQuote.name || marketQuote.symbol,
      price: marketQuote.price,
      currency: marketQuote.currency,
      formattedPrice,
      change: marketQuote.change,
      percentChange: marketQuote.percentChange,
      isPositive,
    };

    const direction =
      marketQuote.percentChange > 0 ? "up" : marketQuote.percentChange < 0 ? "down" : "unchanged at";
    const absPercent = Math.abs(marketQuote.percentChange).toFixed(2);
    const marketName = marketQuote.name || marketQuote.symbol;
    const marketCurrency = marketQuote.currency ? ` ${marketQuote.currency}` : "";

    spokenSections.push(
      `In financial markets, ${marketName} is trading at ${marketQuote.price.toFixed(2)}${marketCurrency}, ${direction} ${absPercent} percent.`
    );
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
      spokenSections.push(
        `In topic momentum, top surging entity is ${topSurging} with ${mentions} mentions this week across your ${pulse.totalTracked} tracked topics.`
      );
    } else if (pulse.totalMentionsThisWeek > 0) {
      spokenSections.push(
        `In topic momentum, you have ${pulse.totalMentionsThisWeek} mentions this week across ${pulse.totalTracked} tracked topics.`
      );
    }
  }

  // 5. Lead Stories
  const seenUrls = new Set<string>();
  const uniqueArticles: DailyBriefingStory[] = [];
  for (const art of articles) {
    if (!seenUrls.has(art.url)) {
      seenUrls.add(art.url);
      uniqueArticles.push(art);
    }
  }

  const unreadArticles = uniqueArticles.filter((a) => !a.isRead);
  const unreadCount = unreadArticles.length;

  const leadStories: DailyBriefingStory[] = [];
  for (const art of unreadArticles) {
    if (leadStories.length >= maxLeadStories) break;
    leadStories.push(art);
  }
  if (leadStories.length < maxLeadStories) {
    for (const art of uniqueArticles) {
      if (leadStories.length >= maxLeadStories) break;
      if (!leadStories.some((lead) => lead.url === art.url)) {
        leadStories.push(art);
      }
    }
  }

  if (leadStories.length > 0) {
    spokenSections.push("Here are your lead stories today.");
    const intros = ["First", "Next", "Also in the news", "Finally"];
    leadStories.forEach((story, idx) => {
      const prefix = intros[idx] || "Additionally";
      const cleanTitle = cleanSpeechText(story.title);
      const cleanSummary = extractFirstSentence(story.summary);
      const source = story.source ? `from ${story.source}` : "";
      if (cleanSummary && cleanSummary !== cleanTitle) {
        spokenSections.push(`${prefix}, ${source}: ${cleanTitle}. ${cleanSummary}`);
      } else {
        spokenSections.push(`${prefix}, ${source}: ${cleanTitle}.`);
      }
    });
  }

  // 6. Sign-off
  const signoff =
    edition === "morning"
      ? "That concludes your morning executive briefing. Have a productive day ahead."
      : edition === "afternoon"
        ? "That concludes your afternoon executive briefing. Have a wonderful remainder of the day."
        : "That concludes your evening executive briefing. Rest well and stay informed.";
  spokenSections.push(signoff);

  return {
    greeting,
    formattedDate,
    edition,
    weatherGlance,
    marketGlance,
    pulseGlance,
    leadStories,
    unreadCount,
    spokenScript: spokenSections.join(" "),
  };
}
