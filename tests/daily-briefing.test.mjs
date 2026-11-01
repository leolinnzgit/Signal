import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyBriefing } from "../app/daily-briefing.ts";

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
