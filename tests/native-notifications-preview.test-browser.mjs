import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SIGNAL_PLAYWRIGHT_MODULE || 'playwright');
let ready = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/native/status') {
    res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ready }));
  }
  const file = path.endsWith('support.css') ? 'public/signalwatch/support.css' : 'public/signalwatch/native-preview/index.html';
  res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = 'http://127.0.0.1:' + server.address().port + '/signalwatch/native-preview/';
  await page.goto(url);
  await page.getByText(/Background push is not activated on this server yet/).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Download watch APK' }).getAttribute('href'), 'SignalWatch-release.apk');
  assert.equal(await page.getByRole('link', { name: 'Download phone APK' }).getAttribute('href'), 'SignalCompanion-release.apk');
  assert.ok(await page.getByRole('heading', { name: 'Notification privacy' }).count());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir('work/native-notifications', { recursive: true });
  await page.screenshot({ path: 'work/native-notifications/setup-mobile.png', fullPage: true });
  ready = true;
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.reload();
  await page.getByText(/Background push is configured/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: native preview shows configuration status, separate phone/watch downloads, setup and privacy on mobile/desktop.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
