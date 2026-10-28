"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import ArticleAudioPlayer from "./ArticleAudioPlayer";
import { SharedListeningClient, sharedListeningKey, type SharedStory } from "./shared-listening";
import { ListenLaterProvider } from "./ListenLater";
const Context = createContext<{ client: SharedListeningClient | null; revision: number }>({ client: null, revision: 0 });

export function SharedListeningProvider({ email, children }: { email: string; children: ReactNode }) {
  const [revision, redraw] = useState(0);
  const [client, setClient] = useState<SharedListeningClient | null>(null);
  useEffect(() => {
    const client = new SharedListeningClient(email, typeof localStorage === "undefined" ? null : localStorage, () => redraw(value => value + 1));
    setClient(client);
    const sync = () => { if (!document.hidden) void client.sync(); };
    const signout = (event: Event) => { if ((event as CustomEvent<string>).detail === email.toLowerCase()) client.dispose(true); };
    const storage = (event: StorageEvent) => { if (event.key === sharedListeningKey(email) && event.newValue === null) { client.dispose(); setClient(null); } };
    sync(); const timer = setInterval(sync, 15000);
    window.addEventListener("online", sync); document.addEventListener("visibilitychange", sync); window.addEventListener("signal.shared-listening-signout", signout);
    window.addEventListener("storage", storage);
    return () => { client.dispose(); clearInterval(timer); window.removeEventListener("storage", storage); window.removeEventListener("online", sync); document.removeEventListener("visibilitychange", sync); window.removeEventListener("signal.shared-listening-signout", signout); };
  }, [email]);
  return <Context.Provider value={{ client, revision }}><ListenLaterProvider email={email}>{children}</ListenLaterProvider></Context.Provider>;
}
export function useSharedListeningReporter(storyUrl: string | undefined, title: string, source: string, imageUrl: string | undefined, parts: string[], offset = 0) {
  const { client } = useContext(Context), lease = useRef({ id: "", started: false, finished: false });
  const latest = useRef({ client, storyUrl, title, source, imageUrl, parts, offset }); latest.current = { client, storyUrl, title, source, imageUrl, parts, offset };
  return {
    track(partIndex: number, playing: boolean) {
      const value = latest.current; if (!value.client || !value.storyUrl || !value.parts.length) return;
      partIndex += value.offset;
      if (playing && (!lease.current.started || lease.current.finished)) {
        lease.current = { id: crypto.randomUUID(), started: true, finished: false }; value.client.begin(lease.current.id);
      }
      if (!lease.current.started || lease.current.finished || partIndex < 0 || partIndex >= value.parts.length) return;
      const safeImage = (() => { try { const url = new URL(value.imageUrl || ""); return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048 && !["localhost", "[::1]"].includes(url.hostname) && !/^127\./u.test(url.hostname) ? url.href : ""; } catch { return ""; } })();
      value.client.report(lease.current.id, { url: value.storyUrl, title: value.title, source: value.source, imageUrl: safeImage, parts: value.parts, partIndex });
    },
    complete() { if (lease.current.started && !lease.current.finished) { latest.current.client?.finish(lease.current.id); lease.current.finished = true; } },
  };
}

export function useSavedListeningSummary() {
  const { client } = useContext(Context); return { available: !!client, hasStory: !!client?.saved() };
}
export function SharedListeningResume({ beforePlay }: { beforePlay?: () => void }) {
  const { client } = useContext(Context), [open, setOpen] = useState(false), [story, setStory] = useState<SharedStory | null>(null);
  const [starting, setStarting] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const saved = client?.saved();
  async function resume() {
    if (!client || starting) return; setStarting(true);
    if (navigator.onLine) await Promise.race([client.sync(), new Promise<void>(resolve => setTimeout(resolve, 3000))]);
    if (!active.current) return;
    if (client.saved()) {
      beforePlay?.();
      setStory(structuredClone(client.saved())); setOpen(true);
    }
    setStarting(false);
  }
  return client && (saved || client.message || open) ? <section className="shared-listening-resume" aria-label="Shared listening progress">
    {saved && <>
      <strong>Resume listening</strong><p>{saved.title} · Section {saved.partIndex + 1} of {saved.parts.length}</p>
      <button type="button" disabled={starting || open} onClick={() => void resume()}>{starting ? "Checking saved position…" : "Resume saved story"}</button>
      <button type="button" disabled={open} onClick={() => client.forget()}>Forget saved position</button>
    </>}
    {client.message && <p role="status">{client.message}</p>}
    {open && story && <SavedStoryDialog story={story} close={() => { setOpen(false); setStory(null); }} />}
  </section> : null;
}
function SavedStoryDialog({ story, close }: { story: SharedStory; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const sections = useRef(story.parts.slice(story.partIndex).map((text, index) => ({ text, paragraphIndex: story.partIndex + index, start: 0, end: text.length })));
  return <dialog ref={dialog} className="watch-listening-handoff" aria-label="Resume saved story" onCancel={event => { event.preventDefault(); close(); }}>
    <button type="button" onClick={close}>Close saved story</button><h2>{story.title}</h2><p>{story.source} · Saved section {story.partIndex + 1} of {story.parts.length}</p>
    <ArticleAudioPlayer title={story.title} source={story.source} storyUrl={story.url} storyImageUrl={story.imageUrl} paragraphs={story.parts}
      narrationSections={sections.current} progressParts={story.parts} progressOffset={story.partIndex} defaultMode={navigator.onLine ? "recorded" : "browser"} restoreCachedPosition={false} autoPrepare />
    <details><summary>Read saved story</summary>{story.parts.map((part,index) => <p key={index}>{part}</p>)}</details>
  </dialog>;
}
