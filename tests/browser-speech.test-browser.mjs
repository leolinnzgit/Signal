// Set SIGNAL_PLAYWRIGHT_MODULE to a Playwright module URL when it is supplied by the host.
import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const { chromium } = await import(process.env.SIGNAL_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [react(), {
  name: "speech-test-page",
  configureServer(server) {
    server.middlewares.use("/speech-test", async (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(await server.transformIndexHtml('/speech-test', '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/browser-speech.fixture.tsx"></script></body></html>'));
    });
  },
}], server: { host: "127.0.0.1", port: 3014, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, ...(process.env.SIGNAL_BROWSER_CHANNEL ? { channel: process.env.SIGNAL_BROWSER_CHANNEL } : {}) });
try {
  for (const device of ["android", "iphone", "ipad", "desktop"]) {
    const mobile = device !== "desktop";
    const userAgent = {
      android: "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile Safari/537.36",
      iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1",
      ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/18.0 Safari/605.1.15",
      desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36",
    }[device];
    const page = await browser.newPage({ userAgent, hasTouch: mobile, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(({ mobile }) => {
      Object.defineProperty(navigator, "maxTouchPoints", { value: mobile ? 5 : 0 });
      let inGesture = false;
      let unlocked = !mobile;
      let voicesLoaded = !mobile;
      const voice = { name: "Device English", voiceURI: "device", lang: "en-US", default: true };
      window.speechCalls = [];
      window.failNextSpeech = false;
      window.loadVoices = () => { voicesLoaded = true; };
      document.addEventListener("click", () => { inGesture = true; }, true);
      document.addEventListener("click", () => { inGesture = false; });
      const synth = {
        speaking: false, pending: false, getVoices: () => voicesLoaded ? [voice] : [],
        addEventListener() {}, removeEventListener() {},
        cancel() { synth.speaking = false; },
        pause() {}, resume() {},
        speak(utterance) {
          // Model WebKit's silent rejection until speech starts within a tap.
          if (mobile && !unlocked && !inGesture) { window.speechCalls.push({ blocked: true }); return; }
          if (inGesture) unlocked = true;
          window.speechCalls.push({ text: utterance.text, inGesture, rate: utterance.rate, voice: utterance.voice?.name });
          window.activeUtterance = utterance;
          if (window.failNextSpeech) { window.failNextSpeech = false; utterance.onerror?.(); return; }
          synth.speaking = true;
          utterance.onstart?.();
        },
      };
      Object.defineProperty(window, "speechSynthesis", { value: synth });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    }, { mobile });
    await page.goto("http://127.0.0.1:3014/speech-test");
    await page.getByRole("button", { name: mobile ? "Play" : "Pause", exact: true }).waitFor();
    if (mobile) {
      assert.equal(await page.evaluate(() => window.speechCalls.length), 0, "Phone waits for Play instead of silently blocked autoplay");
      // Tap while the voice catalog is still empty; it must not wait for the 500ms voice timer.
      await page.getByRole("button", { name: "Play", exact: true }).click();
    }
    await page.getByText("Reading article. Section 1 of 3.", { exact: true }).waitFor().catch(async error => { console.error(await page.locator("body").innerText(), await page.evaluate(() => window.speechCalls)); throw error; });
    let calls = await page.evaluate(() => window.speechCalls);
    assert.equal(calls.length, 1, "Effects must not cancel and restart the speech started by a tap");
    assert.ok(calls[0].text.startsWith("Clean energy news"));
    if (mobile) assert.equal(calls[0].inGesture, true);
    await page.evaluate(() => { window.speechSynthesis.speaking = false; window.activeUtterance.onend(); });
    await page.getByText("Reading article. Section 2 of 3.", { exact: true }).waitFor();
    await page.evaluate(() => window.activeUtterance.onerror());
    await page.getByRole("alert").waitFor();
    await page.getByLabel("Speaking speed", { exact: true }).selectOption("1.1");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByText("Reading article. Section 2 of 3.", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.speechCalls.at(-1).inGesture), true, "Error retry invokes speak directly from Play");
    assert.equal(await page.evaluate(() => window.speechCalls.at(-1).rate), 1.1, "Voice setting changes after an error still allow a fresh retry");
    await page.evaluate(() => { window.failNextSpeech = true; });
    await page.getByRole("button", { name: "Next section", exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByText("Reading article. Section 3 of 3.", { exact: true }).waitFor();
    await page.evaluate(() => { window.speechSynthesis.speaking = false; window.activeUtterance.onend(); });
    await page.getByText("Finished reading.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Read again", exact: true }).click();
    assert.equal(await page.evaluate(() => window.speechCalls.at(-1).inGesture), true, "Replay invokes speak directly from the tap");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    assert.equal(await page.evaluate(() => window.speechCalls.at(-1).inGesture), true);
    assert.equal(await page.evaluate(() => window.speechCalls.some(call => call.blocked)), false);
    assert.deepEqual(errors, []);
    console.log(`PASS ${device}: start with unloaded voices, automatic sections, error retry, replay and Stop/Play`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
