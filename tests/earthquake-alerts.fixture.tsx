import React from "react";
import { createRoot } from "react-dom/client";
import { useEarthquakeAlerts } from "../app/EarthquakeAlerts";
import AppSettings from "../app/AppSettings";
import "../app/globals.css";
function Fixture() {
  const alerts = useEarthquakeAlerts("earthquake-test", true);
  return <main style={{ maxWidth: 700, padding: 20, margin: "auto" }}>
    <AppSettings briefing={<p>Briefing settings</p>} display={<p>Display settings</p>} notifications={alerts.controls} footer={null} />
    <button type="button" onClick={() => document.getElementById("player-test")?.requestFullscreen()}>Open player full screen</button>
    <div id="player-test"><p>Example player</p></div>
    {alerts.banner}
  </main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
