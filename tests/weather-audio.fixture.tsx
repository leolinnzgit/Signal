import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useWeatherAudio } from "../app/WeatherAudio";
import NewsDashboard from "../app/NewsDashboard";
import "../app/globals.css";
function Controls({ text, suspended }: { text: string; suspended: boolean }) {
  const weather = useWeatherAudio(text, suspended);
  return <div className="weather-speech-settings">
    <p data-testid="status">{weather.status}</p>
    <label><input type="checkbox" checked={weather.enabled} onChange={event => weather.changeEnabled(event.target.checked)} />Read weather on opening</label>
    <button disabled={!weather.available} onClick={weather.read}>Read weather now</button>
    <button onClick={weather.stop}>Stop reading</button>
  </div>;
}
function Fixture() {
  const [text, setText] = useState("Here is your weather for Auckland. Currently clear, 17 degrees Celsius, feeling like 15 degrees. Wind is 12 kilometres per hour. Today, expect rain, with a high of 21 and a low of 12 degrees Celsius. The chance of rain is 75 percent.");
  const [suspended, setSuspended] = useState(false);
  const [mounted, setMounted] = useState(true);
  return <main>
    {mounted && <Controls text={text} suspended={suspended} />}
    <button onClick={() => setText("Here is your updated weather. Currently rain, 18 degrees Celsius.")}>Refresh weather</button>
    <button onClick={() => setText("A weather update. ".repeat(50))}>Longer weather</button>
    <button onClick={() => setSuspended(value => !value)}>Toggle other audio</button>
    <button onClick={() => setMounted(value => !value)}>Toggle dashboard</button>
    <button>Normal interaction</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode>{location.search.includes("dashboard") ? <NewsDashboard user={{ displayName: "Preview", email: "preview@localhost", fullName: null, isLocalPreview: true }} /> : <Fixture />}</React.StrictMode>);
