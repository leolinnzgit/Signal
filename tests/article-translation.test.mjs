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
const { loadArticleTranslation } = await import(`data:text/javascript;base64,${Buffer.from(await compiled("article-translation.ts")).toString("base64")}`);

test("translation submits article identity and target language with authentication, CSRF and cancellation", async () => {
  const calls = [], signal = new AbortController().signal;
  const result = await loadArticleTranslation("https://publisher.example/story", "Title", "zh-Hans", signal, async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(calls.length === 1 ? { token: "csrf-test" }
      : { available: true, reason: "", title: "Translated", paragraphs: ["Full translated text."], language: "zh-Hans" }));
  });
  assert.equal(result.paragraphs[0], "Full translated text.");
  assert.equal(calls[1].url, "/api/article-translation");
  assert.equal(calls[1].options.headers["X-XSRF-TOKEN"], "csrf-test");
  assert.deepEqual(JSON.parse(calls[1].options.body), { url: "https://publisher.example/story", title: "Title", language: "zh-Hans" });
  assert.ok(calls.every(({ options }) => options.signal === signal && options.credentials === "same-origin"));
});

test("missing configuration and failures keep useful reasons while partial or wrong-language output is rejected", async () => {
  const signal = new AbortController().signal;
  const fetcher = (body, status = 200) => async (url) => new Response(JSON.stringify(url.endsWith("csrf") ? { token: "csrf-test" } : body), { status: url.endsWith("csrf") ? 200 : status });
  const load = (body, status) => loadArticleTranslation("url", "Title", "en", signal, fetcher(body, status));
  assert.equal((await load({ available: false, reason: "Azure is not configured.", paragraphs: [] })).reason, "Azure is not configured.");
  await assert.rejects(load({ available: true, reason: "", title: "Title", paragraphs: [], language: "en" }), /incomplete/);
  await assert.rejects(load({ available: true, reason: "", title: "Title", paragraphs: ["Text"], language: "fr" }), /incomplete/);
  await assert.rejects(load({}, 429), /Too many/);
  await assert.rejects(load({}, 401), /Sign in/);
});

const jsx = (type, props) => ({ type, props });
function find(node, predicate) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, predicate); if (match) return match; }
}
async function harness() {
  const slots = [], requests = [], changes = [], effects = [];
  let cursor = 0, effectCursor = 0, tree, translated = false;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(callback, dependencies) { const i = effectCursor++;
      if (!effects[i]) effects[i] = { cleanup: callback(), dependencies }; },
  };
  const modules = { react, "react/jsx-runtime": { jsx, jsxs: jsx }, "./article-translation": {
    translationLanguages: [["en", "English"], ["zh-Hans", "Chinese"]],
    loadArticleTranslation(url, title, language, signal) { return new Promise((resolve) => requests.push({ language, signal, resolve })); },
  } };
  const exports = {};
  runInNewContext(await compiled("ArticleTranslationControls.tsx", true), { exports, require: (name) => modules[name], AbortController });
  function render() { cursor = effectCursor = 0; tree = exports.default({ url: "https://publisher.example/story", title: "Title", translated,
    onChange(result) { changes.push(result); translated = result !== null; } }); }
  render();
  return { requests, changes,
    click(label) { const button = find(tree, (node) => node.type === "button" && node.props.children === label); assert.ok(button); button.props.onClick(); render(); },
    language(value) { find(tree, (node) => node.type === "select").props.onChange({ target: { value } }); render(); },
    async finish(index) { requests[index].resolve({ available: true, reason: "", title: "Translated", paragraphs: ["Text"], language: requests[index].language }); await new Promise(setImmediate); render(); },
    close() { for (const effect of effects) effect.cleanup?.(); },
  };
}

test("changing languages and closing the reader cancel requests and ignore late translations", async () => {
  const view = await harness();
  view.click("Translate"); view.language("zh-Hans");
  assert.equal(view.requests[0].signal.aborted, true);
  await view.finish(0); assert.equal(view.changes.at(-1), null);
  view.click("Translate"); assert.equal(view.requests[1].language, "zh-Hans");
  await view.finish(1); assert.equal(view.changes.at(-1).title, "Translated");
  view.click("Show original"); assert.equal(view.changes.at(-1), null);
  view.click("Translate"); view.close(); assert.equal(view.requests[2].signal.aborted, true);
  await view.finish(2); assert.equal(view.changes.at(-1), null);
});
