import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createRandomHeadlineQueue, createUnreadHeadlineQueue, shuffleHeadlineArticles } from "../app/headline-queue.ts";

const story = (title, path, extra = {}) => ({ title, url: `https://news.example/${path}`, ...extra });

test("narrates duplicate headlines from different feeds and topics once, keeping feed order", () => {
  const first = story("Markets rise as rates fall", "google", { topics: ["Markets"] });
  const second = story("Other news", "other");
  const copy = story("  MARKETS rise\nas rates fall. ", "publisher", { topics: ["Economy"] });
  const input = [first, second, copy];
  const queue = createUnreadHeadlineQueue(input);
  assert.deepEqual(queue.articles, [first, second]);
  assert.deepEqual(queue.duplicates.get(first.url), [first, copy]);
  assert.equal(queue.articles[0], first);
  assert.deepEqual(input, [first, second, copy], "Building a queue must preserve feed data");
});

test("URL aliases match despite tracking, fragments, query order and trailing slashes", () => {
  const first = story("Original headline", "story/?b=2&utm_source=rss&a=1#top");
  const copy = story("Updated headline", "story?a=1&b=2&fbclid=abc");
  const distinct = story("Another article", "story?a=1&b=3");
  const queue = createUnreadHeadlineQueue([first, copy, distinct]);
  assert.deepEqual(queue.articles, [first, distinct]);
  assert.deepEqual(queue.duplicates.get(first.url), [first, copy]);
});

test("read copies suppress all linked aliases, including title and URL bridges", () => {
  const first = story("Original headline", "one");
  const second = story("Updated headline", "two");
  const bridge = story("Original headline", "two");
  const read = story("Updated headline", "three", { isRead: true });
  const other = story("Unread story", "other");
  assert.deepEqual(createUnreadHeadlineQueue([first, second, bridge, read, other]).articles, [other]);
});

test("hearing a representative can mark every copy so none enter the next briefing", () => {
  const articles = [story("Same news", "google"), story("Same news", "rss"), story("Still unheard", "other")];
  const queue = createUnreadHeadlineQueue(articles);
  const heard = queue.duplicates.get(queue.articles[0].url);
  const updated = articles.map((article) => heard.includes(article) ? { ...article, isRead: true } : article);
  assert.deepEqual(createUnreadHeadlineQueue(updated).articles, [articles[2]]);
});

test("matches Unicode typography while preserving distinct Chinese headlines, numbers and symbols", () => {
  const first = story("Company’s profits – up", "one");
  const copy = story("Company's profits - up!", "two");
  const distinct = [
    story("台灣股市上漲", "zh-up"), story("台灣股市下跌", "zh-down"),
    story("Rates at 1.5%", "rate-a"), story("Rates at 15%", "rate-b"),
    story("Shares +5%", "gain"), story("Shares -5%", "loss"),
  ];
  assert.deepEqual(createUnreadHeadlineQueue([first, copy, ...distinct]).articles, [first, ...distinct]);
});

test("does not merge unrelated stories with empty titles or URLs", () => {
  const input = [story("", "one"), story("", "two"), { title: "One", url: "" }, { title: "Two", url: "" }];
  assert.deepEqual(createUnreadHeadlineQueue(input).articles, input);
  assert.deepEqual(createUnreadHeadlineQueue([]).articles, []);
});

test("random headline queue shuffles deduplicated unread news first and falls back to all recent news when all are read", () => {
  const first = story("First unread", "one");
  const firstDuplicate = story("first unread!", "one-copy");
  const readStory = story("Already read", "two", { isRead: true });
  const second = story("Second unread", "three");
  const third = story("Third unread", "four");
  const input = [first, firstDuplicate, readStory, second, third];

  const unreadRandom = createRandomHeadlineQueue(input, () => 0);
  assert.equal(unreadRandom.includesRead, false);
  assert.deepEqual(unreadRandom.articles, [second, third, first]);
  assert.deepEqual(unreadRandom.duplicates.get(first.url), [first, firstDuplicate]);
  assert.deepEqual(input, [first, firstDuplicate, readStory, second, third]);

  const allReadInput = input.map((article) => ({ ...article, isRead: true }));
  const fallbackRandom = createRandomHeadlineQueue(allReadInput, () => 0);
  assert.equal(fallbackRandom.includesRead, true);
  assert.deepEqual(fallbackRandom.articles, [allReadInput[2], allReadInput[3], allReadInput[4], allReadInput[0]]);
  assert.deepEqual(fallbackRandom.duplicates.get(allReadInput[0].url), [allReadInput[0], allReadInput[1]]);

  assert.deepEqual(createRandomHeadlineQueue([]), {
    articles: [],
    duplicates: new Map(),
    includesRead: false,
  });
  assert.deepEqual(shuffleHeadlineArticles(["only"]), ["only"]);
});

test("dashboard saves all heard copies and catches up their topics without consuming unrelated news", async () => {
  const source = await readFile(new URL("../app/NewsDashboard.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("NewsDashboard.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  let randomDeclaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "markArticleRead") declaration = node;
    if (ts.isFunctionDeclaration(node) && node.name?.text === "startRandomHeadlinePlayback") randomDeclaration = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration);
  assert.ok(randomDeclaration);
  const code = ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const randomCode = ts.transpileModule(randomDeclaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const articles = [
    story("Same news", "google", { topics: ["Markets"] }),
    story("Same news", "publisher", { topics: ["Economy"] }),
    story("Unrelated news", "other", { topics: ["Technology"] }),
  ];
  let latest = articles;
  let history = articles;
  let topics = ["Markets", "Economy", "Technology"].map((topic) => ({ topic, hasUnread: true }));
  let queued = null;
  let randomized = false;
  let weatherStopped = 0;
  const headlineDuplicates = { current: new Map() };
  const headlineFullscreenRequested = { current: false };
  const saved = [];
  const viewed = [];
  const context = {
    articles, feedView: "latest",
    createRandomHeadlineQueue: (items) => createRandomHeadlineQueue(items, () => 0),
    weatherAudio: { stop() { weatherStopped++; } },
    headlineDuplicates,
    headlineFullscreenRequested,
    setHeadlineQueueRandomized: (value) => { randomized = value; },
    setHeadlineQueue: (value) => { queued = value; },
    navigator: { userAgent: "Windows" },
    document: { fullscreenElement: null, documentElement: {} },
    setArticles: (update) => { latest = update(latest); },
    setHistoryArticles: (update) => { history = update(history); },
    setTopicRefreshStates: (update) => { topics = update(topics); },
    articleStore: { async setRead(url) { saved.push(url); } },
    refreshStore: { async markViewed(topic) { viewed.push(topic); } },
    setNotice: (notice) => assert.fail(notice),
  };
  runInNewContext(`${code}\n${randomCode}\nthis.markRead = markArticleRead;\nthis.startRandom = startRandomHeadlinePlayback;`, context);
  context.startRandom();
  assert.equal(weatherStopped, 1);
  assert.equal(randomized, true);
  assert.deepEqual(queued, [articles[2], articles[0]]);
  assert.deepEqual(headlineDuplicates.current.get(articles[0].url), [articles[0], articles[1]]);
  const queue = createUnreadHeadlineQueue(articles);
  context.markRead(queue.articles[0], true, queue.duplicates.get(queue.articles[0].url));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, articles.slice(0, 2).map((article) => article.url));
  assert.deepEqual(viewed, ["Markets", "Economy"]);
  assert.deepEqual(Array.from(latest, (article) => !!article.isRead), [true, true, false]);
  assert.deepEqual(Array.from(history, (article) => !!article.isRead), [true, true, false]);
  assert.deepEqual(Array.from(topics, (topic) => topic.hasUnread), [false, false, true]);
  assert.equal(latest[2], articles[2]);
  assert.deepEqual(createUnreadHeadlineQueue(latest).articles, [articles[2]]);
});
