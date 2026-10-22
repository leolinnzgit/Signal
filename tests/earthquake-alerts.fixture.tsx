import React from "react";
import { createRoot } from "react-dom/client";
import { useEarthquakeAlerts } from "../app/EarthquakeAlerts";
import "../app/globals.css";
function Fixture() {
  const alerts = useEarthquakeAlerts("earthquake-test", true);
  return <main style={{ maxWidth: 700, padding: 20, margin: "auto" }}>{alerts.banner}{alerts.controls}</main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
