import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compile = async file => ts.transpileModule(await readFile(new URL('../app/' + file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;
const url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const { BriefingProgressClient, validateBriefingProgress, briefingProgressKey } =
  await import(url(await compile('briefing-progress.ts')));

const account = 'A'.repeat(64), email = 'owner@example.com';
const sampleDoc = {
  items: [
    { url: 'https://example.com/story-1', title: 'Story 1', source: 'Source 1', imageUrl: '', parts: ['Intro', 'Detail'], fullArticle: false },
    { url: 'https://example.com/story-2', title: 'Story 2', source: 'Source 2', imageUrl: '', parts: ['P1', 'P2', 'P3'], fullArticle: true }
  ],
  index: 0,
  partIndex: 1,
  shuffled: false,
  heard: ['https://example.com/story-1'],
  catchUpHeard: { 'https://example.com/story-1': 'f'.repeat(64) }
};

function setup() {
  let serial = 0, state = { accountKey: account, accountEmail: email, version: '0', state: 'empty', updatedAt: new Date().toISOString(), document: null }, online = true, last = null;
  const storage = () => { const map = new Map(); return { getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; };
  const fetcher = async (path, options = {}) => {
    if (!online) throw new Error('offline');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    if (path === '/api/auth/csrf') return Response.json({ token: 'csrf' });
    if (options.method === 'POST') {
      assert.equal(options.headers['X-XSRF-TOKEN'], 'csrf');
      const body = JSON.parse(options.body);
      if (body.accountKey !== state.accountKey) return new Response(null, { status: 403 });
      if (last?.operationId === body.operationId) return Response.json(state);
      if (body.baseVersion !== state.version) return Response.json(state, { status: 409 });
      last = body;
      state = { ...state, version: (++serial).toString(16).padStart(32, '0'), state: body.action === 'save' ? 'active' : body.action === 'forget' ? 'forgotten' : 'completed', document: body.document };
      return Response.json(state);
    }
    return Response.json(state);
  };
  return { fetcher, storage, setOnline: value => online = value, state: () => structuredClone(state), switchAccount() { state = { ...state, accountKey: 'B'.repeat(64), accountEmail: 'other@example.com' }; } };
}

test('briefing progress offline updates survive reopening and reject stale writer conflicts', async () => {
  const server = setup(), diskA = server.storage(), diskB = server.storage();
  let a = new BriefingProgressClient(email, diskA, () => {}, server.fetcher), b = new BriefingProgressClient(email, diskB, () => {}, server.fetcher);
  try {
    await a.sync(); await b.sync();
    a.begin('watch');
    a.report('watch', sampleDoc);
    await a.sync(); await b.sync();
    assert.equal(b.saved().index, 0);
    assert.equal(b.saved().partIndex, 1);

    server.setOnline(false);
    a.report('watch', { ...sampleDoc, index: 1, partIndex: 0 });
    await a.sync();
    a.dispose();

    a = new BriefingProgressClient(email, diskA, () => {}, server.fetcher);
    assert.equal(a.saved().index, 1);
    assert.equal(a.saved().partIndex, 0);

    server.setOnline(true);
    b.forget();
    await b.sync();
    assert.equal(server.state().state, 'forgotten');

    await a.sync();
    assert.equal(server.state().state, 'forgotten');
    assert.equal(a.saved(), null);
    assert.match(a.message, /Newer briefing progress/);
  } finally { a.dispose(); b.dispose(); }
});

test('completion marks briefing queue completed', async () => {
  const server = setup(), a = new BriefingProgressClient(email, server.storage(), () => {}, server.fetcher);
  try {
    await a.sync();
    a.begin('watch');
    a.report('watch', sampleDoc);
    await a.sync();
    a.finish('watch');
    await a.sync();
    assert.equal(server.state().state, 'completed');
    assert.equal(a.saved(), null);
  } finally { a.dispose(); }
});

test('briefing document validation enforces limits', () => {
  assert.throws(() => validateBriefingProgress({ accountKey: account, accountEmail: email, version: '0', state: 'active', updatedAt: new Date().toISOString(), document: { ...sampleDoc, index: 99 } }));
  assert.throws(() => validateBriefingProgress({ accountKey: account, accountEmail: email, version: '0', state: 'active', updatedAt: new Date().toISOString(), document: { ...sampleDoc, partIndex: 99 } }));
  assert.throws(() => validateBriefingProgress({ accountKey: 'bad', accountEmail: email, version: '0', state: 'empty', updatedAt: new Date().toISOString(), document: null }));
});
