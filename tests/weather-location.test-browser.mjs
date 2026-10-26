import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const root = resolve("Signal.Server/wwwroot");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = resolve(root, "." + (pathname === "/" ? "/index.html" : pathname));
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try { response.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream"); response.end(await readFile(path)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const weather = {
  timezone: "Pacific/Auckland",
  current: { time: "2026-10-27T10:00", temperature_2m: 17, apparent_temperature: 15, relative_humidity_2m: 65, weather_code: 3, wind_speed_10m: 12, is_day: 1 },
  daily: { time: ["2026-10-27"], weather_code: [61], temperature_2m_max: [21], temperature_2m_min: [12], precipitation_probability_max: [75], wind_speed_10m_max: [20] },
};
const history = { articles: [], historyTotal: 0, bookmarkTotal: 0, matchingTotal: 0, filterTotal: 0, hasMore: false, bookmarkedUrls: [], readUrls: [], topicFacets: [], providerFacets: [] };
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.SIGNAL_BROWSER_CHANNEL || "msedge" });
  for (const scenario of ["mobile", "small-phone", "desktop", "moving", "lookup-down", "saved-city"]) {
    const viewport = { width: scenario === "desktop" ? 1280 : scenario === "small-phone" ? 320 : 390, height: 900 };
    const context = await browser.newContext({ viewport,
      geolocation: { latitude: -37.787123, longitude: 175.279345 }, permissions: ["geolocation"], serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [], names = [], forecasts = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("signal.weather-audio-on-open.v1", "false"));
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      const json = body => route.fulfill({ json: body });
      if (url.hostname === "api.open-meteo.com") { forecasts.push(url.searchParams); return json(weather); }
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/api/weather/location") {
        names.push(url.searchParams);
        if (scenario === "lookup-down") return route.fulfill({ status: 503, json: {} });
        return json({ name: Number(url.searchParams.get("latitude")) < -40 ? "Wellington" : "Hamilton" });
      }
      if (url.pathname === "/api/auth/me") return json({ email: "weather-test@localhost", displayName: "Weather test", googleConnected: false, hasPassword: true });
      if (url.pathname === "/api/auth/providers") return json({ google: false });
      if (url.pathname === "/api/auth/csrf") return json({ token: "weather-test-csrf" });
      if (url.pathname === "/api/preferences") return json({ exists: true, preferences: { topics: [],
        weatherLocation: scenario === "saved-city" ? { name: "Taupō", latitude: -38.6857, longitude: 176.0702, timezone: "Pacific/Auckland" } : null } });
      if (url.pathname.startsWith("/api/articles")) return json(history);
      if (url.pathname.startsWith("/api/topic-refresh")) return json({ articles: [], topics: [], refreshedAt: null, historyTotal: 0, bookmarkTotal: 0 });
      if (url.pathname === "/api/social") return json({ friends: [], incomingRequests: [], outgoingRequests: [], unreadMessages: 0 });
      if (url.pathname.startsWith("/api/")) return json({});
      return route.continue();
    });
    await page.goto(origin, { timeout: 90_000 });
    const expected = scenario === "lookup-down" ? "Current location" : scenario === "saved-city" ? "Taupō" : "Hamilton";
    const summary = page.locator(".weather-summary-button");
    await summary.filter({ hasText: expected }).waitFor();
    await page.locator(".hero.compact").waitFor();
    const place = summary.locator(".weather-place");
    await place.waitFor({ state: "visible" });
    assert.equal(await place.innerText(), expected, "The compact phone header keeps the town visible");
    const placeBounds = await place.boundingBox();
    assert.ok(placeBounds.x >= 0 && placeBounds.x + placeBounds.width <= viewport.width, "The town stays inside the phone screen");
    assert.doesNotMatch(await summary.innerText(), /Auckland/);
    assert.ok(forecasts.length > 0, "The forecast loads even when town lookup fails");
    assert.equal(forecasts[0].get("latitude"), scenario === "saved-city" ? "-38.6857" : "-37.7871");
    if (scenario === "saved-city") assert.equal(names.length, 0, "Saved cities bypass device-town lookup");
    else {
      assert.equal(names[0].get("latitude"), "-37.787");
      assert.equal(names[0].get("longitude"), "175.279");
    }
    await summary.click();
    await page.locator(".weather-forecast-heading").filter({ hasText: expected }).waitFor();
    if (scenario === "moving") {
      await context.setGeolocation({ latitude: -41.286512, longitude: 174.776223 });
      await page.getByRole("button", { name: "Refresh weather", exact: true }).click();
      await summary.filter({ hasText: "Wellington" }).waitFor();
      await page.locator(".weather-forecast-heading").filter({ hasText: "Wellington" }).waitFor();
      assert.equal(names.at(-1).get("latitude"), "-41.287");
      assert.equal(forecasts.at(-1).get("latitude"), "-41.2865");
    }
    assert.deepEqual(errors, []);
    if (["mobile", "desktop"].includes(scenario)) {
      await mkdir("work/weather-town", { recursive: true });
      await page.screenshot({ path: `work/weather-town/${scenario}.png` });
    }
    console.log(`PASS built weather town: ${scenario}`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
