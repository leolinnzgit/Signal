import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/weather-briefing.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { weatherBriefing, describeWeather, weatherConditionKey, shouldAutoReadWeather, formatMinuteRainHeadline } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const weather = { temperature: 16.8, apparentTemperature: 15.2, weatherCode: 3, windSpeed: 12.3,
  locationName: "Auckland", observedAt: "2026-10-13T09:00", timezone: "Pacific/Auckland" };
const today = { date: "2026-10-13", weatherCode: 61, temperatureMax: 20.6, temperatureMin: 11.8, precipitationProbability: 75 };

test("weather briefing reads current conditions and the matching local day's forecast", () => {
  assert.equal(weatherBriefing(weather, [{ ...today, date: "2026-10-12", temperatureMax: 99 }, today]),
    "Here is your weather for Auckland. Currently, overcast, 17 degrees Celsius, feeling like 15 degrees. Wind is 12 kilometres per hour. Today, expect rain, with a high of 21 and a low of 12 degrees Celsius. The chance of rain is 75 percent.");
});
test("missing weather produces no narration and missing today never reads another day's forecast", () => {
  assert.equal(weatherBriefing(null, [today]), "");
  assert.ok(!weatherBriefing(weather, [{ ...today, date: "2026-10-14" }]).includes("Today"));
  assert.ok(!weatherBriefing({ ...weather, observedAt: "" }, [today]).includes("Today"));
});
test("zero and negative temperatures and zero rain remain meaningful", () => {
  const text = weatherBriefing({ ...weather, temperature: -3.4, apparentTemperature: -6, windSpeed: 0 },
    [{ ...today, temperatureMax: 0, temperatureMin: -8, precipitationProbability: 0 }]);
  assert.match(text, /-3 degrees Celsius, feeling like -6/);
  assert.match(text, /high of 0 and a low of -8/);
  assert.match(text, /rain is 0 percent/);
});
test("weather descriptions distinguish overcast and unknown codes", () => {
  assert.equal(describeWeather(3), "Overcast");
  assert.equal(describeWeather(-1), "Local weather");
  assert.equal(describeWeather(100), "Local weather");
});
test("weather briefing includes active severe weather alerts when present", () => {
  const alert = {
    id: "alert-1",
    headline: "Severe Gale Warning",
    level: "Warning",
    severity: "Severe",
    areaName: "Auckland Region",
    description: "Northwest gales gusting 120 km/h.",
    effectiveTime: "2026-10-13T08:00:00Z",
    expires: "2026-10-13T20:00:00Z",
    source: "MetService",
  };
  const briefing = weatherBriefing(weather, [today], [alert]);
  assert.ok(briefing.includes("Attention: Severe Gale Warning."));
  assert.ok(briefing.includes("Here is your weather for Auckland."));
});
test("weather briefing includes high UV and poor air quality warnings when present", () => {
  const highUvConditions = {
    available: true,
    uvIndex: 7,
    uvCategory: "High",
    airQualityIndex: 120,
    airQualityCategory: "Unhealthy for Sensitive Groups",
  };
  const briefing = weatherBriefing(weather, [today], [], highUvConditions);
  assert.ok(briefing.includes("The UV index is 7, High. Sun protection is recommended."));
  assert.ok(briefing.includes("Air quality is unhealthy for sensitive groups."));

  const lowUvConditions = {
    available: true,
    uvIndex: 3,
    uvCategory: "Moderate",
    airQualityIndex: 20,
    airQualityCategory: "Good",
  };
  const safeBriefing = weatherBriefing(weather, [today], [], lowUvConditions);
  assert.ok(!safeBriefing.includes("UV index"));
  assert.ok(!safeBriefing.includes("Air quality"));
});
test("weatherConditionKey tracks local calendar day and grouped condition while ignoring temperature and wind", () => {
  assert.equal(weatherConditionKey(null), "");
  assert.equal(shouldAutoReadWeather("", ""), false);

  const initialKey = weatherConditionKey(weather);
  assert.equal(initialKey, "2026-10-13|Overcast");
  assert.equal(shouldAutoReadWeather(initialKey, ""), true);
  assert.equal(shouldAutoReadWeather(initialKey, initialKey), false);

  const warmerLaterSameCondition = weatherConditionKey({
    ...weather,
    temperature: 22.4,
    apparentTemperature: 21,
    windSpeed: 30,
    humidity: 45,
    isDay: false,
    observedAt: "2026-10-13T15:00",
    locationName: "Wellington",
  });
  assert.equal(warmerLaterSameCondition, initialKey);
  assert.equal(shouldAutoReadWeather(warmerLaterSameCondition, initialKey), false);

  // Equivalent WMO codes within the same grouped label do not re-trigger.
  const partlyCloudy1 = weatherConditionKey({ ...weather, weatherCode: 1 });
  const partlyCloudy2 = weatherConditionKey({ ...weather, weatherCode: 2 });
  assert.equal(partlyCloudy1, "2026-10-13|Partly cloudy");
  assert.equal(partlyCloudy2, partlyCloudy1);
  assert.equal(shouldAutoReadWeather(partlyCloudy2, partlyCloudy1), false);

  const lightRain = weatherConditionKey({ ...weather, weatherCode: 61 });
  const moderateRain = weatherConditionKey({ ...weather, weatherCode: 63 });
  assert.equal(lightRain, "2026-10-13|Rain");
  assert.equal(moderateRain, lightRain);
  assert.equal(shouldAutoReadWeather(lightRain, initialKey), true);
  assert.equal(shouldAutoReadWeather(moderateRain, lightRain), false);

  const clearedLater = weatherConditionKey({ ...weather, weatherCode: 0, observedAt: "2026-10-13T17:00" });
  assert.equal(clearedLater, "2026-10-13|Clear");
  assert.equal(shouldAutoReadWeather(clearedLater, lightRain), true);

  const nextDaySameCondition = weatherConditionKey({ ...weather, weatherCode: 0, observedAt: "2026-10-14T08:00" });
  assert.equal(nextDaySameCondition, "2026-10-14|Clear");
  assert.equal(shouldAutoReadWeather(nextDaySameCondition, clearedLater), true);

  // Missing observedAt falls back to now formatted in the weather location's timezone.
  const fallbackKey = weatherConditionKey(
    { ...weather, weatherCode: 0, observedAt: "" },
    new Date("2026-10-13T20:00:00Z"),
  );
  assert.equal(fallbackKey, "2026-10-14|Clear");
});

test("minute-by-minute rain headlines, briefing narration, and condition key transitions", () => {
  assert.equal(formatMinuteRainHeadline(null), "");
  assert.equal(formatMinuteRainHeadline({ available: true, hasPrecipitation: false, isRainingNow: false, alertState: "none" }), "");

  const startingSoon = {
    available: true,
    hasPrecipitation: true,
    isRainingNow: false,
    startsInMinutes: 15,
    endsInMinutes: 35,
    precipitationType: "rain",
    alertState: "starting-soon",
    briefPhrase60: "Rain starting in 15 min",
    summary: "Rain in 15 min",
  };
  assert.equal(formatMinuteRainHeadline(startingSoon), "Rain in 15 min");

  const dry = { available: true, hasPrecipitation: false, isRainingNow: false, alertState: "none", summary: "No precipitation" };
  const baseBriefing = weatherBriefing(weather, [today]);
  assert.equal(weatherBriefing(weather, [today], [], null, dry), baseBriefing);

  const rainBriefing = weatherBriefing(weather, [today], [], null, startingSoon);
  assert.ok(rainBriefing.includes("Rain alert: Rain starting in 15 min."));

  const easingSoon = {
    available: true,
    hasPrecipitation: true,
    isRainingNow: true,
    endsInMinutes: 20,
    precipitationType: "rain",
    alertState: "ongoing-ending",
  };
  assert.equal(formatMinuteRainHeadline(easingSoon), "Rain ending in 20 min");
  assert.ok(weatherBriefing(weather, [today], [], null, easingSoon).includes("Rain is expected to ease in about 20 minutes."));

  // Condition key stays unchanged when dry or starting later, transitions once for starting-soon/ongoing-ending,
  // and does not include numeric minute countdowns so ticking down does not repeat auto-read.
  const baseKey = weatherConditionKey(weather, new Date("2026-10-13T09:00:00Z"));
  assert.equal(weatherConditionKey(weather, new Date("2026-10-13T09:00:00Z"), dry), baseKey);
  assert.equal(weatherConditionKey(weather, new Date("2026-10-13T09:00:00Z"), { ...startingSoon, startsInMinutes: 75, alertState: "starting-later" }), baseKey);

  const rainAlertKey15 = weatherConditionKey(weather, new Date("2026-10-13T09:00:00Z"), startingSoon);
  const rainAlertKey10 = weatherConditionKey(weather, new Date("2026-10-13T09:05:00Z"), { ...startingSoon, startsInMinutes: 10 });
  assert.equal(rainAlertKey15, "2026-10-13|Overcast|starting-soon:rain");
  assert.equal(rainAlertKey10, rainAlertKey15);
  assert.equal(shouldAutoReadWeather(rainAlertKey15, baseKey), true);
  assert.equal(shouldAutoReadWeather(rainAlertKey10, rainAlertKey15), false);
});
