import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import HeadlinePlayer from "../app/HeadlinePlayer";
import NewsDashboard from "../app/NewsDashboard";
import "../app/globals.css";

const articles = [
  { title: "NVIDIA announces new chips", topics: ["NVIDIA"] },
  { title: "Microsoft expands its services", topics: ["Microsoft"] },
  { title: "Researchers report a discovery", topics: ["Science"] },
  { title: "Apple research update", topics: ["Science", "Apple"] },
  { title: "More news from NVIDIA", topics: ["NVIDIA"] },
].map((article, index) => ({ ...article, url: `https://example.com/${index}`, source: "Test news",
  publishedAt: new Date(Date.now() - index * 1000).toISOString(), summary: "Test article", providers: ["google"] }));

function Fixture() {
  const [playing, setPlaying] = useState(false);
  const query = new URLSearchParams(location.search);
  if (query.has("dashboard")) return <NewsDashboard user={{ displayName: "Preview", email: "preview@localhost", fullName: null, isLocalPreview: true }} />;
  return <main>
    <button onClick={() => setPlaying(true)}>Start briefing</button>
    {playing && <HeadlinePlayer articles={articles} startWithScreenOffAudio={query.has("recorded")}
      marketTopic={query.has("selected") ? "NVIDIA" : undefined}
      tickerOverrides={query.has("override") ? { nViDiA: "NVDA:NASDAQ" } : {}}
      onArticleRead={() => {}} onOpenArticle={() => {}} onListenArticle={() => {}} onClose={() => setPlaying(false)} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
