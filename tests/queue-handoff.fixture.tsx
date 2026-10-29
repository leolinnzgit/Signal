import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SharedListeningProvider } from "../app/SharedListening";
import ListeningLibrary from "../app/ListeningLibrary";
import WatchListeningHandoff from "../app/WatchListeningHandoff";
import "../app/globals.css";
const receive = new URLSearchParams(location.search).get("receive");
createRoot(document.getElementById("root")!).render(<StrictMode><SharedListeningProvider email="owner@example.com">
  <header className="site-header"><strong>SIGNAL</strong><ListeningLibrary /></header>
  <main style={{ padding: 24 }}><h1>Your briefing</h1><p>Sample stories stay in the briefing. Listening controls are in the library.</p></main>
  {receive && <WatchListeningHandoff id={receive} onClose={() => { location.href = location.pathname; }} />}
</SharedListeningProvider></StrictMode>);
