"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ArticleAudioPlayer from "./ArticleAudioPlayer";
import { changeListeningHandoff, handoffNarrationSections, readListeningHandoff, receiverToken, type ListeningHandoff } from "./listening-handoff";

export default function WatchListeningHandoff({ id, onClose }: { id: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [key] = useState(() => receiverToken(id));
  const [offer, setOffer] = useState<ListeningHandoff | null>(null);
  const [phase, setPhase] = useState<"loading" | "offered" | "waiting" | "playing">("loading");
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const sections = useMemo(() => offer?.status === "ready" && offer.parts ? handoffNarrationSections(offer) : undefined, [offer]);
  useEffect(() => {
    const element = dialog.current; element?.showModal();
    const abort = new AbortController(); operation.current = abort;
    void readListeningHandoff(id, key, abort.signal).then(value => {
      if (!abort.signal.aborted) { setOffer(value); setPhase("offered"); if (value.status === "cancelled") setError("This transfer was cancelled. Start again on your watch."); }
    }).catch(reason => { if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : "The transfer could not be opened."); setPhase("offered"); } });
    return () => { abort.abort(); operation.current?.abort(); element?.close(); };
  }, [id, key]);

  async function accept() {
    operation.current?.abort();
    const abort = new AbortController(); operation.current = abort;
    setPhase("waiting"); setError("");
    try {
      await changeListeningHandoff(id, "accept", key, abort.signal);
      for (let attempt = 0; attempt < 21; attempt++) {
        const value = await readListeningHandoff(id, key, abort.signal);
        if (abort.signal.aborted) return;
        setOffer(value);
        if (value.status === "cancelled") throw new Error("The transfer was cancelled. Your watch can continue listening.");
        if (value.status === "ready") {
          if (!value.parts) throw new Error("This transfer was claimed in another browser. Start again on your watch.");
          setPhase("playing"); return;
        }
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, 3000);
          abort.signal.addEventListener("abort", stop, { once: true });
          if (abort.signal.aborted) stop();
        });
      }
      throw new Error("Your watch has not confirmed pausing. Start a new transfer on the watch; phone audio has not started.");
    } catch (reason) {
      if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : "The transfer failed. Try again on your watch."); setPhase("offered"); }
    }
  }
  function close() {
    operation.current?.abort();
    if (phase !== "playing") void changeListeningHandoff(id, "cancel", key, AbortSignal.timeout(5000)).catch(() => {});
    onClose();
  }
  return <dialog ref={dialog} className="watch-listening-handoff" aria-labelledby="watch-handoff-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="watch-handoff-header"><span className="eyebrow">SIGNAL · FROM YOUR WATCH</span>
      <button type="button" onClick={close} aria-label="Close listening transfer">×</button></div>
    <h2 id="watch-handoff-title">Continue listening on your phone</h2>
    {offer && <><h3 dir="auto">{offer.title}</h3><p>{offer.source} · Section {offer.partIndex + 1} of {offer.partCount}</p></>}
    {phase === "loading" && <p role="status">Opening your watch transfer…</p>}
    {phase === "offered" && <>
      <p>Your watch will pause before phone playback starts. Continue from the latest confirmed section.</p>
      {offer?.status !== "cancelled" && <button type="button" className="watch-handoff-continue" onClick={() => void accept()}>{error ? "Retry transfer" : "Continue on phone"}</button>}
      <button type="button" onClick={close}>Not now</button>
    </>}
    {phase === "waiting" && <><p role="status">Waiting for your watch to pause and confirm its section…</p><button type="button" onClick={close}>Cancel transfer</button></>}
    {phase === "playing" && offer && sections && <>
      <p role="status">Your watch is paused. If your browser requires it, tap Play below.</p>
      <ArticleAudioPlayer key={id} title={offer.title} source={offer.source} paragraphs={offer.parts!}
        narrationSections={sections} restoreCachedPosition={false} autoPrepare />
      <details><summary>Read transferred story</summary>{offer.parts!.map((part, index) => <p key={index} dir="auto">{part}</p>)}</details>
      <a href={offer.url} target="_blank" rel="noreferrer">Open publisher’s article ↗</a>
    </>}
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
