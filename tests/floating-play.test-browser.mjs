// Run after the IIS client build. Uses the production bundle without a dev server.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createServer } from "node:http";

const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const root = resolve("Signal.Server/wwwroot");
const story = { title: "Floating Play test story", url: "https://example.com/play-story", source: "Test",
  publishedAt: new Date().toISOString(), summary: "A test news story.", topics: ["Technology"], providers: ["google"] };
const stream = `/api/article-audio-stream/${"a".repeat(32)}`;
const wav = Buffer.alloc(44 + 16000 * 2 * 60);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path.startsWith("/api/")) {
    if (path === stream) { res.setHeader("Content-Type", "audio/wav"); res.end(wav); return; }
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/headline-audio/voices") res.setHeader("X-Signal-Article-Streaming", "true");
    const responses = {
      "/api/auth/me": { email: "preview@example.com", displayName: "Playback test", hasPassword: true },
      "/api/auth/providers": { google: false }, "/api/auth/csrf": { token: "test" },
      "/api/app-version": { version: "test" },
      "/api/preferences": { exists: true, preferences: { topics: ["Technology"], sources: { google: true, gdelt: false, rssFeeds: [] }, limit: 10 } },
      "/api/social": { friends: [], incomingRequests: [], outgoingRequests: [], unreadMessages: 0 },
      "/api/comments/latest": { comments: [], newCount: 0 },
      "/api/articles": { articles: [], historyTotal: 0, bookmarkTotal: 0, matchingTotal: 0, filterTotal: 0,
        hasMore: false, bookmarkedUrls: [], readUrls: [], topicFacets: [], providerFacets: [] },
      "/api/topic-refresh": { articles: [story], topics: [], refreshedAt: new Date().toISOString(), historyTotal: 1, bookmarkTotal: 0 },
      "/api/headline-audio/voices": [],
      "/api/article-audio-stream": { url: stream, statusUrl: `${stream}/status` },
      [`${stream}/status`]: { starts: [0], complete: false, duration: 60, error: null },
    };
    res.end(JSON.stringify(responses[path] ?? {})); return;
  }
  const file = resolve(root, "." + (path === "/" ? "/index.html" : path));
  if (!file.startsWith(root + sep)) { res.statusCode = 403; res.end(); return; }
  try {
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" })[extname(file)] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const mobile of [true, false]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      ...(mobile ? { hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36" } : {}) });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("signal.weather-audio-on-open.v1", "false");
      Element.prototype.requestFullscreen = undefined;
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const result = matchMedia(query);
        if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
        return result;
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (window.blockNextBriefingPlay && this.getAttribute("aria-label") === "Screen-off audio briefing") {
          window.blockNextBriefingPlay = false;
          return Promise.reject(new DOMException("A tap is required", "NotAllowedError"));
        }
        return play.call(this);
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    const audio = page.locator('audio[aria-label="Screen-off audio briefing"]');
    const playing = () => page.waitForFunction(() => {
      const element = document.querySelector('audio[aria-label="Screen-off audio briefing"]');
      return element && !element.paused && element.currentTime > 0;
    });
    await page.locator(".floating-play-headlines").click();
    await playing();
    await page.getByRole("button", { name: "Pause audio briefing", exact: true }).click();
    await page.getByLabel(/Speaking speed/).selectOption("1.1");
    assert.equal(await audio.evaluate(element => element.paused), true, "Settings preserve an explicit pause");
    await page.getByRole("button", { name: "Play audio briefing", exact: true }).click();
    await playing();
    await page.getByRole("button", { name: "Minimize audio player", exact: true }).click();
    await playing();
    await page.getByRole("button", { name: "Restore audio player", exact: true }).click();
    await playing();
    await page.getByRole("button", { name: "Close headline playback", exact: true }).click();
    await audio.waitFor({ state: "detached" });
    await page.evaluate(() => { window.blockNextBriefingPlay = true; });
    await page.locator(".floating-play-random").click();
    await page.getByRole("alert").filter({ hasText: "Your briefing is ready. Tap Play" }).waitFor();
    assert.equal(await audio.evaluate(element => element.paused), true);
    await page.getByRole("button", { name: "Play audio briefing", exact: true }).click();
    await playing();
    await page.getByRole("button", { name: "Close headline playback", exact: true }).click();
    await audio.waitFor({ state: "detached" });
    await page.locator(".floating-play-random").click();
    await playing();
    assert.deepEqual(errors, []);
    console.log(`PASS ${mobile ? "installed Android" : "desktop"}: floating Play and random Play autostart, pause persists, minimize/restore continues, blocked autoplay recovers`);
    await context.close();
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
