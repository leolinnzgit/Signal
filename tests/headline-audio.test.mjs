import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/headline-audio.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { BRIEFING_COMPLETE_MESSAGE, briefingNarrationTitles, configureRecordedAudio, recordedArticleNarrationParts, preparedAudioCache, PreparedAudioCache, prepareHeadlineAudio, prepareArticleAudio, prepareReadingVoicePreview, articleNarrationParts, audioHeadlineIndex, preferScreenOffAudio, normalizeReadingVoices } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const titles = ["English headline", "中文新聞"];
const signal = new AbortController().signal;

test("browser briefings narrate completion with saved preferences and stop on close; muted briefings stay silent", async () => {
  const playerSource = await readFile(new URL("../app/HeadlinePlayer.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(playerSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const playbackSource = await readFile(new URL("../app/headline-playback.ts", import.meta.url), "utf8");
  const playbackCode = ts.transpileModule(playbackSource, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const playbackModule = await import(`data:text/javascript;base64,${Buffer.from(playbackCode).toString("base64")}`);
  for (const muted of [false, true]) {
    const states = [];
    const effects = [];
    const calls = [];
    let slot = 0;
    let disposed = false;
    const jsx = (type, props) => ({ type, props });
    const modules = {
      "./hand-gesture-actions": { useHandGestureTarget() {} },
      react: {
        useState(initial) {
          const current = slot++;
          states[current] = current === 0 ? 1 : current === 5 ? !muted : typeof initial === "function" ? initial() : initial;
          return [states[current], (value) => { states[current] = typeof value === "function" ? value(states[current]) : value; }];
        },
        useRef: (current) => ({ current }),
        useMemo: (create) => create(),
        useEffect: (callback, dependencies) => effects.push({ callback, dependencies }),
      },
      "react/jsx-runtime": { jsx, jsxs: jsx },
      "react-dom": { createPortal: (node) => node },
      "./ScreenOffAudioPlayer": { default: () => null },
      "./BriefingMarketPrice": { default: () => null },
      "./useBriefingMarketQuote": { useBriefingMarketQuote: () => null },
      "./headline-audio": { BRIEFING_COMPLETE_MESSAGE },
      "./headline-playback": { ...playbackModule, createHeadlinePlayback(options) {
        calls.push(options);
        return { dispose() { disposed = true; } };
      } },
    };
    const exports = {};
    runInNewContext(code, { exports, require: (name) => modules[name],
      navigator: { language: "en-NZ" }, document: { hidden: false, fullscreenElement: null, body: {} },
      window: { speechSynthesis: { getVoices: () => [] }, SpeechSynthesisUtterance: class {} },
      localStorage: { getItem: () => JSON.stringify({ rate: 1.2, voices: { en: "Saved voice" } }) },
    });
    exports.default({ articles: [{ title: "Final story", url: "https://example.com/final" }] });
    const effect = effects.find(({ dependencies }) => dependencies?.[7] === BRIEFING_COMPLETE_MESSAGE);
    assert.ok(effect, "The completed briefing still has a playback effect");
    const cleanup = effect.callback();
    assert.equal(calls.length, muted ? 0 : 1);
    if (!muted) {
      assert.equal(calls[0].title, BRIEFING_COMPLETE_MESSAGE);
      assert.equal(calls[0].preferredVoiceId, "Saved voice");
      assert.equal(calls[0].rate, 1.2);
      calls[0].onAdvance();
      assert.equal(states[0], 1, "Completion cannot advance beyond the end or repeat");
      cleanup();
      assert.equal(disposed, true, "Closing stops the completion speech");
    }
  }
});

// Replay the rendered player's media events without a browser or speech server.
// Effects that fetch recordings are replaced with an already prepared track.
async function recordedPlayerHarness({ lifecycle = false, announcement = false, streaming = false } = {}) {
  const playerSource = await readFile(new URL("../app/ScreenOffAudioPlayer.tsx", import.meta.url), "utf8");
  const playerCode = ts.transpileModule(playerSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const articles = Array.from({ length: 4 }, (_, index) => ({ title: `News ${index}`, url: `https://example.com/${index}`, source: "News" }));
  const heard = [];
  const controls = { current: null };
  const refs = [];
  const states = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;
  let stateIndex = 0;
  let playCalls = 0;
  let rejectPlay = false;
  let gesture;
  let reportStatus;
  let streamedTitles;
  let recordings = 0;
  const handlers = new Map();
  const mediaSession = { setActionHandler(action, handler) { handlers.set(action, handler); }, playbackState: "none" };
  const element = { currentTime: 0, duration: 24, paused: true, ended: false,
    buffered: { length: 1, start: () => 0, end: () => bufferedEnd },
    removeAttribute() {}, load() {},
    pause() { this.paused = true; },
    play() { playCalls++; if (rejectPlay) return Promise.reject(new Error("Playback blocked")); this.paused = false; return Promise.resolve(); },
  };
  let bufferedEnd = 24;
  const react = {
    useState(initial) {
      const slot = stateIndex++;
      if (!(slot in states)) states[slot] = !streaming && slot === 0 ? { url: "blob:briefing", streaming: false }
        : !streaming && slot === 1 ? announcement ? [0, 6, 12, 18, 24] : [0, 6, 12, 18] : initial;
      return [states[slot], (value) => { states[slot] = typeof value === "function" ? value(states[slot]) : value; }];
    },
    useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial }; },
    useEffect(callback, dependencies) {
      const slot = effectIndex++;
      // Supply an existing recording; run the remaining playback effects normally.
      if (!lifecycle || (!streaming && dependencies?.[0] === articles)) return;
      const previous = effects[slot];
      if (!dependencies || !previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
        effects[slot] = { dependencies, callback, cleanup: previous?.cleanup, pending: true };
      }
    },
    useImperativeHandle(ref, create) { ref.current = create(); },
  };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "./hand-gesture-actions": { useHandGestureTarget(_priority, active, handler) { gesture = active ? handler : null; } },
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "./headline-audio": { audioHeadlineIndex, briefingNarrationTitles, preparedAudioCache: {
      key: (...args) => preparedAudioCache.key(...args), get: () => undefined, position: () => undefined, savePosition() {},
    }, prepareHeadlineAudio: async () => { recordings++; return { blob: new Blob(), starts: [0, 6, 12, 18, 24] }; } },
    "./article-audio-stream": { openArticleAudioStream: async (parts, _language, _voices, _signal, onStatus) => {
      streamedTitles = parts; reportStatus = onStatus; return "/api/article-audio-stream/briefing";
    } },
    "./ReadingVoiceSelector": { default: () => null, useReadingVoices: () => ({ loading: false, streaming, preferences: { en: "", zh: "" } }) },
    "./BriefingMarketPrice": { default: () => null },
  };
  const exports = {};
  runInNewContext(playerCode, { exports, require: (name) => {
    assert.ok(name in modules, `Unexpected player dependency: ${name}`);
    return modules[name];
  }, navigator: { userAgent: "Android", language: "en", mediaSession }, window: {}, AbortController,
    URL: { createObjectURL: () => "blob:briefing", revokeObjectURL() {} } });
  function findAudio(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "audio") return node.props;
    for (const child of [node.props?.children].flat(Infinity)) {
      const audio = findAudio(child);
      if (audio) return audio;
    }
  }
  let props = { ref: controls, articles, initialIndex: 0, seconds: 6, rate: 1,
    onArticleRead: (article) => heard.push(article.url), onIndexChange() {},
  };
  let tree;
  function render(nextProps = {}) {
    props = { ...props, ...nextProps };
    stateIndex = refIndex = effectIndex = 0;
    tree = exports.default(props);
    refs[0].current = element;
    const pending = effects.filter((effect) => effect?.pending);
    pending.forEach((effect) => effect.cleanup?.());
    pending.forEach((effect) => { effect.pending = false; effect.cleanup = effect.callback(); });
    return tree;
  }
  render();
  if (streaming) { await Promise.resolve(); render(); }
  assert.ok(findAudio(tree), "The prepared recording must render audio controls");
  findAudio(tree).onLoadedMetadata();
  return { articles, heard, get controls() { return controls.current; }, element,
    async gesture(action) { const result = await gesture?.(action); render(); return result; },
    get events() { return findAudio(tree); }, render, handlers, mediaSession,
    get playCalls() { return playCalls; }, blockPlayback() { rejectPlay = true; },
    get streamedTitles() { return streamedTitles; }, get recordings() { return recordings; },
    report(status) { reportStatus(status); return render(); },
    bufferUntil(time) { bufferedEnd = time; findAudio(tree).onProgress(); return render(); },
  };
}

test("briefing streaming exposes Play before generation and timing updates keep the same audio request playing", async () => {
  const player = await recordedPlayerHarness({ lifecycle: true, streaming: true });
  const src = player.events.src;
  assert.equal(player.recordings, 0, "Streaming must not wait for the complete WAV");
  assert.equal(player.streamedTitles.at(-1), BRIEFING_COMPLETE_MESSAGE);
  player.element.duration = Infinity;
  player.bufferUntil(4);
  player.report({ starts: [0], complete: false });
  player.element.paused = false;
  player.events.onPlay();
  player.controls.move(1);
  assert.equal(player.element.currentTime, 0, "An unavailable headline must not seek to undefined");
  player.report({ starts: [0, 6], complete: false });
  player.controls.move(1);
  assert.equal(player.element.currentTime, 0, "An unbuffered headline must not seek beyond received audio");
  player.bufferUntil(14);
  player.controls.move(1);
  assert.equal(player.element.currentTime, 6);
  player.report({ starts: [0, 6, 12, 18, 24], complete: true });
  assert.equal(player.events.src, src, "Completion must not reload the source and interrupt playback");
  assert.equal(player.element.paused, false);
});

test("a failed briefing stream keeps a complete recording fallback available", async () => {
  const player = await recordedPlayerHarness({ lifecycle: true, streaming: true });
  const tree = player.report({ starts: [0], complete: false, error: "Speech service interrupted" });
  assert.equal(player.element.paused, true);
  assert.match(JSON.stringify(tree), /Speech service interrupted/);
  function findFallback(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && node.props.children === "Prepare recording instead") return node.props;
    return [node.props?.children].flat(Infinity).map(findFallback).find(Boolean);
  }
  findFallback(tree).onClick();
  player.render();
  await new Promise(setImmediate);
  player.render();
  assert.equal(player.recordings, 1);
  assert.equal(player.events.src, "blob:briefing");
});

test("closing full news restores the recorded briefing at its playhead and returns media controls", async () => {
  const player = await recordedPlayerHarness({ lifecycle: true });
  player.element.currentTime = 13;
  player.element.paused = false;
  player.events.onPlay();
  player.render();
  const briefingPlay = player.handlers.get("play");
  player.render({ suspended: true });
  assert.equal(player.element.paused, true);
  assert.equal(player.handlers.get("play"), null, "Article narration can own the device controls");
  // Article narration changes the media session while the briefing is hidden.
  player.handlers.set("play", () => {});
  player.mediaSession.playbackState = "playing";
  player.render();
  assert.equal(player.mediaSession.playbackState, "playing");
  player.render({ suspended: false });
  assert.equal(player.element.currentTime, 13);
  assert.equal(player.element.paused, false);
  assert.equal(player.playCalls, 1);
  assert.equal(typeof player.handlers.get("play"), "function");
  assert.notEqual(player.handlers.get("play"), briefingPlay);
  player.events.onPlay();
  player.render();
  assert.equal(player.mediaSession.playbackState, "playing");
  player.render({ suspended: true });
  player.render({ suspended: false });
  assert.equal(player.playCalls, 2, "Later article interruptions also resume");
});

test("hand gestures control recorded headlines, handle blocked playback and yield bookmarks to the parent", async () => {
  const player = await recordedPlayerHarness();
  assert.match(await player.gesture("resume"), /resumed/);
  assert.equal(player.element.paused, false);
  assert.match(await player.gesture("pause"), /paused/);
  assert.equal(player.element.paused, true);
  await player.gesture("next");
  assert.equal(player.element.currentTime, 6);
  await player.gesture("previous");
  assert.equal(player.element.currentTime, 0);
  assert.equal(await player.gesture("bookmark"), undefined);
  player.blockPlayback();
  assert.match(await player.gesture("resume"), /Tap Play/);
  player.render({ suspended: true });
  assert.equal(await player.gesture("next"), undefined);
});

test("closing a reader keeps manually paused and completed briefings stopped", async () => {
  for (const ended of [false, true]) {
    const player = await recordedPlayerHarness({ lifecycle: true });
    player.element.ended = ended;
    player.render({ suspended: true });
    player.render({ suspended: false });
    assert.equal(player.playCalls, 0);
    assert.equal(player.element.paused, true);
  }
});

test("blocked automatic resume leaves the recording available with a Play prompt", async () => {
  const player = await recordedPlayerHarness({ lifecycle: true });
  player.element.currentTime = 8;
  player.element.paused = false;
  player.render({ suspended: true });
  player.blockPlayback();
  player.render({ suspended: false });
  await Promise.resolve();
  const tree = player.render();
  assert.equal(player.element.currentTime, 8);
  assert.equal(player.element.paused, true);
  assert.match(JSON.stringify(tree), /Tap Play on the audio controls to resume listening/);
});

test("preparing and seeking a paused recording keeps unheard headlines in the next queue", async () => {
  const { articles, heard, controls, element, events } = await recordedPlayerHarness();
  events.onLoadedMetadata();
  events.onSeeking();
  events.onTimeUpdate();
  controls.move(1);
  events.onSeeking();
  events.onTimeUpdate();
  assert.deepEqual(heard, [], "Opening or previewing the recording must not consume stories");
  element.paused = false;
  events.onPlay();
  assert.deepEqual(heard, [articles[1].url], "Play marks the selected story, leaving the skipped story unread");
});

test("delayed background updates and the ended event retain read tracking for played headlines", async () => {
  const { articles, heard, element, events } = await recordedPlayerHarness();
  element.paused = false;
  events.onPlay();
  element.currentTime = 13;
  events.onTimeUpdate();
  element.currentTime = 24;
  element.paused = true;
  element.ended = true;
  events.onEnded();
  assert.deepEqual([...new Set(heard)], articles.map((article) => article.url));
});

test("the closing announcement completes the display without treating it as a news article", async () => {
  const player = await recordedPlayerHarness({ announcement: true });
  player.element.duration = 30;
  player.element.paused = false;
  player.events.onPlay();
  player.element.currentTime = 25;
  player.events.onTimeUpdate();
  const tree = player.render();
  assert.match(JSON.stringify(tree), /All caught up/);
  assert.deepEqual([...new Set(player.heard)], player.articles.map((article) => article.url));
  player.element.currentTime = 30;
  player.element.paused = true;
  player.element.ended = true;
  player.events.onEnded();
  player.render();
  player.controls.move(-1);
  assert.equal(player.element.currentTime, 18, "Previous returns to the final headline");
});

test("recorded briefings include one closing announcement, including when reusing cached news", async () => {
  const cache = new PreparedAudioCache();
  const requests = [];
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const body = JSON.parse(options.body);
    requests.push(body.titles);
    return waveResponse(body.titles.map((_, index) => index * 3), body.titles.length * 3);
  };
  assert.deepEqual(briefingNarrationTitles([]), []);
  const voices = { en: "Susan", zh: "Yating" };
  const narration = briefingNarrationTitles(titles);
  const recording = await prepareHeadlineAudio(narration, 6, "en", signal, fetcher, undefined, 15_000, voices, cache);
  assert.deepEqual(requests.flat(), [...titles, BRIEFING_COMPLETE_MESSAGE]);
  assert.deepEqual(recording.starts, [0, 3, 6]);
  assert.equal(recording.blob.size, 44 + 9 * 32_000);
  assert.equal(cache.get([titles.at(-1)], 6, "en", voices).blob.size, 44 + 3 * 32_000, "The announcement stays separate from reusable story audio");
  const remaining = await prepareHeadlineAudio(briefingNarrationTitles(titles.slice(1)), 6, "en", signal,
    () => { throw new Error("Must reuse the complete cached track"); }, undefined, 15_000, voices, cache);
  assert.deepEqual(remaining.starts, [0, 3]);
  assert.equal(remaining.blob.size, 44 + 6 * 32_000);
});

test("returning to a full article reuses the ready recording without any network requests", async () => {
  const cache = new PreparedAudioCache();
  const voices = { en: "Susan", zh: "Yating" };
  const paragraphs = ["A complete news article. ".repeat(180), "最後一段。"];
  let requests = 0;
  const fetcher = async (url, options) => {
    requests++;
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const { titles } = JSON.parse(options.body);
    return waveResponse(titles.map((_, index) => index * 3), titles.length * 3);
  };
  const first = await prepareArticleAudio("Article", paragraphs, "en-NZ", signal, fetcher, undefined, voices, cache);
  assert.ok(requests > 1);
  requests = 0;
  const second = await prepareArticleAudio("Article", [...paragraphs], "en-NZ", signal, fetcher, undefined, voices, cache);
  assert.equal(requests, 0);
  assert.deepEqual(second.starts, first.starts);
  assert.deepEqual(await second.blob.arrayBuffer(), await first.blob.arrayBuffer());
});

test("remaining unread headlines reuse existing audio with correct WAV timing and PCM", async () => {
  const cache = new PreparedAudioCache();
  const all = ["First story", "Second story", "Third story"];
  const recording = { blob: await waveResponse([0, 3, 6], 9).blob(), starts: [0, 3, 6] };
  cache.remember(all, 6, "en", undefined, recording);
  const remaining = await prepareHeadlineAudio(all.slice(1), 6, "en", signal, () => { throw new Error("Must not fetch"); }, undefined, 15_000, undefined, cache);
  assert.deepEqual(remaining.starts, [0, 3]);
  const raw = await remaining.blob.arrayBuffer();
  assert.equal(new DataView(raw).getUint32(40, true), 6 * 32_000);
  assert.deepEqual(raw.slice(44), (await recording.blob.arrayBuffer()).slice(44 + 3 * 32_000));
  assert.equal(cache.get(["Different title"], 6, "en"), undefined);
  assert.equal(cache.get(all, 15, "en"), undefined);
  assert.equal(cache.get(all, 6, "en-GB"), undefined);
  assert.equal(cache.get(all, 6, "en", { en: "George", zh: "" }), undefined);
});

test("cached PCM has bounded source memory, LRU eviction and a full sign-out reset", async () => {
  const recording = { blob: await waveResponse([0], 3).blob(), starts: [0] };
  const cache = new PreparedAudioCache(recording.blob.size * 2, 2);
  for (const title of ["A", "B"]) cache.remember([title], 6, "en", undefined, { ...recording });
  assert.ok(cache.get(["A"], 6, "en"));
  cache.remember(["C"], 6, "en", undefined, { ...recording });
  assert.equal(cache.get(["B"], 6, "en"), undefined);
  assert.ok(cache.get(["A", "C"], 6, "en"));
  const key = cache.key(["A"], 6, "en");
  cache.savePosition(key, 1.75);
  cache.savePosition(key, NaN);
  assert.equal(cache.position(key), 1.75);
  cache.clear();
  assert.equal(cache.get(["A"], 6, "en"), undefined);
  assert.equal(cache.position(key), undefined);
  const tooSmall = new PreparedAudioCache(recording.blob.size - 1);
  tooSmall.remember(["A"], 6, "en", undefined, recording);
  assert.equal(tooSmall.get(["A"], 6, "en"), undefined);
  const grouped = { blob: await waveResponse([0, 3, 6], 9).blob(), starts: [0, 3, 6] };
  const sourceBound = new PreparedAudioCache(grouped.blob.size);
  sourceBound.remember(["A", "B", "C"], 6, "en", undefined, grouped);
  sourceBound.remember(["D"], 6, "en", undefined, recording);
  for (const title of ["A", "B", "C"]) assert.equal(sourceBound.get([title], 6, "en"), undefined);
  assert.ok(sourceBound.get(["D"], 6, "en"));
});

test("failed and cancelled preparations do not become ready cached recordings", async () => {
  const cache = new PreparedAudioCache();
  const fetcher = async (url) => url === "/api/auth/csrf" ? Response.json({ token: "token" }) : Response.json({ error: "Failed" }, { status: 503 });
  await assert.rejects(prepareHeadlineAudio(["A"], 6, "en", signal, fetcher, undefined, 15_000, undefined, cache), /Failed/);
  assert.equal(cache.get(["A"], 6, "en"), undefined);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareHeadlineAudio(["A"], 6, "en", abort.signal, fetcher, undefined, 15_000, undefined, cache), { name: "AbortError" });
});

test("voice previews use the selected language and voice without preparing a whole article", async () => {
  const preferences = { en: "Susan", zh: "Yating" };
  const requests = [];
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "preview-token" });
    assert.equal(options.headers["X-XSRF-TOKEN"], "preview-token");
    assert.equal(options.signal, signal);
    const body = JSON.parse(options.body);
    requests.push(body);
    assert.equal(body.titles.length, 1);
    assert.ok(body.titles[0].length < 150);
    return waveResponse([0], 3);
  };
  await prepareReadingVoicePreview("en", preferences, signal, fetcher);
  await prepareReadingVoicePreview("zh", preferences, signal, fetcher);
  assert.equal(requests[0].language, "en");
  assert.deepEqual(requests[0].voices, { en: "Susan", zh: "" });
  assert.match(requests[0].titles[0], /Hello/);
  assert.equal(requests[1].language, "zh");
  assert.deepEqual(requests[1].voices, { en: "", zh: "Yating" });
  assert.match(requests[1].titles[0], /您好/);
  assert.deepEqual(preferences, { en: "Susan", zh: "Yating" });
});

test("automatic voice preview keeps the server default and can be cancelled before preparation", async () => {
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    assert.equal(JSON.parse(options.body).voices, undefined);
    return waveResponse([0], 3);
  };
  await prepareReadingVoicePreview("en", { en: "", zh: "Yating" }, signal, fetcher);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(prepareReadingVoicePreview("zh", { en: "", zh: "" }, abort.signal, () => { throw new Error("Must not fetch"); }), { name: "AbortError" });
});

test("saved English and Chinese voice choices handle invalid device preferences", () => {
  assert.deepEqual(normalizeReadingVoices(null), { en: "", zh: "" });
  assert.deepEqual(normalizeReadingVoices({ en: " Hazel ", zh: "Yating", unrelated: "ignored" }), { en: "Hazel", zh: "Yating" });
  assert.deepEqual(normalizeReadingVoices({ en: 5, zh: "x".repeat(161) }), { en: "", zh: "" });
});

test("chosen reading voices reach every full article batch", async () => {
  const preferences = { en: "Susan", zh: "Yating" };
  let count = 0;
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const body = JSON.parse(options.body);
    count++;
    assert.deepEqual(body.voices, preferences);
    return waveResponse(body.titles.map((_, index) => index * 3), body.titles.length * 3);
  };
  await prepareArticleAudio("News title", ["A complete sentence about a selected reading voice. ".repeat(170)], "en-NZ", signal, fetcher, undefined, preferences);
  assert.ok(count > 1);
});

test("chosen headline voices are preserved across all briefing batches", async () => {
  const preferences = { en: "George", zh: "" };
  let count = 0;
  const fetcher = async (url, options) => {
    if (url === "/api/auth/csrf") return Response.json({ token: "token" });
    const body = JSON.parse(options.body);
    count++;
    assert.deepEqual(body.voices, preferences);
    return waveResponse(body.titles.map((_, index) => index * 3), body.titles.length * 3);
  };
  await prepareHeadlineAudio(Array(51).fill("A headline"), 6, "en-NZ", signal, fetcher, undefined, 15_000, preferences);
  assert.equal(count, 2);
});

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

test("PCs and installed Android apps start with recorded headline audio", () => {
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0", true), true);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) SamsungBrowser/27.0 Chrome/125.0", true), true);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (Linux; Android 14; SM-S918B) Chrome/128.0", false), false);
  for (const agent of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0", "Mozilla/5.0 (Macintosh; Intel Mac OS X)", "Mozilla/5.0 (X11; Linux x86_64)"]) {
    assert.equal(preferScreenOffAudio(agent, true), true);
    assert.equal(preferScreenOffAudio(agent, false), true);
  }
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", true), false);
  assert.equal(preferScreenOffAudio("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", false), false);
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

test("browser narration uses short complete chunks and preserves long words, Chinese and emoji", () => {
  const paragraphs = ["Detailed sentence about the news. ".repeat(50), "中文新聞。".repeat(100), "🚀".repeat(300), "a".repeat(500)];
  const parts = articleNarrationParts("News title", paragraphs, 240);
  assert.ok(parts.every(part => part.length <= 240));
  assert.equal(parts.join("").replace(/\s/gu, ""), ["News title", ...paragraphs].join("").replace(/\s/gu, ""));
  assert.ok(parts.every(part => !/[\uD800-\uDBFF]$/u.test(part)));
  assert.deepEqual(articleNarrationParts("", ["Headline only"], 240), ["Headline only"]);
});


test("local voice metadata keeps complete articles within small CPU batches and clears old engine audio", async () => {
  configureRecordedAudio("isolated-process", "15000");
  const recording = { blob: await waveResponse([0], 3).blob(), starts: [0] };
  preparedAudioCache.remember(["Old engine"], 3, "en", undefined, recording);
  assert.ok(preparedAudioCache.get(["Old engine"], 3, "en"));
  configureRecordedAudio("kokoro-local", "300");
  try {
    assert.equal(preparedAudioCache.get(["Old engine"], 3, "en"), undefined);
    const paragraphs = ["An English news sentence. ".repeat(45), "今天的新聞內容。".repeat(85)];
    const parts = recordedArticleNarrationParts("News", paragraphs);
    assert.ok(parts.every(part => part.length <= 300));
    assert.equal(parts.join("").replace(/\s/g, ""), ["News", ...paragraphs].join("").replace(/\s/g, ""));
    let count = 0;
    const fetcher = async (url, options) => {
      if (url === "/api/auth/csrf") return Response.json({ token: "token" });
      const { titles } = JSON.parse(options.body);
      count++;
      assert.ok(titles.join("").length <= 300);
      return waveResponse(titles.map((_, index) => index * 3), titles.length * 3);
    };
    const cache = new PreparedAudioCache();
    const audio = await prepareArticleAudio("News", paragraphs, "en", signal, fetcher, undefined, undefined, cache);
    assert.ok(count > 2);
    assert.equal(audio.starts.length, parts.length);
    await prepareArticleAudio("News", paragraphs, "en", signal, () => { throw new Error("Must reuse local recording"); }, undefined, undefined, cache);
    configureRecordedAudio("kokoro-local", "bad");
    assert.ok(recordedArticleNarrationParts("News", paragraphs).some(part => part.length > 300));
  } finally { configureRecordedAudio("isolated-process", "15000"); }
});


test("article chunk boundaries match the shared background preparation fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/article-narration.json", import.meta.url), "utf8"));
  assert.deepEqual(articleNarrationParts(fixture.title, fixture.paragraphs, 300), fixture.parts);
});
