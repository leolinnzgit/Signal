import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: "earthquake-test-page", configureServer(server) {
    server.middlewares.use("/earthquake-test", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml("/earthquake-test", '<html><head></head><body><div id="root"></div><script type="module" src="/tests/earthquake-alerts.fixture.tsx"></script></body></html>'));
    });
  },
}], optimizeDeps: { entries: ["tests/earthquake-alerts.fixture.tsx"] }, server: { host: "127.0.0.1", port: 0 } });
await server.listen();
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.SIGNAL_BROWSER_CHANNEL || "msedge" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    window.spoken = [];
    window.blockSpeech = false;
    window.denyLocation = false;
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition(success, error) {
        if (window.denyLocation) error({ code: 1 });
        else success({ coords: { latitude: -41.2865, longitude: 174.7762 } });
      },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, "speechSynthesis", { value: {
      cancel() {}, speak(u) { window.spoken.push(u.text); if (window.blockSpeech) u.onerror?.({ error: "not-allowed" }); else u.onstart?.(); },
    } });
  });
  const requests = [];
  let events = [];
  let failDelete = false;
  await page.route("**/api/**", route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/csrf") return route.fulfill({ json: { token: "earthquake-csrf" } });
    requests.push({ method: req.method(), body: req.postDataJSON(), csrf: req.headers()["x-xsrf-token"] });
    if (req.method() === "DELETE") return route.fulfill({ status: failDelete ? 503 : 204, ...(failDelete ? { json: { error: "offline" } } : {}) });
    if (req.method() === "PUT") return route.fulfill({ json: { backgroundPush: false } });
    return route.fulfill({ json: { events, checkedAtUtc: new Date().toISOString(), source: "GeoNet" } });
  });
  const origin = server.resolvedUrls.local[0];
  await page.goto(`${origin}earthquake-test`);
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).waitFor();
  assert.equal(requests.length, 0, "Disabled monitoring must not request location or a feed.");
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).click();
  await page.getByText(/GeoNet checked at/).waitFor();
  assert.equal(requests[0].body.latitude, -41.2865);
  assert.equal(requests[0].body.longitude, 174.7762);
  assert.equal(requests[0].csrf, "earthquake-csrf");
  assert.equal(requests[0].body.minimumMagnitude, 4);
  events = [{ id: "geonet:test", source: "GeoNet", magnitude: 4.8, place: "Near Wellington", timeUtc: new Date().toISOString(),
    distanceKm: 42, depthKm: 12, url: "https://www.geonet.org.nz/earthquake/test" }];
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await page.getByRole("alert", { name: "Earthquake detected" }).waitFor();
  assert.match((await page.evaluate(() => window.spoken)).at(-1), /Magnitude 4.8.*42 kilometres/);
  const speechCount = await page.evaluate(() => window.spoken.length);
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await page.getByText(/GeoNet checked at/).waitFor();
  assert.equal(await page.evaluate(() => window.spoken.length), speechCount, "Do not repeat voice alerts for the same event.");
  await mkdir("work/earthquake-check", { recursive: true });
  await page.screenshot({ path: "work/earthquake-check/mobile.png", fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Phone UI must not overflow.");
  await page.evaluate(() => { window.blockSpeech = true; });
  await page.getByRole("button", { name: "Read alert", exact: true }).click();
  await page.getByText(/Tap Read alert or Test voice/).waitFor();
  await page.reload();
  await page.getByText(/GeoNet checked at/).waitFor();
  assert.equal(await page.evaluate(() => window.spoken.length), 0, "Reload must retain event deduplication.");
  await page.evaluate(() => { window.denyLocation = true; });
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  await page.getByText(/Location blocked/).waitFor();
  failDelete = true;
  await page.getByRole("button", { name: "Turn off earthquake alerts", exact: true }).click();
  await page.getByText(/Could not turn off background alerts/).waitFor();
  failDelete = false;
  await page.getByRole("button", { name: "Turn off earthquake alerts", exact: true }).click();
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).waitFor();
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(requests.at(-1).csrf, "earthquake-csrf");
  assert.equal(await page.getByRole("alert").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Earthquake phone checks passed: GPS, CSRF, detection, voice, deduplication, blocked audio/location, disable retry, mobile layout.");
} finally { await browser?.close(); await server.close(); }
