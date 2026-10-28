"use client";
import { useRef, useState, type KeyboardEvent } from "react";
import { ListenLater, useListenLaterCount } from "./ListenLater";
import { SharedListeningResume, useSavedListeningSummary } from "./SharedListening";

export default function ListeningLibrary({ beforePlay }: { beforePlay?: () => void }) {
  const saved = useSavedListeningSummary(), count = useListenLaterCount();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false), [tab, setTab] = useState<"resume" | "later">("later");
  if (!saved.available && count === null) return null;
  function selectWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "resume" : event.key === "End" ? "later" : tab === "resume" ? "later" : "resume";
    setTab(next); document.getElementById(`listening-tab-${next}`)?.focus();
  }
  return <>
    <button type="button" className="listening-library-toggle" aria-label="Listening library" title="Resume listening or manage Listen later"
      aria-haspopup="dialog" aria-expanded={open} aria-controls="listening-library" onClick={() => {
        setTab(saved.hasStory ? "resume" : "later"); dialog.current?.showModal(); setOpen(true);
      }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-3a8 8 0 0 1 16 0v3M4 13H3v7h4v-7Zm16 0h1v7h-4v-7Z" /></svg>
      {!!count && <span className="listening-library-count" aria-hidden="true">{count}</span>}
      {!count && saved.hasStory && <span className="listening-library-dot" aria-hidden="true" />}
    </button>
    <dialog ref={dialog} id="listening-library" className="listening-library-dialog" aria-labelledby="listening-library-title" onClose={() => setOpen(false)}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
      }}>
      <header className="listening-library-heading"><div><p>Your audio</p><h2 id="listening-library-title">Listening</h2></div>
        <button type="button" autoFocus aria-label="Close listening library" onClick={() => dialog.current?.close()}>×</button>
      </header>
      <div className="listening-library-tabs" role="tablist" aria-label="Listening options" onKeyDown={selectWithKeyboard}>
        <button type="button" role="tab" id="listening-tab-resume" aria-controls="listening-panel-resume" aria-selected={tab === "resume"} tabIndex={tab === "resume" ? 0 : -1} onClick={() => setTab("resume")}>Resume</button>
        <button type="button" role="tab" id="listening-tab-later" aria-controls="listening-panel-later" aria-selected={tab === "later"} tabIndex={tab === "later" ? 0 : -1} onClick={() => setTab("later")}>Listen later <span>{count ?? 0}</span></button>
      </div>
      {open && <div className="listening-library-body">
        <div role="tabpanel" id="listening-panel-resume" aria-labelledby="listening-tab-resume" hidden={tab !== "resume"}>
          {!saved.hasStory && <div className="listening-library-empty"><h3>Nothing to resume yet</h3><p>Play a full story on your phone or Watch to save your place.</p></div>}
          <SharedListeningResume beforePlay={beforePlay} />
        </div>
        <div role="tabpanel" id="listening-panel-later" aria-labelledby="listening-tab-later" hidden={tab !== "later"}>
          <ListenLater beforePlay={beforePlay} />
        </div>
      </div>}
    </dialog>
  </>;
}
