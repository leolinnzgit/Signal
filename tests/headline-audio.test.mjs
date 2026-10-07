import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/headline-audio.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { prepareHeadlineAudio, audioHeadlineIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const titles = ["English headline", "中文新聞"];
const signal = new AbortController().signal;

test("prepares a single audio track with authentication, cancellation and headline offsets", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/auth/csrf") return Response.json({ token: "csrf-test-token" });
    return new Response(new Uint8Array(100), { headers: { "Content-Type": "audio/wav", "X-Signal-Headline-Starts": "[0,6.5]" } });
  };
  const audio = await prepareHeadlineAudio(titles, 6, "en-NZ", signal, fetcher);
  assert.deepEqual(audio.starts, [0, 6.5]);
  assert.equal(audio.blob.type, "audio/wav");
  assert.equal(calls[1].options.headers["X-XSRF-TOKEN"], "csrf-test-token");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[1].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), { titles, seconds: 6, language: "en-NZ" });
});

test("reports server preparation failures without producing a playable track", async () => {
  const fetcher = async (url) => url === "/api/auth/csrf" ? Response.json({ token: "token" }) : Response.json({ error: "Briefing too long" }, { status: 400 });
  await assert.rejects(prepareHeadlineAudio(titles, 6, "en", signal, fetcher), /Briefing too long/);
});

for (const offsets of [null, "invalid json", "[0]", "[1,6]", "[0,-6]", "[0,0]", '[0,"6"]']) {
  test(`rejects missing or invalid offsets: ${offsets}`, async () => {
    const headers = { "Content-Type": "audio/wav", ...(offsets === null ? {} : { "X-Signal-Headline-Starts": offsets }) };
    const fetcher = async (url) => url === "/api/auth/csrf" ? Response.json({ token: "token" }) : new Response(new Uint8Array(100), { headers });
    await assert.rejects(prepareHeadlineAudio(titles, 6, "en", signal, fetcher), /incomplete/);
  });
}

test("maps playback position to headlines across gaps, seeking and delayed background updates", () => {
  const starts = [0, 6.5, 18.75, 30];
  assert.equal(audioHeadlineIndex(starts, 0), 0);
  assert.equal(audioHeadlineIndex(starts, 6.49), 0);
  assert.equal(audioHeadlineIndex(starts, 6.5), 1);
  assert.equal(audioHeadlineIndex(starts, 29.9), 2);
  assert.equal(audioHeadlineIndex(starts, 120), 3);
  assert.equal(audioHeadlineIndex(starts, -1), 0);
  assert.equal(audioHeadlineIndex([], 10), 0);
});
