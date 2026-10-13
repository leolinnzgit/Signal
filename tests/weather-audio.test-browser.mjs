import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: "weather-test-page",
  configureServer(server) {
    server.middlewares.use("/weather-test", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/weather-test", '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/weather-audio.fixture.tsx"></script></body></html>'));
    });
  },
}], server: { host: "127.0.0.1", port: 3015, strictPort: true } });
// Valid PCM exercises the real authenticated audio preparation code.
const wave = Buffer.alloc(32044);
wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(32000, 40);
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const scenario of ["automatic", "blocked", "disabled", "stop-during-preparation", "other-audio-during-preparation", "retry-disabled"]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let requests = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const gated = scenario.includes("during-preparation");
    await page.addInitScript((scenario) => {
      window.weatherPlays = 0;
      window.weatherPauses = 0;
      window.blockWeather = scenario === "blocked";
      if (scenario === "disabled" || scenario === "retry-disabled") localStorage.setItem("signal.weather-audio-on-open.v1", "false");
      HTMLMediaElement.prototype.play = function () {
        window.weatherPlays++;
        if (window.blockWeather) return Promise.reject(new DOMException("Tap needed", "NotAllowedError"));
        this.dispatchEvent(new Event("play"));
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () { window.weatherPauses++; this.dispatchEvent(new Event("pause")); };
    }, scenario);
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/headline-audio/voices") return route.fulfill({ json: [], headers: { "X-Signal-Audio-Engine": "windows" } });
      if (path === "/api/auth/csrf") return route.fulfill({ json: { token: "test-token" } });
      if (path === "/api/headline-audio") {
        requests++;
        if (gated) await gate;
        if (scenario === "retry-disabled" && requests === 1) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
        return route.fulfill({ contentType: "audio/wav", body: wave, headers: { "X-Signal-Headline-Starts": "[0]" } });
      }
      return route.abort();
    });
    await page.goto("http://127.0.0.1:3015/weather-test");
    const play = page.getByRole("button", { name: "Play weather", exact: true });
    if (gated) {
      await page.waitForFunction(() => document.querySelector("audio"));
      if (scenario === "stop-during-preparation") await page.getByRole("button", { name: "Stop weather" }).click();
      else await page.getByRole("button", { name: "Toggle other audio" }).click();
      release();
      await page.getByText("Current weather and today's forecast.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.weatherPlays), 0);
      if (scenario === "other-audio-during-preparation") await page.getByRole("button", { name: "Toggle other audio" }).click();
      assert.equal(await page.evaluate(() => window.weatherPlays), 0, "No delayed weather interrupts another player");
      await play.click();
    } else if (scenario === "blocked") {
      await page.getByText("Tap Play weather to allow audio.").waitFor();
      await page.evaluate(() => { window.blockWeather = false; });
      await play.click();
    } else if (scenario === "disabled") {
      await page.getByText("Current weather and today's forecast.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.weatherPlays), 0);
      await play.click();
    } else if (scenario === "retry-disabled") {
      await page.getByRole("button", { name: "Retry weather audio" }).click();
    }
    await page.getByText("Reading current weather and today's forecast.", { exact: true }).waitFor();
    if (scenario === "automatic") {
      assert.equal(await page.evaluate(() => window.weatherPlays), 1, "StrictMode must not repeat the opening briefing");
      await page.getByRole("button", { name: "Toggle other audio" }).click();
      await page.getByText("Current weather and today's forecast.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Toggle other audio" }).click();
      await page.getByRole("button", { name: "Refresh weather" }).click();
      await page.getByText("Current weather and today's forecast.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.weatherPlays), 1, "Refresh must not repeat weather");
      await page.getByRole("checkbox", { name: "Read weather on opening" }).uncheck();
      await page.getByRole("button", { name: "Toggle dashboard" }).click();
      await page.getByRole("button", { name: "Toggle dashboard" }).click();
      await page.getByText("Current weather and today's forecast.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("checkbox", { name: "Read weather on opening" }).isChecked(), false);
      assert.equal(await page.evaluate(() => window.weatherPlays), 1, "Disabled preference survives reopening");
    }
    const bounds = await page.locator(".weather-audio").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390, "Weather controls fit a phone");
    assert.deepEqual(errors, []);
    console.log(`PASS weather audio: ${scenario}`);
    await page.close();
  }
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    let narration;
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("signal-news-preferences", JSON.stringify({ weatherLocation: { name: "Auckland", latitude: -36.85, longitude: 174.76, timezone: "Pacific/Auckland" } }));
      HTMLMediaElement.prototype.play = function () { this.dispatchEvent(new Event("play")); return Promise.resolve(); };
      HTMLMediaElement.prototype.pause = function () { this.dispatchEvent(new Event("pause")); };
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "api.open-meteo.com") return route.fulfill({ json: {
        timezone: "Pacific/Auckland", current: { time: "2026-10-13T10:00", temperature_2m: 17, apparent_temperature: 15, relative_humidity_2m: 65, weather_code: 3, wind_speed_10m: 12, is_day: 1 },
        daily: { time: ["2026-10-13"], weather_code: [61], temperature_2m_max: [21], temperature_2m_min: [12], precipitation_probability_max: [75], wind_speed_10m_max: [20] },
      } });
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname === "/api/headline-audio/voices") return route.fulfill({ json: [] });
      if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { token: "test" } });
      if (url.pathname === "/api/headline-audio") {
        narration = route.request().postDataJSON().titles[0];
        return route.fulfill({ contentType: "audio/wav", body: wave, headers: { "X-Signal-Headline-Starts": "[0]" } });
      }
      if (url.pathname === "/api/news") return route.fulfill({ json: { articles: [], fetchedAt: new Date().toISOString() } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.continue();
    });
    await page.goto("http://127.0.0.1:3015/weather-test?dashboard");
    await page.getByText("Reading current weather and today's forecast.", { exact: true }).waitFor();
    assert.match(narration, /for Auckland.*Currently, overcast.*Today, expect rain/);
    const bounds = await page.locator(".weather-audio").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
    assert.equal(await page.locator(".hero-context .weather-audio").count(), 1);
    for (const selector of [".hero-clocks", ".local-weather"]) {
      const sibling = await page.locator(selector).boundingBox();
      assert.ok(bounds.y >= sibling.y + sibling.height, "Audio controls sit below clocks and weather without overlap");
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `work/weather-audio-${viewport.width}.png` });
    console.log(`PASS dashboard weather integration: ${viewport.width}`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
