import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

async function compiled(file, commonJS = false) {
  return ts.transpileModule(await readFile(new URL(`../app/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: commonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const { loadArticleSummary } = await import(`data:text/javascript;base64,${Buffer.from(await compiled("article-summary.ts")).toString("base64")}`);

test("summaries submit only the article URL with credentials, CSRF protection and cancellation", async () => {
  const calls = [], signal = new AbortController().signal;
  const result = await loadArticleSummary("https://publisher.example/story", signal, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(calls.length === 1 ? { token: "csrf-test" } : { available: true, reason: "", paragraphs: ["Summary from article text."] }));
  });
  assert.equal(result.paragraphs[0], "Summary from article text.");
  assert.equal(calls[1].url, "/api/article-summary");
  assert.equal(calls[1].options.headers["X-XSRF-TOKEN"], "csrf-test");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: "https://publisher.example/story" });
  assert.ok(calls.every(({ options }) => options.signal === signal && options.credentials === "same-origin"));
});

test("summary failures retain useful reasons and incomplete output cannot start narration", async () => {
  const signal = new AbortController().signal;
  const fetcher = (body, status = 200) => async (url) => new Response(JSON.stringify(url.endsWith("csrf") ? { token: "csrf-test" } : body), { status: url.endsWith("csrf") ? 200 : status });
  assert.equal((await loadArticleSummary("url", signal, fetcher({ available: false, reason: "Azure is not configured.", paragraphs: [] }))).reason, "Azure is not configured.");
  await assert.rejects(loadArticleSummary("url", signal, fetcher({ available: true, paragraphs: [] })), /incomplete/);
  await assert.rejects(loadArticleSummary("url", signal, fetcher({}, 429)), /Too many/);
  await assert.rejects(loadArticleSummary("url", signal, async () => new Response("{}", { status: 401 })), /Sign in/);
});

const jsx = (type, props) => ({ type, props });
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, predicate); if (match) return match; }
}
async function playerHarness(autoPrepare = false) {
  const slots = [], effects = [];
  let cursor = 0, effectCursor = 0, tree, dirty = false, resolve, activeSignal;
  const audioPlayer = () => null;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; dirty = true; }];
    },
    useCallback: (callback) => callback,
    useEffect(callback, dependencies) {
      const index = effectCursor++, previous = effects[index];
      if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) {
        previous?.cleanup?.(); effects[index] = { dependencies, callback, pending: true };
      }
    },
  };
  const modules = { react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "./ArticleAudioPlayer": { default: audioPlayer }, "./ArticleReadingText": { default: () => null },
    "./article-summary": { loadArticleSummary(_url, signal) { activeSignal = signal; return new Promise((done) => { resolve = done; }); } },
  };
  const exports = {};
  runInNewContext(await compiled("ArticleSummaryPlayer.tsx", true), { exports, require: (name) => modules[name], AbortController });
  const reports = [];
  function render() {
    let passes = 0;
    do {
      assert.ok(passes++ < 10); dirty = false; cursor = effectCursor = 0;
      tree = exports.default({ url: "https://publisher.example/story", title: "Headline", source: "Publisher", paragraphs: ["Full article."], autoPrepare,
        onReadingSectionChange: (...report) => reports.push(report) });
      for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); }
    } while (dirty);
  }
  render();
  return {
    get audio() { return find(tree, (node) => node.type === audioPlayer)?.props; }, reports,
    async complete(result) { resolve(result); await new Promise(setImmediate); render(); },
    click(label) { const button = find(tree, (node) => node.type === "button" && node.props.children === label); assert.ok(button); button.props.onClick(); render(); },
    close() { for (const effect of effects) effect.cleanup?.(); }, get signal() { return activeSignal; },
  };
}

test("opening an article waits for its summary, automatically narrates it and switches to full text", async () => {
  const player = await playerHarness();
  assert.equal(player.audio, undefined, "The full text must not play while waiting for the summary.");
  await player.complete({ available: true, paragraphs: ["AI summary."], reason: "" });
  assert.deepEqual(Array.from(player.audio.paragraphs), ["AI summary."]);
  assert.equal(player.audio.autoPrepare, true);
  assert.equal(player.audio.summaryOnly, true);
  assert.equal(player.audio.defaultMode, "recorded");
  player.audio.onReadingSectionChange({ paragraphIndex: 0, text: "AI summary." }, true);
  assert.equal(player.reports.at(-1)[0].paragraphIndex, -2, "Summary highlighting must not mark full-text paragraphs.");
  player.click("Read full article");
  assert.deepEqual(Array.from(player.audio.paragraphs), ["Full article."]);
  assert.equal(player.audio.summaryOnly, false);
  assert.deepEqual(player.reports.at(-1), [null, false]);
  player.close(); assert.equal(player.signal.aborted, true);
});

test("explicit full-text narration is preserved and failed summaries do not auto-read full text", async () => {
  const full = await playerHarness(true);
  assert.equal(full.audio.summaryOnly, false);
  await full.complete({ available: true, paragraphs: ["AI summary."], reason: "" });
  assert.deepEqual(Array.from(full.audio.paragraphs), ["Full article."]);
  full.close();
  const failed = await playerHarness();
  await failed.complete({ available: false, paragraphs: [], reason: "Azure is unavailable." });
  assert.equal(failed.audio, undefined);
  failed.click("Retry summary");
  assert.equal(failed.audio, undefined);
  failed.close();
  await failed.complete({ available: true, paragraphs: ["Late summary."], reason: "" });
  assert.equal(failed.audio, undefined, "A closed request must not start audio when it finishes.");
});
