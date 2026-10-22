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
}], optimizeDeps: { entries: ["tests/earthquake-alerts.fixture.tsx"] }, server: { host: "127.0.0.1", port: 0,
  watch: { ignored: ["**/Signal.Server/wwwroot/**", "**/iis-publish/**"] } } });
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
    window.azurePlays = [];
    window.azurePauses = 0;
    window.browserSpeechCalls = 0;
    window.blockSpeech = false;
    window.denyLocation = false;
    Object.defineProperty(navigator, "geolocation", { value: {
      getCurrentPosition(success, error) {
        if (window.denyLocation) error({ code: 1 });
        else success({ coords: { latitude: -41.2865, longitude: 174.7762 } });
      },
    } });
    localStorage.setItem("signal.recorded-reading-voices.v1", JSON.stringify({ en: "en-NZ-MollyNeural", zh: "" }));
    window.Audio = class {
      src = "";
      play() {
        window.azurePlays.push(this.src);
        if (window.blockSpeech) return Promise.reject(new DOMException("Tap to play", "NotAllowedError"));
        this.onplaying?.();
        return Promise.resolve();
      }
      pause() { window.azurePauses++; }
      removeAttribute(name) { if (name === "src") this.src = ""; }
      load() {}
    };
    Object.defineProperty(window, "speechSynthesis", { value: {
      cancel() {}, speak() { window.browserSpeechCalls++; },
    } });
  });
  const requests = [];
  const audioRequests = [];
  let events = [];
  let failDelete = false;
  let failAzure = false;
  let holdAudio = false;
  let receivedHeldAudio;
  const heldAudioReceived = new Promise(resolve => { receivedHeldAudio = resolve; });
  let releaseHeldAudio;
  const heldAudio = new Promise(resolve => { releaseHeldAudio = resolve; });
  let finishHeldAudio;
  const heldAudioFinished = new Promise(resolve => { finishHeldAudio = resolve; });
  await page.route("**/api/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/api/auth/csrf") return route.fulfill({ json: { token: "earthquake-csrf" } });
    if (path === "/api/article-audio-stream") {
      audioRequests.push({ body: req.postDataJSON(), csrf: req.headers()["x-xsrf-token"] });
      if (failAzure) return route.fulfill({ status: 503, json: { error: "Azure unavailable" } });
      if (holdAudio) { receivedHeldAudio(); await heldAudio; }
      const url = `/api/article-audio-stream/${audioRequests.length.toString(16).padStart(32, "0")}`;
      await route.fulfill({ json: { url, statusUrl: `${url}/status` } }).catch(() => {});
      if (holdAudio) finishHeldAudio();
      return;
    }
    if (path.endsWith("/status")) return route.fulfill({ json: { starts: [], complete: false, duration: 0, error: null } });
    requests.push({ method: req.method(), body: req.postDataJSON(), csrf: req.headers()["x-xsrf-token"] });
    if (req.method() === "DELETE") return route.fulfill({ status: failDelete ? 503 : 204, ...(failDelete ? { json: { error: "offline" } } : {}) });
    if (req.method() === "PUT") return route.fulfill({ json: { backgroundPush: false } });
    return route.fulfill({ json: { events, checkedAtUtc: new Date().toISOString(), source: "GeoNet" } });
  });
  const origin = server.resolvedUrls.local[0];
  await page.goto(`${origin}earthquake-test`);
  const openSettings = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
  };
  await openSettings();
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).waitFor();
  assert.equal(requests.length, 0, "Disabled monitoring must not request location or a feed.");
  assert.equal(audioRequests.length, 0);
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).click();
  await page.getByText(/GeoNet checked at/).waitFor();
  assert.equal(requests[0].body.latitude, -41.2865);
  assert.equal(requests[0].body.longitude, 174.7762);
  assert.equal(requests[0].csrf, "earthquake-csrf");
  assert.equal(requests[0].body.minimumMagnitude, 4);
  await page.getByText(/Reading earthquake alert with Azure voice/).waitFor();
  assert.equal(audioRequests[0].csrf, "earthquake-csrf");
  assert.equal(audioRequests[0].body.voices.en, "en-NZ-MollyNeural");
  assert.equal(audioRequests[0].body.language, "en-NZ");
  events = [{ id: "geonet:test", source: "GeoNet", magnitude: 4.8, place: "Near Wellington", timeUtc: new Date().toISOString(),
    distanceKm: 42, depthKm: 12, url: "https://www.geonet.org.nz/earthquake/test" }];
  await page.getByRole("button", { name: "Check now", exact: true }).click();
  const alert = page.getByRole("alertdialog", { name: "Earthquake detected", exact: true });
  await alert.waitFor();
  assert.equal(await alert.evaluate(element => element.matches(":modal")), true, "Earthquake alert takes the modal top layer above Settings.");
  assert.equal(await page.evaluate(() => document.activeElement?.closest(".earthquake-alert") !== null), true);
  await page.getByText(/Reading earthquake alert with Azure voice/).waitFor();
  assert.match(audioRequests.at(-1).body.titles.join(" "), /Magnitude 4.8.*42 kilometres/);
  const speechCount = audioRequests.length;
  const duplicateCheck = page.waitForResponse(response => response.url().includes("/api/earthquakes/devices/") && response.request().method() === "GET");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await duplicateCheck;
  assert.equal(audioRequests.length, speechCount, "Do not repeat Azure requests for the same event.");
  await mkdir("work/earthquake-check", { recursive: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    const bounds = await alert.boundingBox();
    assert.ok(Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1 && Math.abs(bounds.width - viewport.width) < 1 && Math.abs(bounds.height - viewport.height) < 1,
      `Alert fills the entire ${viewport.width}×${viewport.height} viewport.`);
    await page.screenshot({ path: `work/earthquake-check/fullscreen-${viewport.width}.png` });
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.closest(".earthquake-alert") !== null), true, "Keyboard focus stays in the alert.");
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "Phone UI must not overflow.");
  await page.evaluate(() => { window.blockSpeech = true; });
  await page.getByRole("button", { name: "Read alert", exact: true }).click();
  await page.getByText(/Tap Read alert or Test voice/).waitFor();
  const blockedRequests = audioRequests.length;
  const blockedSource = await page.evaluate(() => window.azurePlays.at(-1));
  await page.evaluate(() => { window.blockSpeech = false; });
  await page.getByRole("button", { name: "Read alert", exact: true }).click();
  await page.getByText(/Reading earthquake alert with Azure voice/).waitFor();
  assert.equal(audioRequests.length, blockedRequests, "A tap retries the already prepared Azure media without another synthesis.");
  assert.equal(await page.evaluate(() => window.azurePlays.at(-1)), blockedSource);
  failAzure = true;
  await alert.getByRole("button", { name: "Read alert", exact: true }).click();
  await page.getByText(/Azure voice is unavailable/).waitFor();
  assert.equal(await alert.count(), 1);
  assert.equal(await page.evaluate(() => window.browserSpeechCalls), 0, "Azure failures must not silently switch to browser speech.");
  failAzure = false;
  holdAudio = true;
  const playsBeforeCancel = await page.evaluate(() => window.azurePlays.length);
  await alert.getByRole("button", { name: "Read alert", exact: true }).click();
  await heldAudioReceived;
  await alert.getByRole("button", { name: "Stop voice", exact: true }).click();
  releaseHeldAudio();
  await heldAudioFinished;
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await page.evaluate(() => window.azurePlays.length), playsBeforeCancel, "Stopping voice cancels pending preparation and prevents late playback.");
  holdAudio = false;
  const requestsBeforeReload = audioRequests.length;
  await page.reload();
  await openSettings();
  await page.getByText(/GeoNet checked at/).waitFor();
  assert.equal(audioRequests.length, requestsBeforeReload, "Reload must retain event deduplication.");
  assert.equal(await page.evaluate(() => window.azurePlays.length), 0);
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
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  const deviceRequestsBeforePreview = requests.length;
  const previewButton = page.getByRole("button", { name: "Preview full-screen alert", exact: true });
  await previewButton.click();
  const preview = page.getByRole("alertdialog", { name: "Test earthquake alert", exact: true });
  await preview.waitFor();
  await preview.getByText("Preview only · no earthquake detected", { exact: true }).waitFor();
  assert.equal(requests.length, deviceRequestsBeforePreview, "Preview does not enable or register monitoring.");
  await preview.getByRole("button", { name: "Dismiss alert", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  assert.equal(await previewButton.evaluate(element => element === document.activeElement), true, "Dismissing restores focus to Settings.");
  await previewButton.click();
  await preview.waitFor();
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("dialog", { name: "Settings", exact: true }).isVisible(), true, "Escape only dismisses the top alert.");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Open player full screen", exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  const playerRequest = page.waitForResponse(response => response.url().includes("/api/earthquakes/devices/") && response.request().method() === "GET");
  // Re-enable with a new report to check coverage above a native-fullscreen player.
  await page.evaluate(() => document.exitFullscreen());
  await openSettings();
  events = [];
  await page.evaluate(() => { window.denyLocation = false; });
  await page.getByRole("button", { name: "Enable earthquake alerts", exact: true }).click();
  await playerRequest;
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Open player full screen", exact: true }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  events = [{ id: "geonet:player-test", source: "GeoNet", magnitude: 5.2, place: "Player test location", timeUtc: new Date().toISOString(), distanceKm: 30, depthKm: 12, url: "https://www.geonet.org.nz/earthquake/test" }];
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await alert.waitFor();
  assert.equal(await alert.evaluate(element => document.fullscreenElement?.contains(element)), true, "Alert remains visible inside native fullscreen.");
  const playerBounds = await alert.boundingBox();
  const playerViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(playerBounds.x === 0 && playerBounds.y === 0 && playerBounds.width === playerViewport.width && playerBounds.height === playerViewport.height);
  await alert.getByRole("button", { name: "Dismiss alert", exact: true }).click();
  await alert.waitFor({ state: "hidden" });
  await page.evaluate(() => document.exitFullscreen());
  assert.deepEqual(errors, []);
  console.log("Earthquake checks passed: full-screen modal above Settings and native-fullscreen player, phone/desktop/landscape coverage, focus trapping and restoration, marked preview, dismissal, Azure narration, failures, cancellation, GPS and deduplication.");
} finally { await browser?.close(); await server.close(); }
