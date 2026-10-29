"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ArticleAudioPlayer from "./ArticleAudioPlayer";
import { recordedArticleNarrationSections } from "./headline-audio";
import { ListeningQueueClient, listeningQueueKey, queueImage } from "./listening-queue";
import type { SharedStory } from "./shared-listening";
const Context = createContext<{ client: ListeningQueueClient | null; revision: number; offline: boolean }>({ client: null, revision: 0, offline: false });
export function ListenLaterProvider({ email, children, syncEnabled = true }: { email: string; children: ReactNode; syncEnabled?: boolean }) {
  const [client, setClient] = useState<ListeningQueueClient | null>(null), [revision, redraw] = useState(0);
  useEffect(() => {
    let browserStorage: Storage | null = null; try { browserStorage = localStorage; } catch { /* Optional storage. */ }
    const client = new ListeningQueueClient(email, browserStorage, () => redraw(value => value + 1), fetch, syncEnabled); setClient(client);
    const sync = () => { if (!document.hidden) void client.sync(); };
    const signout = (event: Event) => { if ((event as CustomEvent<string>).detail === email.toLowerCase()) { client.dispose(true); setClient(null); } };
    const storage = (event: StorageEvent) => { if (event.key === listeningQueueKey(email) && event.newValue === null) { client.dispose(); setClient(null); } };
    sync(); const timer = setInterval(sync, 15000);
    window.addEventListener("online", sync); document.addEventListener("visibilitychange", sync);
    window.addEventListener("signal.shared-listening-signout", signout); window.addEventListener("storage", storage);
    return () => { client.dispose(); clearInterval(timer); window.removeEventListener("online", sync); document.removeEventListener("visibilitychange", sync); window.removeEventListener("signal.shared-listening-signout", signout); window.removeEventListener("storage", storage); };
  }, [email, syncEnabled]);
  return <Context.Provider value={{ client, revision, offline: !syncEnabled }}>{children}</Context.Provider>;
}
export function useListeningQueueClient() { return useContext(Context).client; }
export function useListenLaterCount() {
  const { client } = useContext(Context); return client ? client.saved().items.length : null;
}
export function ListenLaterButton({ url, title, source, imageUrl = "", paragraphs, compact = false }: { url: string; title: string; source: string; imageUrl?: string; paragraphs?: string[]; compact?: boolean }) {
  const { client } = useContext(Context), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => lifetime.current?.abort(), []);
  if (!client) return null;
  const queued = client.saved().items.some(item => item.url === url);
  async function add() {
    if (!client || busy) return;
    if (queued) { client.remove(url); return; }
    setBusy(true); setError(""); const abort = new AbortController(); lifetime.current = abort;
    try {
      let text = paragraphs;
      if (!text) {
        const response = await fetch(`/api/article-reader?${new URLSearchParams({ url })}`, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error("Connect to download this story for Listen later.");
        const result = await response.json(); text = result.available ? result.article?.paragraphs : null;
      }
      if (!text?.length) throw new Error("Full text is unavailable for this story. Open the publisher link to read it.");
      const parts = recordedArticleNarrationSections(title, text).map(section => section.text);
      const image = queueImage(imageUrl);
      if (!abort.signal.aborted) client.add({ url, title, source, imageUrl: image, parts, partIndex: 0 });
    } catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "This story could not be queued."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <span className={`listen-later-add${compact ? " listen-later-add-compact" : ""}`}><button type="button" aria-pressed={queued} aria-busy={busy} disabled={busy} onClick={() => void add()} aria-label={`${queued ? "Remove from" : "Add to"} Listen later: ${title}`} title={busy ? "Saving story text…" : queued ? "Remove from Listen later" : "Add to Listen later"}>
    {compact ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h10M4 12h10M4 18h7" />{queued ? <path d="m15 17 2 2 4-5" /> : <path d="M18 14v7m-3.5-3.5h7" />}</svg> : busy ? "Saving text…" : queued ? "Queued ✓" : "Listen later +"}</button>{error && <span role="status">{error}</span>}</span>;
}
export function ListenLater({ beforePlay }: { beforePlay?: () => void }) {
  const { client, offline } = useContext(Context), [story, setStory] = useState<SharedStory | null>(null), [starting, setStarting] = useState(false);
  const [lease, setLease] = useState("");
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!client) return null;
  const queue = client.saved();
  async function play(url: string) {
    if (!client || starting) return; setStarting(true);
    if (navigator.onLine) await Promise.race([client.sync(), new Promise<void>(resolve => setTimeout(resolve, 2500))]);
    if (!active.current) return;
    const item = client.saved().items.find(item => item.url === url);
    if (item) {
      const id = crypto.randomUUID();
      if (client.begin(id, item.url)) { setLease(id); beforePlay?.(); setStory(structuredClone(item)); }
    }
    setStarting(false);
  }
  return <section className="listen-later shared-listening-resume" aria-label="Listen later">
    <h2>Listen later <span>({queue.items.length}/10)</span></h2>
    <p>Save full stories here, then listen on your phone or Watch. Saved text works offline with a device voice. Finished stories leave the queue.</p>
    {queue.items.length > 0 ? <>
      <button type="button" disabled={starting || !!story} onClick={() => void play(queue.currentUrl!)}>{starting ? "Checking queue…" : "Play Listen later"}</button>
      <ol>{queue.items.map((item, index) => <li key={item.url}>
        <div><strong>{item.title}</strong><small>{item.source} · Section {item.partIndex + 1}/{item.parts.length}{queue.currentUrl === item.url ? " · Up next" : ""}</small></div>
        <div className="listen-later-actions">
          <button type="button" disabled={starting || !!story} onClick={() => void play(item.url)} aria-label={`Play ${item.title}`}>Play</button>
          <button type="button" disabled={index === 0} onClick={() => client.move(item.url, -1)} aria-label={`Move up: ${item.title}`}>↑</button>
          <button type="button" disabled={index === queue.items.length - 1} onClick={() => client.move(item.url, 1)} aria-label={`Move down: ${item.title}`}>↓</button>
          <button type="button" onClick={() => { client.remove(item.url); if (story?.url === item.url) setStory(null); }} aria-label={`Remove ${item.title}`}>Remove</button>
        </div>
      </li>)}</ol>
    </> : <p>Your queue is empty. Use Listen later beside a story to save it.</p>}
    {client.message && <p role="status">{client.message}</p>}
    {story && <QueueSessionPlayer story={story} lease={lease} client={client} offline={offline} close={() => setStory(null)} />}
  </section>;
}
export function QueueSessionPlayer({ story: initial, lease, client, close, offline = false }: { story: SharedStory; lease: string; client: ListeningQueueClient; close: () => void; offline?: boolean }) {
  const [story, setStory] = useState(initial), [locked, setLocked] = useState(false);
  const lock = useRef(false);
  const started = useRef(false), finished = useRef(false);
  function onLock(value: boolean) { lock.current = value; setLocked(value); }
  function complete() {
    if (!started.current || finished.current || lock.current) return;
    finished.current = true;
    const next = client.finish(lease, story.url);
    if (next) { started.current = false; finished.current = false; setStory(next); } else close();
  }
  return <QueueStory key={story.url} story={story} offline={offline} locked={locked} onLock={onLock} close={close} complete={complete}
    transfer={{ prepare: async partIndex => { client.track(lease, story.url, partIndex); return client.transferSnapshot(lease); },
      complete: (base, next) => { client.transferred(lease, base, next); close(); } }}
    track={(index, playing) => {
      if (playing) started.current = true;
      if (started.current && !finished.current && !lock.current) client.track(lease, story.url, index);
    }} />;
}
function QueueStory({ story, close, complete, track, offline, transfer, locked, onLock }: { story: SharedStory; close: () => void; complete: () => void; track: (index: number, playing: boolean) => void; offline: boolean; transfer: import("./ContinueOnWatch").QueueTransferSource; locked: boolean; onLock: (locked: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const callbacks = useRef({ complete, track }); callbacks.current = { complete, track };
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const sections = useRef(story.parts.slice(story.partIndex).map((text, index) => ({ text, paragraphIndex: story.partIndex + index, start: 0, end: text.length })));
  return <dialog ref={dialog} className="watch-listening-handoff" aria-label="Listen later player" onCancel={event => { event.preventDefault(); if (!locked) close(); }}>
    <button type="button" disabled={locked} onClick={close}>Close Listen later player</button><h2>{story.title}</h2><p>{story.source} · Saved section {story.partIndex + 1}</p>
    {story.imageUrl && <img src={story.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 10 }} onError={event => { event.currentTarget.style.display = "none"; }} />}
    <ArticleAudioPlayer queueTransfer={transfer} onTransferLockChange={onLock} title={story.title} source={story.source} storyUrl={story.url} storyImageUrl={story.imageUrl} paragraphs={story.parts}
      narrationSections={sections.current} progressParts={story.parts} progressOffset={story.partIndex} restoreCachedPosition={false} autoPrepare
      defaultMode={!offline && navigator.onLine ? "recorded" : "browser"} onPlaybackComplete={() => callbacks.current.complete()}
      onReadingSectionChange={(section, playing) => { if (section) callbacks.current.track(section.paragraphIndex, playing); }} />
    <details><summary>Read saved text</summary>{story.parts.map((text, index) => <p key={index}>{text}</p>)}</details>
  </dialog>;
}
