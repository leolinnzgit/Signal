import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import WeatherAudio from "../app/WeatherAudio";
import NewsDashboard from "../app/NewsDashboard";
import "../app/globals.css";
function Fixture() {
  const [text, setText] = useState("Here is your weather for Auckland. Currently clear, 17 degrees Celsius. Today, expect a high of 21 and a low of 12 degrees Celsius.");
  const [suspended, setSuspended] = useState(false);
  const [mounted, setMounted] = useState(true);
  return <main>
    {mounted && <WeatherAudio text={text} suspended={suspended} />}
    <button onClick={() => setText("Here is your updated weather. Currently rain, 18 degrees Celsius.")}>Refresh weather</button>
    <button onClick={() => setSuspended((value) => !value)}>Toggle other audio</button>
    <button onClick={() => setMounted((value) => !value)}>Toggle dashboard</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode>{location.search.includes("dashboard") ? <NewsDashboard user={{ displayName: "Preview", email: "preview@localhost", fullName: null, isLocalPreview: true }} /> : <Fixture />}</React.StrictMode>);
