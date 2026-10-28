import { validateSharedProgress, type SharedStory } from "./shared-listening";
export type ListeningQueue = { items: SharedStory[]; currentUrl: string | null };
export type QueueProgress = { accountKey: string; accountEmail: string; version: string; state: "empty" | "active" | "completed" | "forgotten"; updatedAt: string; document: ListeningQueue | null };
type Mutation = { accountKey: string; baseVersion: string; operationId: string; action: "save"; document: ListeningQueue };
const version = (v: unknown) => v === "0" || typeof v === "string" && /^[a-f0-9]{32}$/u.test(v);
export function queueImage(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048
      && !["localhost", "[::1]"].includes(url.hostname) && !/^127\./u.test(url.hostname) ? url.href : "";
  } catch { return ""; }
}
export function validateQueue(document: ListeningQueue): ListeningQueue {
  if (!document || !Array.isArray(document.items) || document.items.length > 10
    || new Set(document.items.map(item => item?.url)).size !== document.items.length
    || (document.items.length ? !document.items.some(item => item.url === document.currentUrl) : document.currentUrl !== null)) throw new Error("Listen later holds up to 10 unique stories.");
  for (const item of document.items) {
    validateSharedProgress({ accountKey: "A".repeat(64), accountEmail: "", version: "0", state: "active", updatedAt: new Date().toISOString(), document: item });
    if (typeof item.imageUrl !== "string" || item.imageUrl && !queueImage(item.imageUrl)) throw new Error("The queued image link is invalid.");
    const url = new URL(item.url);
    if (["localhost", "[::1]"].includes(url.hostname) || /^127\./u.test(url.hostname)) throw new Error("The queued story link is invalid.");
  }
  if (document.items.reduce((sum, item) => sum + item.parts.join("").length, 0) > 100_000) throw new Error("Listen later is full. Remove a story before adding more.");
  return document;
}
export function validateQueueProgress(raw: unknown): QueueProgress {
  const state = raw as QueueProgress;
  if (!state || !/^[A-F0-9]{64}$/u.test(state.accountKey) || typeof state.accountEmail !== "string" || !version(state.version)
    || !["empty", "active", "completed", "forgotten"].includes(state.state) || !Number.isFinite(Date.parse(state.updatedAt))
    || (state.state === "active") !== !!state.document) throw new Error("Listen later could not be read.");
  if (state.document) validateQueue(state.document);
  return state;
}
export const listeningQueueKey = (email: string) => `signal.listening-queue.v1.${encodeURIComponent(email.toLowerCase())}`;
/** Whole-queue CAS: only an acknowledgement of our own write can advance an offline edit's base. */
export class ListeningQueueClient {
  progress: QueueProgress | null = null;
  pending: Mutation | null = null;
  message = "";
  private writer = "";
  private blocked = false;
  private running: Promise<void> | null = null;
  private dead = false;
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly email: string, private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
    private changed: () => void = () => {}, private fetcher: typeof fetch = fetch, private autoSync = true) {
    try {
      const raw = storage?.getItem(listeningQueueKey(email));
      if (raw && raw.length <= 1_200_000) {
        const value = JSON.parse(raw);
        const progress = value.progress ? validateQueueProgress(value.progress) : null;
        if (progress && progress.accountEmail.toLowerCase() !== email.toLowerCase()) throw new Error("Account changed");
        const pending = value.pending as Mutation | null;
        if (pending) {
          if (!version(pending.baseVersion) || !/^[a-f0-9]{32}$/u.test(pending.operationId) || pending.action !== "save"
            || (progress ? pending.accountKey !== progress.accountKey : pending.accountKey !== "")) throw new Error("Invalid pending queue");
          validateQueue(pending.document);
        }
        this.progress = progress; this.pending = pending;
      }
    } catch { this.progress = null; this.pending = null; }
  }
  saved(): ListeningQueue { return this.pending?.document ?? this.progress?.document ?? { items: [], currentUrl: null }; }
  private persist() {
    if (this.dead) return;
    // Do not retain removed story text in the old acknowledged cache.
    const progress = this.pending && this.progress ? { ...this.progress, state: "active", document: this.pending.document } : this.progress;
    try { this.storage?.setItem(listeningQueueKey(this.email), JSON.stringify({ progress, pending: this.pending })); }
    catch { this.message = "Browser storage is unavailable. Keep this page open to sync Listen later."; }
    this.changed();
  }
  private edit(document: ListeningQueue) {
    if (this.dead) return;
    validateQueue(document);
    if (JSON.stringify(document) === JSON.stringify(this.saved())) return;
    this.pending = { accountKey: this.progress?.accountKey ?? "", baseVersion: this.pending?.baseVersion ?? this.progress?.version ?? "0",
      operationId: crypto.randomUUID().replaceAll("-", ""), action: "save", document: structuredClone(document) };
    this.message = "Listen later saved here. Sync pending."; this.persist();
    if (this.autoSync && !this.timer) this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, 1500);
  }
  add(story: SharedStory) {
    const doc = structuredClone(this.saved());
    if (doc.items.some(item => item.url === story.url)) return;
    doc.items.push(structuredClone(story)); doc.currentUrl ??= story.url; this.edit(doc);
  }
  remove(url: string) {
    const doc = structuredClone(this.saved()), index = doc.items.findIndex(item => item.url === url);
    if (index < 0) return;
    doc.items.splice(index, 1);
    if (doc.currentUrl === url) { doc.currentUrl = doc.items[index]?.url ?? doc.items[0]?.url ?? null; this.blocked = true; }
    this.edit(doc);
  }
  move(url: string, delta: number) {
    const doc = structuredClone(this.saved()), index = doc.items.findIndex(item => item.url === url), next = index + delta;
    if (index < 0 || next < 0 || next >= doc.items.length) return;
    [doc.items[index], doc.items[next]] = [doc.items[next], doc.items[index]]; this.edit(doc);
  }
  begin(id: string, url: string) {
    const doc = structuredClone(this.saved());
    if (this.dead || !doc.items.some(item => item.url === url)) return false;
    this.writer = id; this.blocked = false; doc.currentUrl = url; this.edit(doc); return true;
  }
  track(id: string, url: string, partIndex: number) {
    if (this.dead || this.blocked || this.writer !== id) return;
    const doc = structuredClone(this.saved()), story = doc.items.find(item => item.url === url);
    if (!story || doc.currentUrl !== url || !Number.isInteger(partIndex) || partIndex < 0 || partIndex >= story.parts.length) return;
    story.partIndex = partIndex; this.edit(doc);
  }
  finish(id: string, url: string): SharedStory | null {
    if (this.dead || this.blocked || this.writer !== id || this.saved().currentUrl !== url) return null;
    const index = this.saved().items.findIndex(item => item.url === url);
    // Consumption keeps queue order, including additions/reorders made during local playback.
    this.remove(url); this.blocked = false;
    const doc = this.saved(), next = doc.items[index] ?? doc.items[0];
    if (next) this.begin(id, next.url);
    return next ? structuredClone(next) : null;
  }
  private adopt(state: QueueProgress, own = false) {
    if (state.accountEmail.toLowerCase() !== this.email.toLowerCase() || this.progress && state.accountKey !== this.progress.accountKey) throw new Error("The Signal account changed. Sign in again.");
    if (!own && this.writer && state.version !== this.progress?.version) { this.blocked = true; this.message = "Listen later changed on another device. Reopen it to use the latest queue."; }
    this.progress = state;
  }
  sync(): Promise<void> {
    if (this.dead || !this.autoSync) return Promise.resolve();
    return this.running ??= this.run().finally(() => { this.running = null; });
  }
  private async run() {
    const fetcher = this.fetcher, signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]);
    try {
      if (!this.progress) {
        const response = await fetcher("/api/listening-queue", { credentials: "same-origin", cache: "no-store", signal });
        if (!response.ok) throw new Error("Listen later is unavailable. Your local queue is kept.");
        this.adopt(validateQueueProgress(await response.json()), true);
        if (this.pending) this.pending.accountKey = this.progress!.accountKey;
      }
      for (let n = 0; this.pending && n < 3 && !this.dead; n++) {
        const sent = structuredClone(this.pending);
        const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
        if (!csrf.ok) throw new Error("Sign in again to sync Listen later.");
        const { token } = await csrf.json(); if (!token) throw new Error("Sign in again to sync Listen later.");
        signal.throwIfAborted();
        const response = await fetcher("/api/listening-queue", { method: "POST", credentials: "same-origin", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token }, body: JSON.stringify(sent) });
        if (!response.ok && response.status !== 409) throw new Error("Listen later sync is unavailable. Your local queue is kept.");
        const state = validateQueueProgress(await response.json()); this.adopt(state, response.ok);
        if (response.status === 409) { this.pending = null; this.blocked = true; this.message = "The newer queue was kept. Reopen Listen later before making more changes."; }
        else {
          if (this.pending?.operationId === sent.operationId) this.pending = null;
          else if (this.pending?.baseVersion === sent.baseVersion) this.pending.baseVersion = state.version;
          this.message = "Listen later synced.";
        }
        this.persist();
      }
      if (this.dead || this.pending) return;
      const response = await fetcher("/api/listening-queue", { credentials: "same-origin", cache: "no-store", signal, headers: { "X-Signal-Progress-Account": this.progress!.accountKey } });
      if (!response.ok) throw new Error("Listen later is unavailable. Your local queue is kept.");
      // A user may have edited while the GET was in flight. Never overwrite that outbox.
      const value = validateQueueProgress(await response.json());
      if (!this.pending) { this.adopt(value); this.persist(); }
    } catch (error) {
      if (!this.dead) { this.message = this.pending ? "Offline or unavailable. Listen later is saved here and will retry." : error instanceof Error ? error.message : "Listen later is unavailable."; this.persist(); }
    }
  }
  dispose(clear = false) { this.dead = true; this.abort.abort(); if (this.timer) clearTimeout(this.timer); if (clear) try { this.storage?.removeItem(listeningQueueKey(this.email)); } catch { /* Optional storage. */ } }
}
