import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { readdir, readFile } from "node:fs/promises";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const measureOnly = process.argv.includes("--measure-only");
const cssName = (await readdir("iis-publish/wwwroot/assets")).find(name => /^index-.+\.css$/.test(name));
const productionCss = await readFile(`iis-publish/wwwroot/assets/${cssName}`, "utf8");
const starts = Array.from({ length: 480 }, (_, index) => index);
const streamPath = `/api/article-audio-stream/${"a".repeat(32)}`;
const wav = Buffer.alloc(44 + 480 * 16000);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/headline-performance-vite-cache",
  plugins: [react(), { name: "playback-performance", configureServer(server) {
    server.middlewares.use("/production-style.css", (_request, response) => {
      response.setHeader("Content-Type", "text/css"); response.end(productionCss);
    });
    server.middlewares.use("/playback-performance", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml("/playback-performance", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/production-style.css"></head><body><div id="root"></div><script type="module" src="/tests/headline-navigation-performance.fixture.tsx"></script></body></html>'));
    });
  } }], optimizeDeps: { entries: ["tests/headline-navigation-performance.fixture.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 3021, strictPort: true, watch: { ignored: ["**/work/**", "**/Signal.Server/**", "**/Signal.Server.TopicMatcher.Tests/**", "**/iis-publish/**"] } }
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultNavigationTimeout(120000); page.setDefaultTimeout(60000);
  const errors = [], market = [];
  page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    localStorage.setItem("signal.weather-audio-on-open.v1", "false");
    localStorage.setItem("signal-news-preferences", JSON.stringify({ topics: ["AI", "USA", "Anthropic", "NVIDIA"], limit: 120, sources: { google: true, gdelt: false, rssFeeds: [] }, tickerOverrides: {} }));
    const synth = { speaking: false, pending: false, paused: false, getVoices: () => [], addEventListener() {}, removeEventListener() {}, pause() {}, resume() {}, cancel() { synth.speaking = false; }, speak(utterance) { synth.speaking = true; utterance.onstart?.(); } };
    Object.defineProperty(window, "speechSynthesis", { value: synth });
    window.SpeechSynthesisUtterance = class extends EventTarget { constructor(text) { super(); this.text = text; } };
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") return route.abort();
    if (url.pathname === "/api/market") {
      market.push(url.searchParams.get("topic"));
      return route.fulfill({ status: 502, json: { error: "Provider unavailable" } });
    }
    if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { token: "test" } });
    if (url.pathname === "/api/headline-audio/voices") return route.fulfill({ json: [], headers: { "X-Signal-Article-Streaming": "true" } });
    if (url.pathname === "/api/article-audio-stream") return route.fulfill({ json: { url: streamPath, statusUrl: `${streamPath}/status`, status: { starts, complete: true, duration: 480, error: null } } });
    if (url.pathname === streamPath) {
      const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      const first = range ? Number(range[1]) : 0;
      const last = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({ status: range ? 206 : 200, body: wav.subarray(first, last + 1), headers: {
        "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": String(last - first + 1),
        ...(range ? { "Content-Range": `bytes ${first}-${last}/${wav.length}` } : {}),
      } });
    }
    if (url.pathname === `${streamPath}/status`) return route.fulfill({ json: { starts, complete: true, duration: 480, error: null } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto("http://127.0.0.1:3021/playback-performance", { waitUntil: "domcontentloaded" });
  console.log("Dashboard loaded");
  await page.getByRole("button", { name: /Play 480 unread headlines in full screen/ }).click();
  await page.locator(".headline-player-title").waitFor();
  await page.waitForFunction(() => { const audio = document.querySelector(".screen-off-audio-controls audio"); return audio && !audio.paused && audio.buffered.length && audio.buffered.end(audio.buffered.length - 1) > 20; });
  await page.evaluate(() => { document.querySelector(".screen-off-audio-controls audio").playbackRate = .1; });
  console.log("Playback opened");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.evaluate(() => {
    window.feedMutations = 0;
    const feed = document.querySelector(".story-list");
    if (feed) new MutationObserver(records => { window.feedMutations += records.length; }).observe(feed, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const samples = [];
  for (const direction of [...Array(16).fill("Next headline"), ...Array(8).fill("Previous headline"), ...Array(8).fill("Next headline")]) {
    samples.push(await page.evaluate(async name => {
      const button = document.querySelector(`[aria-label="${name}"]`);
      button.focus();
      const started = performance.now();
      button.click();
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ]);
      const audio = document.querySelector(".screen-off-audio-controls audio");
      return { ms: performance.now() - started, focusKept: document.activeElement === button, title: document.querySelector(".headline-player-title")?.textContent, paused: audio?.paused, time: audio?.currentTime };
    }, direction));
    if (samples.length % 8 === 0) console.log(`Measured ${samples.length} navigation actions`);
  }
  const stats = await page.evaluate(() => ({ feedMutations: window.feedMutations, savedReads: window.savedHeadlineReads.size }));
  const sorted = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const result = { cpuSlowdown: 4, stories: 480, moves: samples.length, medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]), p95Ms: Math.round(sorted[Math.floor(sorted.length * .95)]), maxMs: Math.round(sorted.at(-1)), focusLosses: samples.filter(sample => !sample.focusKept).length, marketRequests: market.length, ...stats };
  console.log(JSON.stringify(result));
  if (!measureOnly) {
    assert.equal(result.focusLosses, 0, "Reading a title must not reset focus/scroll locking");
    assert.equal(result.feedMutations, 0, "Headline navigation must not rebuild the hidden feed");
    assert.ok(result.p95Ms < 500, `Navigation must stay responsive at 4x CPU slowdown: ${result.p95Ms} ms`);
    assert.ok(result.marketRequests <= 4, "Revisiting unavailable topics must reuse their cooldown");
  }
  assert.equal(stats.savedReads, 17, "Visited headlines are persisted once; back/forward does not consume extra stories");
  await page.getByRole("button", { name: "Close headline playback", exact: true }).click();
  await page.locator(".headline-player").waitFor({ state: "detached" });
  await page.getByRole("button", { name: /Play 463 unread headlines in full screen/ }).waitFor();
  assert.equal(await page.evaluate(() => Array.from(window.headlineReadCalls.values()).every(count => count === 1)), true,
    "Applying the pending feed updates must not persist any headline twice");
  assert.deepEqual(errors, []);
  console.log("PASS responsive recorded navigation, shared lookups, exact read persistence and unread counts after returning to news");
  await page.close();
} finally { await browser?.close(); await server.close(); }
