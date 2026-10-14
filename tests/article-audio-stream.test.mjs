import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function harness(responder) {
  const tasks = new Map(); let sequence = 0;
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const requests = [];
  runInNewContext(code, { exports, require: () => ({ normalizeReadingVoices: (voices) => ({ en: voices.en ?? "", zh: voices.zh ?? "" }) }),
    setTimeout(callback) { tasks.set(++sequence, callback); return sequence; }, clearTimeout(id) { tasks.delete(id); },
  });
  return { open: exports.openArticleAudioStream, requests, tasks,
    async tick() { const [id, callback] = tasks.entries().next().value; tasks.delete(id); await callback(); await new Promise(setImmediate); },
    async fetch(url, options) { requests.push({ url, options }); return responder(url, options); },
  };
}
const source = await readFile(new URL("../app/article-audio-stream.ts", import.meta.url), "utf8");
const url = `/api/article-audio-stream/${"a".repeat(32)}`;
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("prewarmed Azure articles open as complete recordings without polling or generating a stream", async () => {
  const h = harness((path) => path === "/api/auth/csrf" ? reply({ token: "csrf" })
    : reply({ url, statusUrl: `${url}/status`, status: { starts: [0, 3], complete: true, duration: 6, error: null } }));
  const reports = [];
  assert.equal(await h.open(["Saved English", "已儲存的新聞"], "en", {}, new AbortController().signal,
    (status) => reports.push(status), h.fetch), url);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].complete, true);
  assert.equal(h.tasks.size, 0);
  assert.equal(h.requests.length, 2);
});

test("a stream opens before audio generation and completed playback reuses the same native URL", async () => {
  let complete = false;
  const h = harness((path) => path === "/api/auth/csrf" ? reply({ token: "csrf" }) : path === "/api/article-audio-stream"
    ? reply({ url, statusUrl: `${url}/status` }) : reply({ starts: complete ? [0, 3] : [0], complete, duration: complete ? 6 : 0, error: null }));
  const reports = []; const abort = new AbortController();
  assert.equal(await h.open(["English", "中文"], "en", { en: "Molly", zh: "" }, abort.signal, (status) => reports.push(status), h.fetch), url);
  assert.deepEqual(h.requests.map((request) => request.url), ["/api/auth/csrf", "/api/article-audio-stream"], "Opening a stream must not fetch and buffer the audio blob.");
  assert.equal(h.requests[1].options.headers["X-XSRF-TOKEN"], "csrf");
  await h.tick(); assert.equal(reports.at(-1).complete, false);
  complete = true; await h.tick(); assert.equal(reports.at(-1).complete, true); assert.equal(h.tasks.size, 0);
  const postCount = h.requests.filter((request) => request.options.method === "POST").length;
  assert.equal(await h.open(["English", "中文"], "en", { en: "Molly", zh: "" }, abort.signal, () => {}, h.fetch), url);
  assert.equal(h.requests.filter((request) => request.options.method === "POST").length, postCount, "Completed replay must not create another cloud job.");
});

test("cancelling streaming clears status work and rejects requests before sending credentials", async () => {
  const h = harness((path) => path === "/api/auth/csrf" ? reply({ token: "csrf" }) : reply({ url, statusUrl: `${url}/status` }));
  const abort = new AbortController();
  await h.open(["Cancel"], "en", {}, abort.signal, () => {}, h.fetch);
  assert.equal(h.tasks.size, 1); abort.abort(); assert.equal(h.tasks.size, 0);
  const before = h.requests.length;
  await assert.rejects(h.open(["Cancel"], "en", {}, abort.signal, () => {}, h.fetch), { name: "AbortError" });
  assert.equal(h.requests.length, before);
});

test("streaming rejects foreign playback URLs and stops on server synthesis errors", async () => {
  const invalid = harness((path) => path === "/api/auth/csrf" ? reply({ token: "csrf" }) : reply({ url: "https://foreign.example/audio", statusUrl: "https://foreign.example/status" }));
  await assert.rejects(invalid.open(["Invalid"], "en", {}, new AbortController().signal, () => {}, invalid.fetch), /could not be opened/);
  const reports = [];
  const denied = harness((path) => path === "/api/auth/csrf" ? reply({ token: "csrf" }) : path === "/api/article-audio-stream"
    ? reply({ url, statusUrl: `${url}/status` }) : reply({ starts: [], complete: false, duration: 0, error: "Azure request limit reached." }));
  await denied.open(["Error"], "en", {}, new AbortController().signal, (status) => reports.push(status), denied.fetch);
  await denied.tick(); assert.match(reports.at(-1).error, /request limit/); assert.equal(denied.tasks.size, 0);
});
