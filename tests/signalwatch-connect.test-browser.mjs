import {previewHandler} from './preview-assets.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SIGNAL_PLAYWRIGHT_MODULE || 'playwright');
let signedIn = false, approvalCalls = 0, rejectApproval = false;
let expectedBrowserEndpoint = null;
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (['/seasonal-branding.js', '/signalwatch/halloween.css', '/icons/signal-halloween.svg'].includes(pathname)) return previewHandler('')(req, res);
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (pathname === '/api/auth/me') return json(signedIn ? 200 : 401, signedIn ? { email: 'reviewer@example.invalid' } : {});
  if (pathname === '/api/auth/csrf') return json(200, { token: 'test-csrf' });
  if (pathname === '/api/watch/pairing/approve') {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.headers['x-xsrf-token'], 'test-csrf');
    assert.deepEqual(JSON.parse(body), { code: 'ABCDEFGH', browserEndpoint: expectedBrowserEndpoint });
    approvalCalls++;
    return json(rejectApproval ? 404 : 200, rejectApproval ? { error: 'That code is unavailable or expired.' } : { status: 'approved' });
  }
  const name = pathname.split('/').pop() || 'connect.html';
  if (!['connect.html', 'connect.js', 'support.css', 'privacy.html', 'data-deletion.html'].includes(name)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(new URL('../public/signalwatch/' + name, import.meta.url)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin + '/signalwatch/connect.html?code=ABCD-EFGH');
  await page.getByText('Sign in to Signal to approve your watch.', { exact: true }).waitFor();
  assert.equal(await page.locator('#code').inputValue(), 'ABCD-EFGH');
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await page.locator('#approve').isDisabled(), true);
  assert.equal(approvalCalls, 0);
  signedIn = true;
  await page.getByRole('button', { name: 'I have signed in' }).click();
  await page.getByText('Approve as reviewer@example.invalid', { exact: true }).waitFor();
  assert.equal(approvalCalls, 0, 'Reading an approval URL must never approve a watch.');
  await page.locator('#code').fill('ABC');
  await page.getByRole('button', { name: 'Approve this watch' }).click();
  await page.getByText('Enter the eight characters displayed on your watch.').waitFor();
  assert.equal(approvalCalls, 0);
  await page.locator('#code').fill('ABCD-EFGH');
  await page.getByRole('button', { name: 'Approve this watch' }).click();
  await page.getByText('Watch approved. Your watch will connect in a few seconds.').waitFor();
  assert.equal(approvalCalls, 1);
  rejectApproval = true;
  await page.goto(origin + '/signalwatch/connect.html?code=ABCD-EFGH');
  await page.getByText('Approve as reviewer@example.invalid').waitFor();
  await page.getByRole('button', { name: 'Approve this watch' }).click();
  await page.getByText('That code is unavailable or expired.').waitFor();
  rejectApproval = false;
  await page.addInitScript(() => {
    const subscribed = new URL(location.href).searchParams.get('subscription') !== 'missing';
    Object.defineProperty(navigator, 'serviceWorker', { value: {
      getRegistration: async () => subscribed ? { pushManager: { getSubscription: async () => ({ endpoint: 'https://push.invalid/this-phone' }) } } : undefined
    } });
  });
  expectedBrowserEndpoint = 'https://push.invalid/this-phone';
  await page.goto(origin + '/signalwatch/connect.html?code=ABCD-EFGH&device=phone');
  await page.getByRole('heading', { name: 'Connect your phone companion.' }).waitFor();
  assert.equal(await page.locator('#replace-browser').isChecked(), true);
  const beforePhoneApproval = approvalCalls;
  await page.getByRole('button', { name: 'Approve this phone companion' }).click();
  await page.getByText(/Phone companion approved/).waitFor();
  assert.equal(approvalCalls, beforePhoneApproval + 1, 'A phone companion must explicitly link only this browser subscription.');
  await page.goto(origin + '/signalwatch/connect.html?code=ABCD-EFGH&device=phone&subscription=missing');
  await page.getByText('Approve as reviewer@example.invalid').waitFor();
  await page.getByRole('button', { name: 'Approve this phone companion' }).click();
  await page.getByText(/Open this link in the browser/).waitFor();
  assert.equal(approvalCalls, beforePhoneApproval + 1, 'Missing browser subscription must never silently claim duplicate suppression.');
  expectedBrowserEndpoint = null;
  await page.locator('#replace-browser').uncheck();
  await page.getByRole('button', { name: 'Approve this phone companion' }).click();
  await page.getByText(/Phone companion approved/).waitFor();
  await mkdir('work/signalwatch-release', { recursive: true });
  await page.screenshot({ path: 'work/signalwatch-release/phone-pairing.png', fullPage: true });
  for (const name of ['privacy.html', 'data-deletion.html']) {
    await page.goto(origin + '/signalwatch/' + name);
    assert.ok(await page.getByRole('link', { name: 'leolinnz@gmail.com', exact: true }).count());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: watch and phone approvals require sign-in, CSRF and explicit confirmation; per-browser linking, missing subscription, expired codes and privacy pages verified.');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
