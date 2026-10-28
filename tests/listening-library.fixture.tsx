import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import NewsDashboard from "../app/NewsDashboard";
import { SharedListeningProvider } from "../app/SharedListening";
import "../app/globals.css";
createRoot(document.getElementById("root")!).render(<StrictMode>
  <SharedListeningProvider email="owner@example.com"><NewsDashboard
    user={{ displayName: "Signal Reader", email: "owner@example.com", fullName: null, isLocalPreview: true }}
    onOpenCommunity={() => {}} onOpenLatestComments={() => {}} onManageAccount={() => {}} onSignOut={() => {}} />
  </SharedListeningProvider>
</StrictMode>);
