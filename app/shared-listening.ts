import { validateListeningHandoff } from "./listening-handoff";
export type SharedStory = { url: string; title: string; source: string; imageUrl: string; parts: string[]; partIndex: number };
export type SharedProgress = { accountKey: string; accountEmail: string; version: string; state: "empty" | "active" | "completed" | "forgotten"; updatedAt: string; document: SharedStory | null };
type Pending = { accountKey: string; baseVersion: string; operationId: string; action: "save" | "complete" | "forget"; document: SharedStory | null };
type Cache = { progress: SharedProgress | null; pending: Pending | null };
const version = (value: unknown) => value === "0" || typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
const identity = (value: unknown) => typeof value === "string" && /^[A-F0-9]{64}$/u.test(value);
export function validateSharedProgress(raw: unknown): SharedProgress {
  const item = raw as SharedProgress;
  if (!item || !identity(item.accountKey) || typeof item.accountEmail !== "string" || !version(item.version)
    || !["empty", "active", "completed", "forgotten"].includes(item.state) || !Number.isFinite(Date.parse(item.updatedAt))
    || (item.state === "active") !== !!item.document) throw new Error("Saved listening could not be read.");
  if (item.document) validateListeningHandoff({ ...item.document, id: "a".repeat(64), status: "ready", partCount: item.document.parts?.length, expiresAt: item.updatedAt }, "a".repeat(64));
  return item;
}
export function sharedListeningKey(email: string) { return `signal.shared-listening.v1.${encodeURIComponent(email.toLowerCase())}`; }
export function clearSharedListening(email: string) {
  window.dispatchEvent(new CustomEvent("signal.shared-listening-signout", { detail: email.toLowerCase() }));
  try { localStorage.removeItem(sharedListeningKey(email)); } catch { /* Optional browser storage. */ }
}
/** A single compare-and-swap outbox. Only our own acknowledged write may advance queued local work's base revision. */
export class SharedListeningClient {
  progress: SharedProgress | null = null;
  pending: Pending | null = null;
  message = "";
  private writer: string | null = null;
  private writerVersion: string | null = null;
  private blocked = false;
  private running: Promise<void> | null = null;
  private dead = false;
  private request = new AbortController();
  private retry: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly email: string, private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
    private changed: () => void = () => {}, private fetcher: typeof fetch = fetch, private token = () => crypto.randomUUID().replaceAll("-", "")) {
    try {
      const raw = storage?.getItem(sharedListeningKey(email));
      if (raw && raw.length <= 200_000) {
        const value = JSON.parse(raw) as Cache;
        this.progress = value.progress ? validateSharedProgress(value.progress) : null;
        const p = value.pending;
        if (p && version(p.baseVersion) && /^[a-f0-9]{32}$/u.test(p.operationId) && ["save", "complete", "forget"].includes(p.action)
          && (p.action === "save") === !!p.document && (!this.progress || p.accountKey === this.progress.accountKey)) {
          if (p.document) validateSharedProgress({ accountKey: p.accountKey || "A".repeat(64), accountEmail: email, version: p.baseVersion, state: "active", updatedAt: new Date().toISOString(), document: p.document });
          this.pending = p;
        }
      }
    } catch { this.progress = null; this.pending = null; }
    if (this.progress && this.progress.accountEmail.toLowerCase() !== email.toLowerCase()) { this.progress = null; this.pending = null; }
  }
  private persist() {
    if (this.dead) return;
    const progress = this.pending && this.pending.action !== "save" && this.progress ? { ...this.progress, state: this.pending.action === "forget" ? "forgotten" : "completed", document: null } : this.progress;
    try { this.storage?.setItem(sharedListeningKey(this.email), JSON.stringify({ progress, pending: this.pending })); }
    catch { this.message = "Browser storage is unavailable. Keep this page open to sync listening."; }
    this.changed();
  }
  saved() { return this.pending ? this.pending.action === "save" ? this.pending.document : null : this.progress?.state === "active" ? this.progress.document : null; }
  begin(id: string) {
    if (this.dead || this.writer === id) return;
    this.writer = id; this.writerVersion = this.pending?.baseVersion ?? this.progress?.version ?? "0"; this.blocked = false;
  }
  report(id: string, document: SharedStory) {
    if (this.dead || this.blocked || this.writer !== id) return;
    try { validateSharedProgress({ accountKey: this.progress?.accountKey ?? "A".repeat(64), accountEmail: this.email, version: this.writerVersion!, state: "active", updatedAt: new Date().toISOString(), document }); }
    catch { this.blocked = true; this.message = "This story is too long to save across devices. Local playback remains available."; this.changed(); return; }
    if (this.pending?.action === "save" && JSON.stringify(this.pending.document) === JSON.stringify(document)) return;
    if (!this.pending && this.progress?.state === "active" && JSON.stringify(this.progress.document) === JSON.stringify(document)) return;
    this.queue("save", document);
  }
  finish(id: string) { if (!this.dead && this.writer === id && !this.blocked) this.queue("complete", null); }
  forget() {
    if (this.dead) return;
    this.blocked = true; this.writerVersion = this.pending?.baseVersion ?? this.progress?.version ?? "0";
    this.queue("forget", null);
  }
  private queue(action: Pending["action"], document: SharedStory | null) {
    this.pending = { accountKey: this.progress?.accountKey ?? "", baseVersion: this.writerVersion ?? "0", operationId: this.token(), action, document };
    this.message = "Listening progress saved on this device. Sync pending."; this.persist();
    if (action !== "save" && !this.running) void this.sync();
    else if (!this.retry) this.retry = setTimeout(() => { this.retry = null; void this.sync(); }, 3000);
  }
  private adopt(state: SharedProgress, own = false) {
    if (state.accountEmail.toLowerCase() !== this.email.toLowerCase() || this.progress && state.accountKey !== this.progress.accountKey) throw new Error("The Signal account changed. Sign in again.");
    if (!own && this.writer && this.writerVersion !== state.version) { this.blocked = true; this.message = "A newer saved position is available. Your current audio can keep playing."; }
    this.progress = state;
  }
  sync(): Promise<void> {
    if (this.dead) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; }); return this.running;
  }
  private async run() {
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(10000)]);
    const fetcher = this.fetcher;
    try {
      if (!this.progress) {
        const response = await fetcher("/api/listening-progress", { credentials: "same-origin", cache: "no-store", signal });
        if (!response.ok) throw new Error("Saved listening is unavailable. Local progress is kept.");
        this.adopt(validateSharedProgress(await response.json()), true);
        if (this.pending) this.pending.accountKey = this.progress!.accountKey;
      }
      while (this.pending && !this.dead) {
        const sent = structuredClone(this.pending);
        const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
        if (!csrf.ok) throw new Error("Sign in again to sync listening.");
        const { token } = await csrf.json() as { token?: string }; if (!token) throw new Error("Sign in again to sync listening.");
        signal.throwIfAborted();
        const response = await fetcher("/api/listening-progress", { method: "POST", credentials: "same-origin", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token }, body: JSON.stringify(sent) });
        if (!response.ok && response.status !== 409) throw new Error("Listening sync is unavailable. Local progress is kept.");
        const value = validateSharedProgress(await response.json());
        this.adopt(value, response.ok);
        if (response.status === 409) { this.pending = null; this.blocked = true; this.message = "Newer progress was kept. Resume the saved story to continue from it."; }
        else {
          if (this.pending?.operationId === sent.operationId) this.pending = null;
          else if (this.pending?.baseVersion === sent.baseVersion) this.pending.baseVersion = value.version;
          if (this.writerVersion === sent.baseVersion) this.writerVersion = value.version;
          this.message = "Listening progress synced.";
        }
        this.persist();
      }
      if (this.dead) return;
      const response = await fetcher("/api/listening-progress", { credentials: "same-origin", cache: "no-store", signal,
        headers: { "X-Signal-Progress-Account": this.progress!.accountKey } });
      if (!response.ok) throw new Error("Saved listening is unavailable. Local progress is kept.");
      this.adopt(validateSharedProgress(await response.json())); this.persist();
    } catch (error) {
      if (!this.dead) { this.message = this.pending ? "Offline or unavailable. Listening progress is saved here and will retry." : error instanceof Error ? error.message : "Saved listening is unavailable."; this.persist(); }
    }
  }
  dispose(clear = false) { this.dead = true; this.request.abort(); if (this.retry) clearTimeout(this.retry); if (clear) try { this.storage?.removeItem(sharedListeningKey(this.email)); } catch { /* Storage is unavailable. */ } }
}
