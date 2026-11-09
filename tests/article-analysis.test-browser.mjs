import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: "work/article-analysis-vite-cache",
  plugins: [react(), { name: "article-analysis-check", configureServer(server) {
    server.middlewares.use("/analysis-test", async (_request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(await server.transformIndexHtml("/analysis-test", '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/tests/article-analysis.fixture.tsx"></script></body></html>'));
    });
    server.middlewares.use("/api/", (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "auth/csrf" || request.url === "/auth/csrf") {
        response.setHeader("Set-Cookie", "analysis-csrf=session; HttpOnly; SameSite=Strict; Path=/");
        return response.end(JSON.stringify({ token: "analysis-token" }));
      }
      if (request.method !== "POST" || request.headers["x-xsrf-token"] !== "analysis-token" || !request.headers.cookie?.includes("analysis-csrf=session")) {
        response.statusCode = 400; return response.end(JSON.stringify({ error: "A valid session and security token are required." }));
      }
      const result = request.url.includes("sentiment") ? { sentiment: "positive", positiveScore: 0.9, neutralScore: 0.1, negativeScore: 0 }
        : request.url.includes("keyphrases") ? { keyPhrases: ["Science and technology research"] } : { entities: [] };
      response.end(JSON.stringify({ available: true, ...result }));
    });
  } }],
  optimizeDeps: { entries: ["tests/article-analysis.fixture.tsx"], include: ["react", "react-dom/client"] },
  server: { host: "127.0.0.1", port: 3017, strictPort: true, watch: { ignored: ["**/work/**", "**/Signal.Server/**", "**/Signal.Server.TopicMatcher.Tests/**", "**/iis-publish/**"] } }
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultNavigationTimeout(90000);
    const errors = [], failedResponses = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => { if (response.url().includes("/api/") && response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });
    await page.goto("http://127.0.0.1:3017/analysis-test");
    await page.getByText("Science and technology research", { exact: true }).waitFor();
    await page.locator(".article-sentiment-pill").getByText("Positive", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(failedResponses, [], "Article analysis must send the session cookie and security token, without 400/429 responses");
    await page.close();
    console.log(`PASS article sentiment and key phrases with CSRF at ${width}px`);
  }
} finally { await browser?.close(); await server.close(); }
