export type BriefingItem = {
  url: string;
  title: string;
  source: string;
  imageUrl: string;
  parts: string[];
  fullArticle: boolean;
  catchUpKeys?: Record<string, string>;
};

export type BriefingProgressDocument = {
  items: BriefingItem[];
  index: number;
  partIndex: number;
  shuffled: boolean;
  heard: string[];
  catchUpHeard: Record<string, string>;
};

export type BriefingProgress = {
  accountKey: string;
  accountEmail: string;
  version: string;
  state: "empty" | "active" | "completed" | "forgotten";
  updatedAt: string;
  document: BriefingProgressDocument | null;
};

type Pending = {
  accountKey: string;
  baseVersion: string;
  operationId: string;
  action: "save" | "complete" | "forget";
  document: BriefingProgressDocument | null;
};

type Cache = { progress: BriefingProgress | null; pending: Pending | null };

const version = (value: unknown) => value === "0" || (typeof value === "string" && /^[a-f0-9]{32}$/u.test(value));
const identity = (value: unknown) => typeof value === "string" && /^[A-F0-9]{64}$/u.test(value);

export function validateBriefingProgress(raw: unknown): BriefingProgress {
  const item = raw as BriefingProgress;
  if (!item || !identity(item.accountKey) || typeof item.accountEmail !== "string" || !version(item.version)
    || !["empty", "active", "completed", "forgotten"].includes(item.state) || !Number.isFinite(Date.parse(item.updatedAt))
    || (item.state === "active") !== !!item.document) {
    throw new Error("Briefing progress could not be read.");
  }
  if (item.document) {
    const doc = item.document;
    if (!Array.isArray(doc.items) || doc.items.length > 20) throw new Error("Invalid briefing items.");
    if (doc.items.length === 0) {
      if (doc.index !== 0 || doc.partIndex !== 0) throw new Error("Invalid briefing indices.");
    } else {
      if (doc.index < 0 || doc.index >= doc.items.length) throw new Error("Invalid story index.");
      const current = doc.items[doc.index];
      if (!current || !Array.isArray(current.parts) || doc.partIndex < 0 || doc.partIndex >= current.parts.length) {
        throw new Error("Invalid part index.");
      }
    }
  }
  return item;
}

export function briefingProgressKey(email: string) {
  return `signal.briefing-progress.v1.${encodeURIComponent(email.toLowerCase())}`;
}

export function clearBriefingProgress(email: string) {
  window.dispatchEvent(new CustomEvent("signal.briefing-progress-signout", { detail: email.toLowerCase() }));
  try {
    localStorage.removeItem(briefingProgressKey(email));
  } catch { /* Optional browser storage. */ }
}

export class BriefingProgressClient {
  progress: BriefingProgress | null = null;
  pending: Pending | null = null;
  message = "";
  private writer: string | null = null;
  private writerVersion: string | null = null;
  private blocked = false;
  private running: Promise<void> | null = null;
  private dead = false;
  private request = new AbortController();
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly email: string,
    private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
    private changed: () => void = () => {},
    private fetcher: typeof fetch = fetch,
    private token = () => crypto.randomUUID().replaceAll("-", "")
  ) {
    try {
      const raw = storage?.getItem(briefingProgressKey(email));
      if (raw && raw.length <= 500_000) {
        const value = JSON.parse(raw) as Cache;
        this.progress = value.progress ? validateBriefingProgress(value.progress) : null;
        const p = value.pending;
        if (p && version(p.baseVersion) && /^[a-f0-9]{32}$/u.test(p.operationId) && ["save", "complete", "forget"].includes(p.action)
          && (p.action === "save") === !!p.document && (!this.progress || p.accountKey === this.progress.accountKey)) {
          this.pending = p;
        }
      }
    } catch {
      this.progress = null;
      this.pending = null;
    }
    if (this.progress && this.progress.accountEmail.toLowerCase() !== email.toLowerCase()) {
      this.progress = null;
      this.pending = null;
    }
  }

  private persist() {
    if (this.dead) return;
    const progress = this.pending && this.pending.action !== "save" && this.progress
      ? { ...this.progress, state: this.pending.action === "forget" ? "forgotten" as const : "completed" as const, document: null }
      : this.progress;
    try {
      this.storage?.setItem(briefingProgressKey(this.email), JSON.stringify({ progress, pending: this.pending }));
    } catch {
      this.message = "Browser storage is unavailable. Keep this page open to sync briefing.";
    }
    this.changed();
  }

  saved(): BriefingProgressDocument | null {
    return this.pending
      ? this.pending.action === "save" ? this.pending.document : null
      : this.progress?.state === "active" ? this.progress.document : null;
  }

  begin(id: string) {
    if (this.dead || this.writer === id) return;
    this.writer = id;
    this.writerVersion = this.pending?.baseVersion ?? this.progress?.version ?? "0";
    this.blocked = false;
  }

  report(id: string, document: BriefingProgressDocument) {
    if (this.dead || this.blocked || this.writer !== id) return;
    try {
      validateBriefingProgress({
        accountKey: this.progress?.accountKey ?? "A".repeat(64),
        accountEmail: this.email,
        version: this.writerVersion!,
        state: "active",
        updatedAt: new Date().toISOString(),
        document
      });
    } catch {
      this.blocked = true;
      this.message = "Briefing queue is too large to save across devices.";
      this.changed();
      return;
    }
    if (this.pending?.action === "save" && JSON.stringify(this.pending.document) === JSON.stringify(document)) return;
    if (!this.pending && this.progress?.state === "active" && JSON.stringify(this.progress.document) === JSON.stringify(document)) return;
    this.queue("save", document);
  }

  finish(id: string) {
    if (!this.dead && this.writer === id && !this.blocked) this.queue("complete", null);
  }

  forget() {
    if (this.dead) return;
    this.blocked = true;
    this.writerVersion = this.pending?.baseVersion ?? this.progress?.version ?? "0";
    this.queue("forget", null);
  }

  private queue(action: Pending["action"], document: BriefingProgressDocument | null) {
    this.pending = {
      accountKey: this.progress?.accountKey ?? "",
      baseVersion: this.writerVersion ?? "0",
      operationId: this.token(),
      action,
      document
    };
    this.message = "Briefing progress saved on this device. Sync pending.";
    this.persist();
    if (action !== "save" && !this.running) void this.sync();
    else if (!this.retry) {
      this.retry = setTimeout(() => {
        this.retry = null;
        void this.sync();
      }, 3000);
    }
  }

  private adopt(state: BriefingProgress, own = false) {
    if (state.accountEmail.toLowerCase() !== this.email.toLowerCase() || (this.progress && state.accountKey !== this.progress.accountKey)) {
      throw new Error("The Signal account changed. Sign in again.");
    }
    if (!own && this.writer && this.writerVersion !== state.version) {
      this.blocked = true;
      this.message = "A newer briefing position is available.";
    }
    this.progress = state;
  }

  sync(): Promise<void> {
    if (this.dead) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run() {
    const signal = AbortSignal.any([this.request.signal, AbortSignal.timeout(10000)]);
    const fetcher = this.fetcher;
    try {
      if (!this.progress) {
        const response = await fetcher("/api/briefing-progress", { credentials: "same-origin", cache: "no-store", signal });
        if (!response.ok) throw new Error("Briefing progress is unavailable.");
        this.adopt(validateBriefingProgress(await response.json()), true);
        if (this.pending) this.pending.accountKey = this.progress!.accountKey;
      }
      while (this.pending && !this.dead) {
        const sent = structuredClone(this.pending);
        const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
        if (!csrf.ok) throw new Error("Sign in again to sync briefing.");
        const { token } = await csrf.json() as { token?: string };
        if (!token) throw new Error("Sign in again to sync briefing.");
        signal.throwIfAborted();
        const response = await fetcher("/api/briefing-progress", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
          body: JSON.stringify(sent)
        });
        if (!response.ok && response.status !== 409) throw new Error("Briefing sync is unavailable.");
        const value = validateBriefingProgress(await response.json());
        this.adopt(value, response.ok);
        if (response.status === 409) {
          this.pending = null;
          this.blocked = true;
          this.message = "Newer briefing progress was kept.";
        } else {
          if (this.pending?.operationId === sent.operationId) this.pending = null;
          else if (this.pending?.baseVersion === sent.baseVersion) this.pending.baseVersion = value.version;
          if (this.writerVersion === sent.baseVersion) this.writerVersion = value.version;
          this.message = "Briefing progress synced.";
        }
        this.persist();
      }
      if (this.dead) return;
      const response = await fetcher("/api/briefing-progress", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: { "X-Signal-Progress-Account": this.progress!.accountKey }
      });
      if (!response.ok) throw new Error("Briefing progress is unavailable.");
      this.adopt(validateBriefingProgress(await response.json()));
      this.persist();
    } catch (error) {
      if (!this.dead) {
        this.message = this.pending ? "Offline or unavailable. Briefing progress is saved locally." : error instanceof Error ? error.message : "Briefing progress is unavailable.";
        this.persist();
      }
    }
  }

  dispose(clear = false) {
    this.dead = true;
    this.request.abort();
    if (this.retry) clearTimeout(this.retry);
    if (clear) {
      try { this.storage?.removeItem(briefingProgressKey(this.email)); } catch { /* Storage unavailable */ }
    }
  }
}
