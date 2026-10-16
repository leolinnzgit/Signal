import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/briefing-market-vite-cache", plugins: [react(), {
  name: "briefing-market-test",
  configureServer(server) {
    server.middlewares.use("/briefing-test", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml("/briefing-test", '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/briefing-market.fixture.tsx"></script></body></html>'));
    });
  },
}], optimizeDeps: { entries: ["tests/briefing-market.fixture.tsx"], include: ["react", "react-dom", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 3016, strictPort: true, watch: { ignored: ["**/work/**", "**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });

const quotes = {
  nvidia: { symbol: "NVDA", name: "NVIDIA Corporation", price: 189.32 },
  microsoft: { symbol: "MSFT", name: "Microsoft Corporation", price: 522.48 },
  apple: { symbol: "AAPL", name: "Apple Inc.", price: 245.67 },
};
const wav = Buffer.alloc(44 + 40 * 32000);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);

await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const scenario of ["browser", "recorded", "override", "selected", "stale", "dashboard"]) {
    for (const width of scenario === "browser" || scenario === "recorded" ? [1280, 390] : [1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(20000);
      const errors = [], requests = [];
      let releaseMicrosoft;
      const microsoftGate = new Promise(resolve => { releaseMicrosoft = resolve; });
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem("signal.weather-audio-on-open.v1", "false");
        localStorage.setItem("signal-news-preferences", JSON.stringify({ topics: ["NVIDIA"], sources: { google: true, gdelt: false, rssFeeds: [] }, tickerOverrides: { NVIDIA: "NVDA" } }));
        const synth = { speaking: false, pending: false, paused: false, getVoices: () => [],
          addEventListener() {}, removeEventListener() {}, pause() {}, resume() {},
          cancel() { synth.speaking = false; },
          speak(utterance) { window.currentHeadline = utterance; synth.speaking = true; utterance.onstart?.(); },
        };
        Object.defineProperty(window, "speechSynthesis", { value: synth });
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        window.finishHeadline = () => { synth.speaking = false; window.currentHeadline.onend?.(); };
      });
      await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "127.0.0.1") return route.abort();
        if (url.pathname === "/api/market") {
          const topic = url.searchParams.get("topic").toLowerCase();
          requests.push({ topic, symbol: url.searchParams.get("symbol") });
          if (scenario === "stale" && topic === "microsoft") await microsoftGate;
          const quote = quotes[topic];
          return route.fulfill({ json: quote ? { matched: true, quote: { ...quote, topic, exchange: "NASDAQ", currency: "USD", change: -2.31, percentChange: -1.21, isMarketOpen: false, quoteTime: "2026-10-16 16:00", provider: "Test data" } } : { matched: false, status: "not-found" } }).catch(() => {});
        }
        if (url.pathname === "/api/headline-audio/voices") return route.fulfill({ json: [] });
        if (url.pathname === "/api/auth/csrf") return route.fulfill({ json: { token: "test" } });
        if (url.pathname === "/api/headline-audio") return route.fulfill({ body: wav, headers: { "Content-Type": "audio/wav", "X-Signal-Headline-Starts": "[0,6,12,18,24,30]" } });
        if (url.pathname === "/api/news") return route.fulfill({ json: { topic: "NVIDIA", provider: "google", fetchedAt: new Date().toISOString(), articles: [{ title: "NVIDIA announces new chips", url: "https://example.com/0", source: "Test news", summary: "Test article", publishedAt: new Date().toISOString() }] } });
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
        return route.continue();
      });
      await page.goto(`http://127.0.0.1:3016/briefing-test?${scenario}`);
      await page.getByRole("button", { name: scenario === "dashboard" ? /Play .*unread headlines in full screen/ : "Start briefing" }).click();
      const dialog = page.getByRole("dialog", { name: "Unread headline playback" });
      const market = dialog.locator(".briefing-market-price");
      await page.waitForFunction(() => document.querySelector(".briefing-market-price")?.textContent.includes("189.32"));
      assert.match(await market.innerText(), /NVDA[\s\S]*USD[\s\S]*-1\.21%/);
      assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), "Fits the viewport");
      if (scenario === "override" || scenario === "dashboard") assert.ok(requests.some(request => request.topic === "nvidia" && request.symbol === (scenario === "dashboard" ? "NVDA" : "NVDA:NASDAQ")), "Uses the saved ticker, including from All topics");
      const advance = async index => {
        if (scenario === "recorded" || scenario === "dashboard") {
          await page.waitForFunction(() => document.querySelector(".screen-off-audio-controls audio")?.readyState >= 2);
          await dialog.locator("audio").first().evaluate((audio, index) => { audio.currentTime = index * 6 + 0.1; audio.dispatchEvent(new Event("timeupdate")); }, index);
        } else await page.keyboard.press("ArrowRight");
      };
      if (scenario === "browser") {
        await dialog.getByLabel("Seconds per title").selectOption("3");
        await page.waitForFunction(() => window.currentHeadline?.text.includes("NVIDIA"));
        await page.evaluate(() => window.finishHeadline());
      } else if (scenario !== "dashboard") await advance(1);
      if (scenario === "selected") {
        await page.waitForFunction(() => document.querySelector(".headline-player-title")?.textContent.includes("Microsoft"));
        assert.match(await market.innerText(), /NVDA/);
      } else if (scenario !== "dashboard") {
        if (scenario !== "stale") await page.waitForFunction(() => document.querySelector(".briefing-market-price")?.textContent.includes("522.48"));
        else await page.waitForFunction(() => document.querySelector(".headline-player-title")?.textContent.includes("Microsoft"));
        await advance(2);
        if (scenario === "stale") releaseMicrosoft();
        await page.waitForFunction(() => !document.querySelector(".briefing-market-price"));
        await advance(3);
        await page.waitForFunction(() => document.querySelector(".briefing-market-price")?.textContent.includes("245.67"));
        assert.equal(requests.filter(request => request.topic === "science").length, 1, "Caches unmatched topics while trying the next topic");
        const nvidiaRequests = requests.filter(request => request.topic === "nvidia").length;
        await advance(4);
        await page.waitForFunction(() => document.querySelector(".briefing-market-price")?.textContent.includes("189.32"));
        assert.equal(requests.filter(request => request.topic === "nvidia").length, nvidiaRequests, "Reuses quotes for repeat topics");
      }
      await page.screenshot({ path: `work/briefing-market-${scenario}-${width}.png` });
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${scenario} ${width}px`);
    }
  }
} finally { await browser?.close(); await server.close(); }
