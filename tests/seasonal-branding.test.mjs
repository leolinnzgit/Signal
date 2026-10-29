import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/seasonal-branding.js', import.meta.url), 'utf8');
const calendar = JSON.parse(await readFile(new URL('../public/seasonal-calendar.json', import.meta.url), 'utf8')).chineseNewYear;
function setup(initial, path = '/', search = '') {
  let now = initial, callback, visibility, delay;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const favicon = {}, document = { documentElement: { dataset: {} }, hidden: false,
    querySelector: () => favicon, addEventListener: (_name, fn) => { visibility = fn; } };
  const context = { Date: Clock, URLSearchParams, document, location: { pathname: path, search },
    setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() {} };
  vm.runInNewContext(source, context);
  return { context, favicon, document, setDate(value) { now = value; }, midnight() { callback(); }, foreground() { visibility(); }, get delay() { return delay; } };
}
const local = value => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const forDate = date => setup(date).context.SignalSeasons.forDate(date);

test('fixed holiday windows include their endpoints and restore the standard theme', () => {
  for (let year = 2026; year <= 2040; year++) {
    for (const [suffix, expected] of [['09-30', 'standard'], ['10-01', 'halloween'], ['10-31', 'halloween'], ['11-01', 'standard'], ['11-30', 'standard'], ['12-01', 'christmas'], ['12-26', 'christmas'], ['12-27', 'new-year'], ['12-31', 'new-year'], ['01-01', 'new-year'], ['01-07', 'new-year'], ['01-08', 'standard']]) {
      assert.equal(forDate(local(`${year}-${suffix}`)), expected, `${year}-${suffix}`);
    }
  }
});
test('Chinese New Year follows each checked lunar date, from eve through day fifteen', () => {
  assert.equal(calendar[2027], '2027-02-06');
  for (const start of Object.values(calendar)) {
    for (const [offset, expected] of [[-2, 'standard'], [-1, 'chinese-new-year'], [0, 'chinese-new-year'], [14, 'chinese-new-year'], [15, 'standard']]) {
      const date = local(start); date.setDate(date.getDate() + offset);
      assert.equal(forDate(date), expected, `${start}, offset ${offset}`);
    }
  }
  assert.equal(forDate(local('2027-02-17')), 'chinese-new-year');
  assert.equal(forDate(local('2026-02-17')), 'chinese-new-year');
  assert.equal(forDate(local('2028-02-17')), 'standard');
});
test('midnight and foreground refresh update the season and restore the normal favicon', () => {
  const fixture = setup(new Date(2026, 11, 26, 23, 59, 59));
  assert.equal(fixture.document.documentElement.dataset.season, 'christmas');
  assert.ok(fixture.delay >= 1000 && fixture.delay < 2000);
  fixture.setDate(new Date(2026, 11, 27)); fixture.midnight();
  assert.equal(fixture.document.documentElement.dataset.season, 'new-year');
  fixture.setDate(new Date(2027, 0, 8)); fixture.foreground();
  assert.equal(fixture.document.documentElement.dataset.season, 'standard');
  assert.equal(fixture.favicon.href, '/icons/signal-medallion-64.png');
  assert.equal(fixture.favicon.type, 'image/png');
});
test('URL theme previews apply only to the public sample watch, and reject unknown themes', () => {
  for (const season of ['standard', 'halloween', 'christmas', 'new-year', 'chinese-new-year']) {
    const fixture = setup(local('2026-11-12'), '/signalwatch/', `?theme=${season}`);
    assert.equal(fixture.document.documentElement.dataset.season, season);
    assert.equal(fixture.favicon.type, season === 'standard' ? 'image/png' : 'image/svg+xml');
    for (const path of ['/', '/signalwatch/connect.html', '/signalwatch/privacy.html']) {
      assert.equal(setup(local('2026-11-12'), path, `?theme=${season}`).document.documentElement.dataset.season, 'standard');
    }
  }
  assert.equal(setup(local('2026-10-29'), '/signalwatch/', '?theme=unknown').document.documentElement.dataset.season, 'halloween');
});
test('the embedded offline calendar matches the canonical source', () => {
  const embedded = source.match(/const chineseNewYear = (\{[\s\S]*?\});/)[1];
  assert.deepEqual(JSON.parse(embedded), calendar);
});
test('the offline shell includes every seasonal mark', async () => {
  const worker = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  for (const season of ['halloween', 'christmas', 'new-year', 'chinese-new-year']) {
    assert.ok(worker.includes(`/icons/signal-${season}.svg`));
    await readFile(new URL(`../public/icons/signal-${season}.svg`, import.meta.url));
  }
});
