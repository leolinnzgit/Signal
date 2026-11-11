import React from "react";
import { createRoot } from "react-dom/client";
import NewsDashboard, { type FollowedArticle } from "../app/NewsDashboard";

const topics = ["AI", "USA", "Anthropic", "NVIDIA"];
const articles: FollowedArticle[] = Array.from({ length: 480 }, (_, index) => ({
  title: `Story ${index}: ${Array.from({ length: 12 }, (_, word) => `term${(index * 37 + word * 13) % 997}`).join(" ")}`,
  url: `https://example.com/story/${index}`, source: `Publisher ${index % 12}`,
  publishedAt: new Date(Date.now() - index * 1000).toISOString(), summary: `Report ${index} about ${topics[index % topics.length]}.`,
  topics: [topics[index % topics.length]], providers: ["google"], isRead: false,
}));
const saved = new Set<string>();
const calls = new Map<string, number>();
const snapshot = () => ({ articles: articles.map(article => saved.has(article.url) ? { ...article, isRead: true } : article), topics: topics.map(topic => ({ topic, hasUnread: true, lastError: "", lastViewedAt: null, lastAttemptedAt: null, lastSuccessfulAt: null, nextRefreshAt: null })), refreshedAt: new Date().toISOString(), historyTotal: articles.length, bookmarkTotal: 0 });
const history = { articles: [], historyTotal: articles.length, bookmarkTotal: 0, matchingTotal: 0, filterTotal: 0, hasMore: false, bookmarkedUrls: [], readUrls: [], topicFacets: [], providerFacets: [] };
Object.assign(window, { savedHeadlineReads: saved, headlineReadCalls: calls });
createRoot(document.getElementById("root")!).render(<NewsDashboard
  user={{ displayName: "Playback check", email: "performance@localhost", fullName: null, isLocalPreview: true }}
  refreshStore={{ load: async () => snapshot(), refresh: async () => snapshot(), markViewed: async () => {} }}
  articleStore={{ load: async () => history, sync: async () => history, setRead: async url => { saved.add(url); calls.set(url, (calls.get(url) ?? 0) + 1); }, setBookmark: async () => {} }}
/>);
