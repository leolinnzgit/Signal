import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import EarthquakeMap from "../app/EarthquakeMap";
import "../app/globals.css";
import "../app/earthquake-alerts.css";
function Fixture() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open disaster map</button><EarthquakeMap isOpen={open} onClose={() => setOpen(false)} /></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
