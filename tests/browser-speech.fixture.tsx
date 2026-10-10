import React from "react";
import { createRoot } from "react-dom/client";
import BrowserArticleAudioPlayer from "../app/BrowserArticleAudioPlayer";

createRoot(document.getElementById("root")!).render(<BrowserArticleAudioPlayer
  title="Clean energy news"
  source="Test publisher"
  paragraphs={["Researchers developed new storage for solar energy.", "Independent trials will measure its cost."]}
  autoPrepare
/>);
