import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function compile(file, commonJS = false) {
  const source = await readFile(new URL(`../app/${file}`, import.meta.url), "utf8");
  return ts.transpileModule(source, { compilerOptions: {
    module: commonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
}
const audio = await import(`data:text/javascript;base64,${Buffer.from(await compile("headline-audio.ts")).toString("base64")}`);
const follow = await import(`data:text/javascript;base64,${Buffer.from(await compile("article-reading-follow.ts")).toString("base64")}`);
const jsx = (type, props) => ({ type, props });
function load(code, modules, globals = {}) {
  const exports = {};
  runInNewContext(code, { exports, require: (name) => {
    if (name === "./hand-gesture-actions" && !(name in modules)) return { useHandGestureTarget() {} };
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, ...globals });
  return exports;
}
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, predicate);
    if (result) return result;
  }
}

test("article audio defaults to recorded playback and lets users select browser voice", async () => {
  const code = await compile("ArticleAudioPlayer.tsx", true);
  const browserPlayer = () => null;
  for (const speechSupported of [true, false]) {
    const states = [];
    let stateIndex = 0;
    const component = load(code, {
      react: {
        useState(initial) {
          const slot = stateIndex++;
          if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
          return [states[slot], (value) => { states[slot] = value; }];
        },
        useEffect() {},
      },
      "react/jsx-runtime": { jsx, jsxs: jsx }, "./headline-audio": audio,
      "./ReadingVoiceSelector": {}, "./BrowserArticleAudioPlayer": { default: browserPlayer },
      "./article-audio-stream": {},
    }, { window: speechSupported ? { speechSynthesis: {}, SpeechSynthesisUtterance() {} } : {} }).default;
    const render = (props = {}) => { stateIndex = 0; return component({ title: "News", source: "Source", paragraphs: ["Story"], ...props }); };
    const tree = render();
    assert.equal(find(tree, (node) => node.props.children === "Recorded audio").props["aria-pressed"], true);
    const browserButton = find(tree, (node) => node.props.children === "Browser voice");
    assert.equal(browserButton.props.disabled, !speechSupported);
    if (speechSupported) {
      browserButton.props.onClick();
      assert.ok(find(render(), (node) => node.type === browserPlayer));
      find(render(), (node) => node.props.children === "Recorded audio").props.onClick();
      assert.equal(find(render(), (node) => node.props.children === "Recorded audio").props["aria-pressed"], true);
    }
    states.length = 0;
    assert.ok(find(render({ defaultMode: "browser" }), (node) => node.type === browserPlayer));
  }
});

test("narration sections preserve paragraph indices and exact text through whitespace, repeated words and Unicode splits", () => {
  const paragraphs = [" ", "  A repeated sentence.\n".repeat(60), "", "中文內容。🚀".repeat(180)];
  for (const maximum of [240, 300, 900]) {
    const sections = audio.articleNarrationSections("A title", paragraphs, maximum);
    assert.deepEqual(sections.map((section) => section.text), audio.articleNarrationParts("A title", paragraphs, maximum));
    assert.deepEqual([...new Set(sections.map((section) => section.paragraphIndex))], [-1, 1, 3]);
    for (const section of sections) {
      const original = section.paragraphIndex === -1 ? "A title" : paragraphs[section.paragraphIndex];
      assert.equal(audio.normalizeArticleReadingText(original).slice(section.start, section.end), section.text);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(section.text));
    }
  }
  audio.configureRecordedAudio("kokoro-local", "300");
  try {
    const sections = audio.recordedArticleNarrationSections("A title", paragraphs);
    assert.ok(sections.every((section) => section.text.length <= 300));
    assert.deepEqual(sections.map((section) => section.text), audio.recordedArticleNarrationParts("A title", paragraphs));
  } finally { audio.configureRecordedAudio("isolated-process", "15000"); }
});

test("the reader marks only the spoken range and preserves the rest of the paragraph", async () => {
  const component = load(await compile("ArticleReadingText.tsx", true), {
    "./headline-audio": audio, "react/jsx-runtime": { jsx, jsxs: jsx },
  }).default;
  const text = "A news sentence. ".repeat(40);
  const section = audio.articleNarrationSections("Title", [text], 240)[2];
  const tree = component({ text, paragraphIndex: 0, section });
  const mark = find(tree, (node) => node.type === "mark");
  assert.equal(mark.props.children, section.text);
  assert.equal(tree.props.children.map((child) => typeof child === "string" ? child : child.props.children).join(""), audio.normalizeArticleReadingText(text));
  assert.equal(find(component({ text, paragraphIndex: 1, section }), (node) => node.type === "mark"), undefined);
  assert.equal(find(component({ text, paragraphIndex: 0, section: null }), (node) => node.type === "mark"), undefined);
});

test("follow reading scrolls only out-of-view sections inside the reader and respects reduced motion", () => {
  const calls = [];
  const container = { scrollTop: 200, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, bottom: 500 }), scrollTo: (options) => calls.push(options),
  };
  const highlight = (top, bottom) => ({ getClientRects: () => [{ top, bottom }] });
  follow.scrollReadingSectionIntoView(container, highlight(200, 225), false);
  assert.equal(calls.length, 0);
  follow.scrollReadingSectionIntoView(container, highlight(600, 625), false);
  assert.deepEqual(calls.pop(), { top: 600, behavior: "smooth" });
  follow.scrollReadingSectionIntoView(container, highlight(90, 115), true);
  assert.deepEqual(calls.pop(), { top: 90, behavior: "instant" });
});

// Run the components' actual effects and event handlers with prepared audio and
// a controllable speech engine, without requiring a device voice or a server.
async function narrationHarness(mode, { streaming = false } = {}) {
  const states = [], refs = [], memos = [], effects = [];
  let stateIndex, refIndex, memoIndex, effectIndex, dirty;
  let tree;
  const reports = [], controllers = [];
  const changed = (next, previous) => !next || !previous || next.some((value, index) => !Object.is(value, previous[index]));
  const react = {
    useState(initial) {
      const slot = stateIndex++;
      if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
      return [states[slot], (value) => {
        const next = typeof value === "function" ? value(states[slot]) : value;
        if (!Object.is(next, states[slot])) { states[slot] = next; dirty = true; }
      }];
    },
    useRef(initial) { const slot = refIndex++; return refs[slot] ??= { current: initial }; },
    useMemo(create, dependencies) {
      const slot = memoIndex++;
      if (changed(dependencies, memos[slot]?.dependencies)) memos[slot] = { dependencies, value: create() };
      return memos[slot].value;
    },
    useEffect(callback, dependencies) {
      const slot = effectIndex++;
      if (changed(dependencies, effects[slot]?.dependencies)) effects[slot] = { dependencies, callback, cleanup: effects[slot]?.cleanup, pending: true };
    },
  };
  const title = "News title";
  const paragraphs = ["An English sentence. ".repeat(90), "下一段新聞內容。".repeat(50)];
  const sections = mode === "browser" ? audio.articleNarrationSections(title, paragraphs, 240) : audio.recordedArticleNarrationSections(title, paragraphs);
  const speech = { getVoices: () => [], addEventListener() {}, removeEventListener() {} };
  const element = { paused: true, ended: false, currentTime: 0, duration: sections.length * 3,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); },
    buffered: { length: 1, start: () => 0, end: () => sections.length * 3 },
    getAttribute: () => "native-stream", removeAttribute() {}, load() {},
  };
  let streamReport;
  let gesture;
  const modules = {
    "./hand-gesture-actions": { useHandGestureTarget(_priority, _active, handler) { gesture = handler; } },
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "./headline-audio": { ...audio, preparedAudioCache: {
      get: () => streaming ? undefined : ({ blob: new Blob(["recording"]), starts: sections.map((_, index) => index * 3) }),
      key: () => "article", position: () => undefined, savePosition() {},
    } },
    "./ReadingVoiceSelector": { default: () => null, useReadingVoices: () => ({ loading: false, streaming, preferences: { en: "", zh: "" } }) },
    "./BrowserArticleAudioPlayer": { default: () => null },
    "./article-audio-stream": { openArticleAudioStream(_parts, _language, _voices, _signal, report) {
      assert.ok(streaming, "A prepared recording must bypass streaming.");
      streamReport = report; report({ starts: [0], complete: false, duration: 0, error: null });
      return Promise.resolve("/api/article-audio-stream/" + "a".repeat(32));
    } },
    "./headline-playback": {
      HEADLINE_SPEECH_PREFERENCES_KEY: "preferences", normalizeHeadlineSpeechPreferences: () => ({ rate: 1, voices: {} }),
      browserSpeechRequiresTap: () => false, headlineSpeechLanguage: () => "en", rankHeadlineVoices: () => [],
      findPreferredHeadlineVoice() {}, selectHeadlineVoice() {},
      browserSpeechErrorMessage: () => "Voice failed", createHeadlinePlayback(options) {
        const controller = { options, setPaused() {}, dispose() {} };
        controllers.push(controller);
        return controller;
      },
    },
  };
  const code = await compile(mode === "browser" ? "BrowserArticleAudioPlayer.tsx" : "ArticleAudioPlayer.tsx", true);
  const exports = load(code + (mode === "recorded" ? "\nexports.recorded = RecordedArticleAudioPlayer;" : ""), modules, {
    navigator: { userAgent: "Windows", language: "en" }, window: { speechSynthesis: speech, setTimeout: () => 1, clearTimeout() {} },
    localStorage: { getItem: () => null, setItem() {} }, URL: { createObjectURL: () => "blob:article", revokeObjectURL() {} },
    AbortController, performance: { now: () => 0 },
  });
  const component = mode === "browser" ? exports.default : exports.recorded;
  const props = { title, source: "News", paragraphs, autoPrepare: streaming, onReadingSectionChange: (section, playing) => reports.push({ section, playing }) };
  function render() {
    let passes = 0;
    do {
      assert.ok(passes++ < 20, "The component effects must settle");
      dirty = false;
      stateIndex = refIndex = memoIndex = effectIndex = 0;
      tree = component(props);
      const audioNode = find(tree, (node) => node.type === "audio");
      if (audioNode) audioNode.props.ref.current = element;
      const pending = effects.filter((effect) => effect?.pending);
      pending.forEach((effect) => effect.cleanup?.());
      pending.forEach((effect) => { effect.pending = false; effect.cleanup = effect.callback(); });
    } while (dirty);
    return tree;
  }
  render();
  if (streaming) { await new Promise(setImmediate); render(); }
  return { sections, reports, element, controllers, render,
    async gesture(action) { const result = await gesture(action); render(); return result; },
    reportStream(status) { streamReport(status); render(); },
    get events() { return find(tree, (node) => node.type === "audio")?.props; },
    click(text) { const button = find(tree, (node) => node.type === "button" && node.props.children === text); assert.ok(button, `Missing button: ${text}`); button.props.onClick(); render(); },
  };
}

test("the article player starts a native stream and follows arriving timestamps before completion", async () => {
  const player = await narrationHarness("recorded", { streaming: true });
  assert.match(player.events.src, /^\/api\/article-audio-stream\//);
  assert.equal(player.element.paused, false, "Requested narration should start without waiting for a complete recording.");
  player.events.onPlay(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections[0], playing: true });
  player.reportStream({ starts: [0, 3], complete: false, duration: 0, error: null });
  player.element.currentTime = 3.5; player.events.onTimeUpdate(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections[1], playing: true });
  player.reportStream({ starts: [0, 3], complete: false, duration: 0, error: "Azure stream failed." });
  assert.equal(player.element.paused, true);
  assert.equal(player.events, undefined, "Failed streaming should return to retry controls.");
});

test("a completed stream becomes seekable audio while preserving the current playhead", async () => {
  const player = await narrationHarness("recorded", { streaming: true });
  player.element.currentTime = 3.5;
  player.reportStream({ starts: player.sections.map((_, index) => index * 3), complete: true, duration: player.sections.length * 3, error: null });
  assert.match(player.events.src, /\?ready=1$/);
  player.events.onLoadedMetadata();
  assert.equal(player.element.currentTime, 3.5);
  assert.equal(player.element.paused, false);
});

test("recorded narration follows real timestamps, seeking and pause, then clears at the end", async () => {
  const player = await narrationHarness("recorded");
  assert.equal(player.reports.at(-1).section, null, "Preparation must not highlight unspoken text");
  player.element.paused = false;
  player.element.currentTime = 3;
  player.events.onPlay(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections[1], playing: true });
  player.element.currentTime = (player.sections.length - 1) * 3;
  player.events.onSeeking(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections.at(-1), playing: true });
  player.element.paused = true;
  player.events.onPause(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections.at(-1), playing: false });
  player.element.ended = true;
  player.events.onEnded(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: null, playing: false });
});

test("browser narration waits for speech to start, follows sections and preserves paused highlighting", async () => {
  const player = await narrationHarness("browser");
  player.click("Play");
  assert.equal(player.reports.at(-1).section, null);
  player.controllers.at(-1).options.onSpeechStart(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections[0], playing: true });
  player.controllers.at(-1).options.onAdvance(); player.render();
  assert.equal(player.reports.at(-1).playing, false, "Waiting for the next voice must not scroll early");
  player.controllers.at(-1).options.onSpeechStart(); player.render();
  assert.deepEqual(player.reports.at(-1), { section: player.sections[1], playing: true });
  player.click("Pause");
  assert.deepEqual(player.reports.at(-1), { section: player.sections[1], playing: false });
  player.click("Stop");
  assert.deepEqual(player.reports.at(-1), { section: null, playing: false });
});

test("palm and fist gestures pause and resume both article narration modes without navigating", async () => {
  for (const mode of ["browser", "recorded"]) {
    const player = await narrationHarness(mode);
    if (mode === "browser") player.click("Play");
    else player.element.paused = false;
    assert.match(await player.gesture("pause"), /paused/);
    if (mode === "recorded") assert.equal(player.element.paused, true);
    else assert.ok(find(player.render(), (node) => node.type === "button" && node.props.children === "Play"));
    assert.match(await player.gesture("resume"), /resumed/);
    if (mode === "recorded") assert.equal(player.element.paused, false);
    assert.equal(await player.gesture("next"), undefined, "Article navigation belongs to the reader");
  }
});
