import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { usePlayerBackNavigation } from "../app/usePlayerBackNavigation";
import NewsDashboard from "../app/NewsDashboard";
import "../app/globals.css";

function Fixture() {
  const [headlines, setHeadlines] = useState(false);
  const [reader, setReader] = useState(false);
  usePlayerBackNavigation([
    ...(headlines ? ["headlines" as const] : []),
    ...(reader ? ["reader" as const] : []),
  ], remaining => {
    setHeadlines(remaining.includes("headlines"));
    setReader(remaining.includes("reader"));
  });
  return <main>
    <p data-testid="view">{reader ? "reader" : headlines ? "headlines" : "feed"}</p>
    <button onClick={() => setHeadlines(true)}>Open headlines</button>
    <button onClick={() => setReader(true)}>Open reader</button>
    <button onClick={() => setReader(false)}>Close reader</button>
    <button onClick={() => setHeadlines(false)}>Close headlines</button>
    <button onClick={() => { setHeadlines(false); setReader(false); }}>Close all</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  {location.search.includes("dashboard")
    ? <NewsDashboard user={{ displayName: "Preview", email: "preview@localhost", fullName: null, isLocalPreview: true }} />
    : <Fixture />}
</React.StrictMode>);
