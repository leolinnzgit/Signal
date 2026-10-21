import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/weather-briefing.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { weatherBriefing, describeWeather } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
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
