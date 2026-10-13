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
}], server: { host: "127.0.0.1", port: 3015, strictPort: true, watch: { ignored: ["**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });

async function mockSpeech(page, scenario = "automatic") {
  await page.addInitScript(scenario => {
    window.weatherCalls = [];
    window.weatherCancels = 0;
    window.failWeather = scenario === "blocked";
    if (scenario === "disabled") localStorage.setItem("signal.weather-audio-on-open.v1", "false");
    localStorage.setItem("signal-headline-speech-preferences", JSON.stringify({ rate: 1.1 }));
    let gesture = false;
    document.addEventListener("pointerdown", () => { gesture = true; }, true);
    document.addEventListener("pointerdown", () => { gesture = false; });
    document.addEventListener("keydown", () => { gesture = true; }, true);
    document.addEventListener("keydown", () => { gesture = false; });
    const voice = { name: "Device English", voiceURI: "device-en", lang: "en-NZ", default: true, localService: true };
    const synth = {
      speaking: false, pending: false, paused: false,
      getVoices: () => scenario === "empty-voices" ? [] : [voice],
      cancel() { window.weatherCancels++; synth.speaking = false; },
      pause() {}, resume() {},
      speak(utterance) {
        window.weatherCalls.push({ text: utterance.text, rate: utterance.rate, voice: utterance.voice?.name, gesture });
        window.currentWeather = utterance;
        if (window.failWeather) { utterance.onerror?.({ error: "not-allowed" }); return; }
        synth.speaking = true;
        utterance.onstart?.();
      },
    };
    window.finishWeatherPart = () => { synth.speaking = false; window.currentWeather.onend?.(); };
    Object.defineProperty(window, "speechSynthesis", { value: synth });
    window.SpeechSynthesisUtterance = scenario === "unsupported" ? undefined : class { constructor(text) { this.text = text; } };
  }, scenario);
}
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const scenario of process.argv.includes("--dashboard-only") ? [] : ["automatic", "blocked", "disabled", "mobile", "empty-voices", "unsupported", "long-briefing"]) {
    const page = await browser.newPage({ ...(scenario === "mobile" ? { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36", hasTouch: true } : {}) });
    const errors = [];
    let audioRequests = 0;
    page.on("pageerror", error => errors.push(error.message));
    await mockSpeech(page, scenario);
    await page.route("**/api/**", route => { audioRequests++; return route.abort(); });
    await page.goto("http://127.0.0.1:3015/weather-test");
    const status = page.getByTestId("status");
    const read = page.getByRole("button", { name: "Read weather now" });
    await read.waitFor();
    if (scenario === "unsupported") {
      assert.equal(await read.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.weatherCalls.length), 0);
    } else {
      if (scenario === "disabled" || scenario === "mobile") {
        assert.equal(await page.evaluate(() => window.weatherCalls.length), 0);
        if (scenario === "mobile") await page.getByRole("button", { name: "Normal interaction" }).click();
        else await read.click();
      } else if (scenario === "blocked") {
        await page.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === "blocked");
        await page.evaluate(() => { window.failWeather = false; });
        await page.getByRole("button", { name: "Normal interaction" }).click();
      }
      await page.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === "playing");
      const calls = await page.evaluate(() => window.weatherCalls);
      assert.equal(calls.length, scenario === "blocked" ? 2 : 1, "Only one successful opening reading, including StrictMode");
      assert.equal(calls.at(-1).rate, 1.1, "Uses the saved browser speech speed");
      assert.equal(calls.at(-1).voice, scenario === "empty-voices" ? undefined : "Device English");
      if (scenario === "mobile") assert.equal(calls.at(-1).gesture, true, "Starts synchronously in the first gesture");
      if (scenario === "long-briefing") {
        await page.getByRole("button", { name: "Longer weather" }).click();
        await read.click();
        for (let part = 0; part < 10; part++) {
          const count = await page.evaluate(() => window.weatherCalls.length);
          await page.evaluate(() => window.finishWeatherPart());
          await page.waitForFunction(count => window.weatherCalls.length > count || document.querySelector('[data-testid="status"]').textContent === "finished", count);
          if (await status.textContent() === "finished") break;
        }
        assert.equal(await status.textContent(), "finished");
        const parts = await page.evaluate(() => window.weatherCalls.slice(1).map(call => call.text));
        assert.ok(parts.length > 1 && parts.every(part => part.length <= 240), "Longer weather uses short mobile speech sections");
        assert.equal(parts.join(" "), "A weather update. ".repeat(50).trim(), "Every word is spoken through the end of a longer briefing");
      }
      if (scenario === "automatic") {
        await page.evaluate(() => window.finishWeatherPart());
        await page.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === "finished");
        await page.getByRole("button", { name: "Refresh weather" }).click();
        assert.equal(await page.evaluate(() => window.weatherCalls.length), 1, "A refresh never repeats weather automatically");
        await read.click();
        await page.getByRole("button", { name: "Toggle other audio" }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="status"]').textContent === "idle");
        assert.ok(await page.evaluate(() => window.weatherCancels > 0));
        await page.getByRole("button", { name: "Toggle other audio" }).click();
        assert.equal(await page.evaluate(() => window.weatherCalls.length), 2);
        await page.getByRole("checkbox", { name: "Read weather on opening" }).uncheck();
        await page.getByRole("button", { name: "Toggle dashboard" }).click();
        await page.getByRole("button", { name: "Toggle dashboard" }).click();
        assert.equal(await page.getByRole("checkbox", { name: "Read weather on opening" }).isChecked(), false);
        assert.equal(await page.evaluate(() => window.weatherCalls.length), 2);
      }
      await page.getByRole("button", { name: "Stop reading" }).click();
    }
    assert.equal(audioRequests, 0, "Browser weather never requests server speech or voice choices");
    assert.deepEqual(errors, []);
    console.log(`PASS browser weather: ${scenario}`);
    await page.close();
  }
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    let audioRequests = 0;
    page.on("pageerror", error => errors.push(error.message));
    await mockSpeech(page);
    await page.addInitScript(() => {
      localStorage.setItem("signal-news-preferences", JSON.stringify({ weatherLocation: { name: "Auckland", latitude: -36.85, longitude: 174.76, timezone: "Pacific/Auckland" } }));
    });
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "api.open-meteo.com") return route.fulfill({ json: {
        timezone: "Pacific/Auckland", current: { time: "2026-10-13T10:00", temperature_2m: 17, apparent_temperature: 15, relative_humidity_2m: 65, weather_code: 3, wind_speed_10m: 12, is_day: 1 },
        daily: { time: ["2026-10-13"], weather_code: [61], temperature_2m_max: [21], temperature_2m_min: [12], precipitation_probability_max: [75], wind_speed_10m_max: [20] },
      } });
      if (url.hostname !== "127.0.0.1") return route.abort();
      if (url.pathname.startsWith("/api/headline-audio") || url.pathname === "/api/auth/csrf") { audioRequests++; return route.abort(); }
      if (url.pathname === "/api/news") return route.fulfill({ json: { articles: [], fetchedAt: new Date().toISOString() } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.continue();
    });
    await page.goto("http://127.0.0.1:3015/weather-test?dashboard");
    await page.waitForFunction(() => window.weatherCalls.length === 1);
    assert.match(await page.evaluate(() => window.weatherCalls[0].text), /for Auckland.*Currently, overcast/);
    assert.match(await page.evaluate(() => window.weatherCalls.map(call => call.text).join(" ")), /Today, expect rain.*chance of rain is 75 percent/);
    assert.equal(await page.locator(".weather-audio, .hero audio").count(), 0);
    assert.equal(await page.getByRole("checkbox", { name: "Read weather on opening" }).count(), 0, "No weather speech settings in dashboard");
    await page.screenshot({ path: `work/browser-weather-${viewport.width}.png` });
    await page.locator(".weather-summary-button").click();
    await page.getByRole("button", { name: "Change location" }).click();
    const dialog = page.getByRole("dialog", { name: "Choose your forecast location." });
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Stop reading" }).click();
    const before = await page.evaluate(() => window.weatherCalls.length);
    await dialog.getByRole("button", { name: "Read weather now" }).click();
    assert.equal(await page.evaluate(() => window.weatherCalls.length), before + 1);
    await dialog.getByRole("checkbox", { name: "Read weather on opening" }).uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem("signal.weather-audio-on-open.v1")), "false");
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, "Settings fit the viewport");
    assert.equal(audioRequests, 0);
    assert.deepEqual(errors, []);
    console.log(`PASS hidden weather settings: ${viewport.width}`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
