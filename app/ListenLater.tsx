"use client";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ArticleAudioPlayer from "./ArticleAudioPlayer";
import { recordedArticleNarrationSections } from "./headline-audio";
import { ListeningQueueClient, listeningQueueKey, queueImage } from "./listening-queue";
import type { SharedStory } from "./shared-listening";
import { BrowserQueueAudioStorage, QueueAudioDownloads } from "./offline-queue-audio";
import { useReadingVoices } from "./ReadingVoiceSelector";
import type { PreparedHeadlineAudio } from "./headline-audio";
const Context = createContext<{ client: ListeningQueueClient | null; audio: QueueAudioDownloads | null; revision: number; offline: boolean }>({ client: null, audio: null, revision: 0, offline: false });
const ClientContext = createContext<ListeningQueueClient | null>(null);
const EMPTY_QUEUE_URLS: ReadonlySet<string> = new Set();
const QueueUrlsContext = createContext<ReadonlySet<string>>(EMPTY_QUEUE_URLS);
export function ListenLaterProvider({ email, children, syncEnabled = true }: { email: string; children: ReactNode; syncEnabled?: boolean }) {
  const [client, setClient] = useState<ListeningQueueClient | null>(null), [revision, redraw] = useState(0);
  const [audio, setAudio] = useState<QueueAudioDownloads | null>(null);
  useEffect(() => {
    let browserStorage: Storage | null = null; try { browserStorage = localStorage; } catch { /* Optional storage. */ }
    const client = new ListeningQueueClient(email, browserStorage, () => redraw(value => value + 1), fetch, syncEnabled); setClient(client);
    const audio = new QueueAudioDownloads(email, new BrowserQueueAudioStorage(), () => redraw(value => value + 1), undefined, async signal => {
      const account = client.progress?.accountKey;
      if (!account) throw new Error("Connect and sync Listen later before downloading audio.");
      const response = await fetch("/api/listening-queue", { credentials: "same-origin", cache: "no-store", headers: { "X-Signal-Progress-Account": account }, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error("Sign in to the same Signal account before downloading audio.");
      const value = await response.json();
      if (value.accountKey !== account || value.accountEmail?.toLowerCase() !== email.toLowerCase()) throw new Error("The Signal account changed. Reopen Signal and try again.");
    }); setAudio(audio);
    try { audio.autoRemove = browserStorage?.getItem(`signal.queue-audio.keep.${email.toLowerCase()}`) !== "true"; } catch { /* Optional preference. */ }
    void audio.refresh();
    const sync = () => { if (!document.hidden) void client.sync(); };
    const signout = (event: Event) => { if ((event as CustomEvent<string>).detail === email.toLowerCase()) { client.dispose(true); audio.dispose(true); setClient(null); setAudio(null); } };
    const storage = (event: StorageEvent) => { if (event.key === listeningQueueKey(email) && event.newValue === null) { client.dispose(); audio.dispose(); setClient(null); setAudio(null); } };
    sync(); const timer = setInterval(sync, 15000);
    window.addEventListener("online", sync); document.addEventListener("visibilitychange", sync);
    window.addEventListener("signal.shared-listening-signout", signout); window.addEventListener("storage", storage);
    return () => { client.dispose(); audio.dispose(); clearInterval(timer); window.removeEventListener("online", sync); document.removeEventListener("visibilitychange", sync); window.removeEventListener("signal.shared-listening-signout", signout); window.removeEventListener("storage", storage); };
  }, [email, syncEnabled]);
  useEffect(() => { if (audio && client?.progress) void audio.retain(client.saved().items); }, [audio, client, revision]);
  const queuedUrlKey = client ? client.saved().items.map(item => item.url).join("\n") : "";
  const queuedUrls = useMemo(
    () => (queuedUrlKey ? new Set(queuedUrlKey.split("\n")) : EMPTY_QUEUE_URLS),
    [queuedUrlKey],
  );
  const contextValue = useMemo(
    () => ({ client, audio, revision, offline: !syncEnabled }),
    [client, audio, revision, syncEnabled],
  );
  return <ClientContext.Provider value={client}><QueueUrlsContext.Provider value={queuedUrls}><Context.Provider value={contextValue}>{children}</Context.Provider></QueueUrlsContext.Provider></ClientContext.Provider>;
}
export function useListeningQueueClient() { return useContext(ClientContext); }
export function useListenLaterCount() {
  const { client } = useContext(Context); return client ? client.saved().items.length : null;
}
export const ListenLaterButton = memo(function ListenLaterButton({ url, title, source, imageUrl = "", paragraphs, compact = false }: { url: string; title: string; source: string; imageUrl?: string; paragraphs?: string[]; compact?: boolean }) {
  const client = useContext(ClientContext);
  const queuedUrls = useContext(QueueUrlsContext);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => () => lifetime.current?.abort(), []);
  if (!client) return null;
  const queued = queuedUrls.has(url);
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
});
export function ListenLater({ beforePlay }: { beforePlay?: () => void }) {
  const { client, audio, offline } = useContext(Context), [story, setStory] = useState<SharedStory | null>(null), [starting, setStarting] = useState(false);
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
    <p>Save full stories here, then listen on your phone or Watch. Download recorded audio for offline listening, or use a device voice with the saved text. Finished stories leave the queue.</p>
    {audio && <QueueAudioControls audio={audio} stories={queue.items} offline={offline} />}
    {queue.items.length > 0 ? <>
      <button type="button" disabled={starting || !!story} onClick={() => void play(queue.currentUrl!)}>{starting ? "Checking queue…" : "Play Listen later"}</button>
      <ol>{queue.items.map((item, index) => <li key={item.url}>
        <div><strong>{item.title}</strong><small>{item.source} · Section {item.partIndex + 1}/{item.parts.length}{queue.currentUrl === item.url ? " · Up next" : ""}</small></div>
        <div className="listen-later-actions">
          {audio && <QueueStoryAudio audio={audio} story={item} offline={offline} />}
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
function QueueAudioControls({ audio, stories, offline }: { audio: QueueAudioDownloads; stories: SharedStory[]; offline: boolean }) {
  const voices = useReadingVoices(), [, redraw] = useState(0);
  return <details className="queue-audio-downloads"><summary>Offline audio · {(audio.records.reduce((sum, item) => sum + item.blob.size, 0) / 1048576).toFixed(1)} / 100 MB</summary>
    <p>Downloads stay on this device, using the selected recorded voice. Keep Signal open until finished. Your browser may clear downloads when storage is low.</p>
    <button type="button" disabled={offline || !navigator.onLine || audio.busy || !stories.length || voices.loading} onClick={() => void audio.download(stories, voices.preferences, navigator.language)}>Download queue audio</button>
    {audio.busy && <button type="button" onClick={() => audio.cancel()}>Cancel audio downloads</button>}
    <button type="button" disabled={!audio.records.length && !audio.busy} onClick={() => void audio.remove()}>Clear downloaded audio</button>
    <label><input type="checkbox" checked={audio.autoRemove} onChange={event => { audio.autoRemove = event.target.checked; try { localStorage.setItem(`signal.queue-audio.keep.${audio.account}`, String(!audio.autoRemove)); } catch { /* Optional preference. */ } redraw(value => value + 1); if (audio.autoRemove) void audio.retain(stories); }} />Remove audio when stories leave the queue</label>
    {audio.message && <p role="status">{audio.message}</p>}
  </details>;
}
function QueueStoryAudio({ audio, story, offline }: { audio: QueueAudioDownloads; story: SharedStory; offline: boolean }) {
  function download() { let voices = { en: "", zh: "" }; try { voices = JSON.parse(localStorage.getItem("signal.recorded-reading-voices.v1") ?? "null") ?? voices; } catch { /* Automatic voice. */ } void audio.download([story], voices, navigator.language); }
  return <>{audio.saved(story) ? <button type="button" aria-label={`Remove downloaded audio: ${story.title}`} onClick={() => void audio.remove(story.url)}>Audio saved ✓</button>
    : <button type="button" disabled={offline || !navigator.onLine || audio.busy} aria-label={`Download audio: ${story.title}`} onClick={download}>{audio.current === story.url ? `Downloading ${audio.progress}%` : "Download audio"}</button>}</>;
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
  const { audio } = useContext(Context);
  const [download, setDownload] = useState<{ ready: boolean; audio?: PreparedHeadlineAudio }>({ ready: false });
  useEffect(() => { let active = true; void (audio?.recording(story) ?? Promise.resolve(undefined)).then(value => { if (active) setDownload({ ready: true, audio: value }); }); return () => { active = false; }; }, [audio, story]);
  const callbacks = useRef({ complete, track }); callbacks.current = { complete, track };
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const sections = useRef(story.parts.slice(story.partIndex).map((text, index) => ({ text, paragraphIndex: story.partIndex + index, start: 0, end: text.length })));
  return <dialog ref={dialog} className="watch-listening-handoff" aria-label="Listen later player" onCancel={event => { event.preventDefault(); if (!locked) close(); }}>
    <button type="button" disabled={locked} onClick={close}>Close Listen later player</button><h2>{story.title}</h2><p>{story.source} · Saved section {story.partIndex + 1}</p>
    {story.imageUrl && <img src={story.imageUrl} alt="" referrerPolicy="no-referrer" loading="lazy" style={{ width: "100%", maxHeight: 220, objectFit: "cover", borderRadius: 10 }} onError={event => { event.currentTarget.style.display = "none"; }} />}
    {download.ready && <ArticleAudioPlayer downloadedAudio={download.audio} queueTransfer={transfer} onTransferLockChange={onLock} title={story.title} source={story.source} storyUrl={story.url} storyImageUrl={story.imageUrl} paragraphs={story.parts}
      narrationSections={sections.current} progressParts={story.parts} progressOffset={story.partIndex} restoreCachedPosition={false} autoPrepare
      defaultMode={download.audio || !offline && navigator.onLine ? "recorded" : "browser"} onPlaybackComplete={() => callbacks.current.complete()}
      onReadingSectionChange={(section, playing) => { if (section) callbacks.current.track(section.paragraphIndex, playing); }} />}
    <details><summary>Read saved text</summary>{story.parts.map((text, index) => <p key={index}>{text}</p>)}</details>
  </dialog>;
}
