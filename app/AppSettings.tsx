"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import "./app-settings.css";

type Category = "briefing" | "display" | "notifications";

export default function AppSettings({ briefing, display, notifications, footer }: {
  briefing: ReactNode; display: ReactNode; notifications: ReactNode; footer: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>("briefing");

  useEffect(() => {
    const followSettingsLink = () => {
      if (!["#settings", "#earthquake-alerts"].includes(window.location.hash)) return;
      if (window.location.hash === "#earthquake-alerts") setCategory("notifications");
      if (!dialog.current?.open) dialog.current?.showModal();
      setOpen(true);
    };
    followSettingsLink();
    window.addEventListener("hashchange", followSettingsLink);
    return () => window.removeEventListener("hashchange", followSettingsLink);
  }, []);

  useEffect(() => {
    if (open && category === "notifications" && window.location.hash === "#earthquake-alerts")
      document.getElementById("earthquake-alerts")?.scrollIntoView({ block: "start" });
  }, [open, category]);

  return <>
    <button type="button" className="settings-toggle" title="Settings" aria-label="Settings"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.4 3-.6 2.3-1.5.9L5 5.6 2.5 9.9l1.7 1.7v1.8l-1.7 1.7L5 19.4l2.3-.6 1.5.9.6 2.3h5.2l.6-2.3 1.5-.9 2.3.6 2.5-4.3-1.7-1.7v-1.8l1.7-1.7L19 5.6l-2.3.6-1.5-.9-.6-2.3Z" /><circle cx="12" cy="12.5" r="3.2" /></svg>
    </button>
    <dialog ref={dialog} className="app-settings-dialog" aria-labelledby="app-settings-title" onClose={() => setOpen(false)}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)
          event.currentTarget.close();
      }}>
      <header className="app-settings-heading"><div><p>Make Signal yours</p><h2 id="app-settings-title">Settings</h2></div>
        <button type="button" autoFocus aria-label="Close settings" onClick={() => dialog.current?.close()}>×</button>
      </header>
      <nav className="app-settings-categories" aria-label="Settings categories">
        {([ ["briefing", "Briefing"], ["display", "Display"], ["notifications", "Notifications"] ] as const).map(([id, label]) =>
          <button key={id} type="button" aria-pressed={category === id} aria-controls="app-settings-content" onClick={() => setCategory(id)}>{label}</button>)}
      </nav>
      <div className="app-settings-content" id="app-settings-content">
        {category === "briefing" ? briefing : category === "display" ? display : notifications}
        {footer}
      </div>
    </dialog>
  </>;
}
