import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import DailyBriefingModal from "../app/DailyBriefingModal";
import "../app/globals.css";

function Fixture() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [revision, setRevision] = useState(0);
  const [closes, setCloses] = useState(0);
  Object.assign(window, { refreshDailyBriefing: () => setRevision(value => value + 1) });
  return <main>
    <button onClick={() => { setMinimized(false); setOpen(true); }}>Open daily briefing</button>
    <output data-testid="close-count">{closes}</output>
    {(open || minimized) && <DailyBriefingModal isOpen={open}
      onClose={() => { setCloses(value => value + 1); setMinimized(false); setOpen(false); }}
      isMinimized={minimized} onMinimizeChange={setMinimized}
      userTime={new Date(`2026-11-09T08:00:${String(revision % 60).padStart(2, "0")}+13:00`)}
      followedTopics={["Science"]} articles={[]} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
