import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/headline-audio.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { prepareHeadlineAudio, prepareArticleAudio, articleNarrationParts, audioHeadlineIndex, preferScreenOffAudio } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const titles = ["English headline", "中文新聞"];
const signal = new AbortController().signal;

test("full article narration includes every paragraph and preserves long English/Chinese text and emoji", () => {
  const paragraphs = ["A sentence with news. ".repeat(100), "完整新聞內容。".repeat(300), "😀".repeat(901)];
  const parts = articleNarrationParts("Full news title", paragraphs);
  assert.equal(parts[0], "Full news title");
  assert.ok(parts.every((part) => part.length > 0 && part.length <= 900 && part.isWellFormed()));
  assert.equal(parts.join("").replace(/\s/g, ""), ["Full news title", ...paragraphs].join("").replace(/\s/g, ""));
  assert.throws(() => articleNarrationParts("Title only", [" "]), /full article text is unavailable/);
  assert.throws(() => articleNarrationParts("Title", ["x".repeat(40_001)]), /too long/);
});

test("full news is prepared in bounded batches and joined into one authenticated recording", async () => {
  const paragraphs = ["A complete paragraph about science. ".repeat(220), "這是最後一段新聞。"];
  const parts = articleNarrationParts("Article headline", paragraphs);
  const batches = [];
  const progress = [];
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "article-token" });
    const body = JSON.parse(options.body);
    assert.equal(options.headers["X-XSRF-TOKEN"], "article-token");
    assert.equal(options.signal, signal);
    assert.equal(body.seconds, 3);
    assert.ok(body.titles.join("").length <= 4_000);
    batches.push(body.titles);
    return waveResponse(body.titles.map((_, index) => index * 3), body.titles.length * 3, batches.length);
  };
  const recording = await prepareArticleAudio("Article headline", paragraphs, "en-NZ", signal, fetcher, (done, total) => progress.push([done, total]));
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), parts);
  assert.equal(recording.starts.length, parts.length);
  assert.equal(recording.blob.size, 44 + parts.length * 3 * 32_000);
  assert.deepEqual(progress.at(-1), [parts.length, parts.length]);
});

test("closing full news preparation cancels remaining batches", async () => {
  const abort = new AbortController();
  let count = 0;
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    count++;
    const { titles } = JSON.parse(options.body);
    abort.abort();
    return waveResponse(titles.map((_, index) => index * 3), titles.length * 3);
  };
  await assert.rejects(prepareArticleAudio("Title", ["Long article sentence. ".repeat(400)], "en", abort.signal, fetcher), { name: "AbortError" });
  assert.equal(count, 1);
});

test("installed Android apps start with recorded audio, including Samsung and Chrome", () => {
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0", true), true);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/27.0 Chrome/125.0", true), true);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0", false), false);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0", true), false);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", true), false);
});

function waveResponse(starts, duration, sample = 7) {
  const bytes = Buffer.alloc(44 + Math.round(duration * 32_000 / 2) * 2, sample);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Response(bytes, { headers: { "Content-Type": "audio/wav", "X-Signal-Headline-Starts": JSON.stringify(starts) } });
}

test("prepares a single audio track with authentication, cancellation and headline offsets", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/auth/csrf") return Response.json({ token: "csrf-test-token" });
    return waveResponse([0, 6.5], 13);
  };
  const audio = await prepareHeadlineAudio(titles, 6, "en-NZ", signal, fetcher);
  assert.deepEqual(audio.starts, [0, 6.5]);
  assert.equal(audio.blob.type, "audio/wav");
  assert.equal(calls[1].options.headers["X-XSRF-TOKEN"], "csrf-test-token");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[1].options.signal, signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), { titles, seconds: 6, language: "en-NZ" });
});

test("prepares all 202 headlines as one WAV with continuous offsets and no batch headers inside PCM", async () => {
  const longTitles = Array.from({ length: 202 }, (_, index) => `Headline ${index}`);
  const batches = [];
  const progress = [];
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const body = JSON.parse(options.body);
    batches.push(body.titles);
    return waveResponse(body.titles.map((_, index) => index / 10), body.titles.length / 10, batches.length);
  };
  const audio = await prepareHeadlineAudio(longTitles, 6, "en-NZ", signal, fetcher, (done, total) => progress.push([done, total]));
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 50, 50, 2]);
  assert.deepEqual(batches.flat(), longTitles);
  assert.equal(audio.starts.length, 202);
  assert.equal(audio.starts[50], 5);
  assert.equal(audio.starts[200], 20);
  assert.equal(audio.starts[201], 20.1);
  assert.deepEqual(progress, [[0, 202], [50, 202], [100, 202], [150, 202], [200, 202], [202, 202]]);
  const bytes = Buffer.from(await audio.blob.arrayBuffer());
  assert.equal(bytes.length, 44 + 202 * 3_200);
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
  let offset = 44;
  batches.forEach((batch, index) => {
    assert.ok(bytes.subarray(offset, offset + batch.length * 3_200).every((sample) => sample === index + 1));
    offset += batch.length * 3_200;
  });
});

test("splits long titles by character count so every request stays within server limits", async () => {
  const batches = [];
  const longTitles = Array.from({ length: 51 }, () => "x".repeat(1_000));
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const { titles } = JSON.parse(options.body);
    batches.push(titles);
    return waveResponse(titles.map((_, index) => index / 10), titles.length / 10);
  };
  const audio = await prepareHeadlineAudio(longTitles, 15, "en", signal, fetcher);
  assert.deepEqual(batches.map((batch) => batch.length), [15, 15, 15, 6]);
  assert.equal(audio.starts.length, 51);
});

test("cancellation between batches stops preparation and does not return partial audio", async () => {
  const abort = new AbortController();
  let requests = 0;
  const fetcher = async (url) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    requests++;
    return waveResponse(Array.from({ length: 50 }, (_, index) => index / 10), 5);
  };
  await assert.rejects(prepareHeadlineAudio(Array(202).fill("Headline"), 6, "en", abort.signal, fetcher,
    (done) => { if (done === 50) abort.abort(); }), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("a later batch failure does not return a partial briefing", async () => {
  let requests = 0;
  const fetcher = async (url) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    if (++requests === 2) return Response.json({ error: "Please try again" }, { status: 503 });
    return waveResponse(Array.from({ length: 50 }, (_, index) => index / 10), 5);
  };
  await assert.rejects(prepareHeadlineAudio(Array(202).fill("Headline"), 6, "en", signal, fetcher), /Please try again/);
});

test("rejects incompatible audio and offsets outside its actual duration", async () => {
  for (const kind of ["format", "duration"]) {
    const fetcher = async (url) => {
      if (url === "/api/auth/csrf") return Response.json({ token: "token" });
      const response = waveResponse([0, 6.5], kind === "duration" ? 6 : 13);
      if (kind === "duration") return response;
      const bytes = Buffer.from(await response.arrayBuffer());
      bytes.writeUInt32LE(48_000, 24);
      return new Response(bytes, { headers: response.headers });
    };
    await assert.rejects(prepareHeadlineAudio(titles, 6, "en", signal, fetcher), /incomplete/);
  }
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
