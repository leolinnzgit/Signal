import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: "navigation-test-page",
  configureServer(server) {
    server.middlewares.use("/navigation-test", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/navigation-test", '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/player-navigation.fixture.tsx"></script></body></html>'));
    });
  },
}], optimizeDeps: { entries: ["tests/player-navigation.fixture.tsx"] }, server: { host: "127.0.0.1", port: 3016, strictPort: true, watch: { ignored: ["**/work/**", "**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36" });
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const base = "http://127.0.0.1:3016/navigation-test";
  await page.goto(base);
  await page.getByRole("button", { name: "Open headlines", exact: true }).click();
  await page.getByRole("button", { name: "Open reader", exact: true }).click();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-testid="view"]').textContent === "headlines");
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-testid="view"]').textContent === "feed");
  assert.equal(page.url(), base, "Back from the player stays in Signal");
  await page.goForward();
  await page.waitForFunction(() => history.state.signalPlayerNavigation.views.length === 0);
  assert.equal(await page.getByTestId("view").textContent(), "feed", "Forward does not restart audio");

  for (let repeat = 0; repeat < 3; repeat++) {
    await page.getByRole("button", { name: "Open headlines", exact: true }).click();
    await page.getByRole("button", { name: "Open reader", exact: true }).click();
    await page.getByRole("button", { name: "Close reader", exact: true }).click();
    await page.waitForFunction(() => history.state.signalPlayerNavigation.views.length === 1);
    await page.getByRole("button", { name: "Close headlines", exact: true }).click();
    await page.waitForFunction(() => history.state.signalPlayerNavigation.views.length === 0);
  }
  assert.equal(await page.evaluate(() => history.length), 4, "Repeated button closes do not accumulate history entries");
  await page.getByRole("button", { name: "Open headlines", exact: true }).click();
  await page.getByRole("button", { name: "Open reader", exact: true }).click();
  await page.getByRole("button", { name: "Close all", exact: true }).click();
  await page.waitForFunction(() => history.state.signalPlayerNavigation.views.length === 0);
  await page.getByRole("button", { name: "Open reader", exact: true }).click();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-testid="view"]').textContent === "feed");
  console.log("PASS mobile Back, nested readers, Forward, repeated closes, and standalone reader");

  await page.addInitScript(() => {
    localStorage.setItem("signal.weather-audio-on-open.v1", "false");
    localStorage.setItem("signal-news-preferences", JSON.stringify({ topics: ["Technology"], sources: { google: true, gdelt: false, rssFeeds: [] } }));
    Element.prototype.requestFullscreen = undefined;
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = matchMedia(query);
      if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const stream = `/api/article-audio-stream/${"a".repeat(32)}`;
    if (path === "/api/news") return route.fulfill({ json: { articles: [{ title: "Navigation test story", url: "https://example.com/story",
      source: "Test", publishedAt: new Date().toISOString(), summary: "Story summary", matchedTopics: ["Technology"] }], fetchedAt: new Date().toISOString() } });
    if (path === "/api/article-reader") return route.fulfill({ json: { available: true, article: { finalUrl: "https://example.com/story", paragraphs: ["The full story."], byline: "", siteName: "Test", publishedAt: "" } } });
    if (path === "/api/headline-audio/voices") return route.fulfill({ json: [], headers: { "X-Signal-Article-Streaming": "true" } });
    if (path === "/api/auth/csrf") return route.fulfill({ json: { token: "test" } });
    if (path === "/api/article-audio-stream") return route.fulfill({ json: { url: stream, statusUrl: `${stream}/status` } });
    if (path === `${stream}/status`) return route.fulfill({ json: { starts: [0], complete: false, duration: 60, error: null } });
    if (path === stream) {
      const wav = Buffer.alloc(44 + 16000 * 2 * 60);
      wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
      return route.fulfill({ contentType: "audio/wav", body: wav });
    }
    if (path.includes("audio")) return route.fulfill({ status: 503, json: { error: "Audio unavailable in navigation test" } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${base}?dashboard`);
  await page.getByRole("button", { name: "Play 1 unread headlines in full screen", exact: true }).click();
  await page.getByRole("button", { name: "Close headline playback", exact: true }).waitFor();
  await page.getByRole("button", { name: "Play audio briefing", exact: true }).click();
  await page.waitForFunction(() => { const audio = document.querySelector('audio[aria-label="Screen-off audio briefing"]'); window.briefingAudio = audio; return audio && !audio.paused; });
  await page.getByRole("button", { name: "Read full news aloud", exact: true }).click();
  await page.getByRole("button", { name: "Close article reader", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Close article reader", exact: true }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Close headline playback", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Close headline playback", exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.briefingAudio.paused && !window.briefingAudio.getAttribute("src")), true, "Back stops and unloads briefing audio");
  assert.equal(page.url(), `${base}?dashboard`);
  await page.getByRole("button", { name: "Listen to Navigation test story", exact: true }).click();
  await page.getByRole("button", { name: "Close article reader", exact: true }).waitFor();
  await page.goBack();
  await page.getByRole("button", { name: "Close article reader", exact: true }).waitFor({ state: "detached" });
  assert.equal(page.url(), `${base}?dashboard`);
  assert.deepEqual(errors, []);
  console.log("PASS Android dashboard: screen-off briefing → full article → briefing → feed; article audio → feed");
} finally { await browser?.close(); await server.close(); }
