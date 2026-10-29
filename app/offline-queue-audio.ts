import { prepareHeadlineAudio, type PreparedHeadlineAudio, type ReadingVoicePreferences } from "./headline-audio";
import type { SharedStory } from "./shared-listening";

export const QUEUE_AUDIO_LIMIT = 100 * 1024 * 1024;
export type DownloadedStoryAudio = PreparedHeadlineAudio & { account: string; url: string; parts: string[]; voices: ReadingVoicePreferences; key: string };
export interface QueueAudioStorage {
  list(account: string): Promise<DownloadedStoryAudio[]>;
  put(value: DownloadedStoryAudio): Promise<void>;
  remove(key: string): Promise<void>;
}
const key = (account: string, url: string) => JSON.stringify([account.toLowerCase(), url]);
const matches = (audio: DownloadedStoryAudio, story: SharedStory) => audio.url === story.url && JSON.stringify(audio.parts) === JSON.stringify(story.parts);

/** One atomic recording per story. Incomplete or failed downloads never appear as ready. */
export class BrowserQueueAudioStorage implements QueueAudioStorage {
  private database: Promise<IDBDatabase> | null = null;
  private open() {
    return this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("signal-queue-audio-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("audio", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Audio storage is unavailable on this browser."));
    });
  }
  async list(account: string) {
    const database = await this.open();
    return new Promise<DownloadedStoryAudio[]>((resolve, reject) => {
      const request = database.transaction("audio").objectStore("audio").getAll();
      request.onsuccess = () => resolve((request.result as DownloadedStoryAudio[]).filter(item => item.account === account.toLowerCase()));
      request.onerror = () => reject(new Error("Downloaded audio could not be read."));
    });
  }
  async put(value: DownloadedStoryAudio) {
    const database = await this.open();
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("audio", "readwrite"), store = transaction.objectStore("audio");
      const all = store.getAll();
      all.onsuccess = () => {
        const bytes = (all.result as DownloadedStoryAudio[]).filter(item => item.key !== value.key).reduce((sum, item) => sum + item.blob.size, 0);
        if (bytes + value.blob.size > QUEUE_AUDIO_LIMIT) { transaction.abort(); return; }
        store.put(value);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new Error("Audio storage is full or unavailable. Remove downloads and retry (100 MB limit)."));
    });
  }
  async remove(value: string) {
    const database = await this.open();
    return new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("audio", "readwrite"); transaction.objectStore("audio").delete(value);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(new Error("Downloaded audio could not be removed."));
    });
  }
}

export class QueueAudioDownloads {
  records: DownloadedStoryAudio[] = [];
  current = "";
  progress = 0;
  message = "";
  autoRemove = true;
  private operation: AbortController | null = null;
  get busy() { return this.operation !== null; }
  private dead = false;
  private allowed: Map<string, string> | null = null;
  constructor(readonly account: string, private storage: QueueAudioStorage, private changed: () => void = () => {},
    private prepare: typeof prepareHeadlineAudio = prepareHeadlineAudio, private verify?: (signal: AbortSignal) => Promise<void>) { this.account = account.toLowerCase(); }
  async refresh() {
    try { const records = await this.storage.list(this.account); if (!this.dead) { this.records = records; this.changed(); } }
    catch { if (!this.dead) { this.message = "Audio storage is unavailable. Device voice still works offline."; this.changed(); } }
  }
  saved(story: SharedStory) { return this.records.find(item => matches(item, story)); }
  async recording(story: SharedStory): Promise<PreparedHeadlineAudio | undefined> {
    await this.refresh(); const audio = this.saved(story);
    if (this.dead || !audio || audio.starts.length !== story.parts.length || audio.starts.some((time, index) => !Number.isFinite(time) || time < 0 || index > 0 && time <= audio.starts[index - 1])) return;
    try {
      const header = await audio.blob.slice(0, 44).arrayBuffer(), view = new DataView(header);
      if (header.byteLength !== 44 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645 || view.getUint32(24, true) !== 16000 || view.getUint16(34, true) !== 16) return;
      const start = audio.starts[story.partIndex], offset = 44 + Math.round(start * 16000) * 2;
      if (offset >= audio.blob.size || audio.starts.some(value => 44 + Math.round(value * 16000) * 2 >= audio.blob.size)) return;
      const size = audio.blob.size - offset;
      view.setUint32(4, size + 36, true); view.setUint32(40, size, true);
      return { blob: new Blob([header, audio.blob.slice(offset)], { type: "audio/wav" }), starts: audio.starts.slice(story.partIndex).map(value => value - start) };
    } catch { return; }
  }
  async download(stories: SharedStory[], voices: ReadingVoicePreferences, language: string) {
    if (this.dead || this.operation || !stories.length) return;
    const abort = new AbortController(); this.operation = abort; this.message = "Keep Signal open until downloads finish.";
    this.changed();
    try {
      await this.verify?.(abort.signal);
      for (const story of structuredClone(stories)) {
        abort.signal.throwIfAborted();
        if (this.allowed && this.allowed.get(story.url) !== JSON.stringify(story.parts)) throw new Error("The queue changed. Reopen Listen later and retry.");
        const existing = this.saved(story);
        if (existing && JSON.stringify(existing.voices) === JSON.stringify(voices)) continue;
        this.current = story.url; this.progress = 0; this.changed();
        const audio = await this.prepare(story.parts, 3, language, abort.signal, undefined,
          (done, total) => { if (!abort.signal.aborted) { this.progress = Math.round(done / total * 100); this.changed(); } }, 4000, voices);
        abort.signal.throwIfAborted();
        if (this.allowed && this.allowed.get(story.url) !== JSON.stringify(story.parts)) throw new Error("The queue changed before its audio was saved.");
        if (audio.blob.size > QUEUE_AUDIO_LIMIT) throw new Error("This story exceeds the 100 MB audio limit.");
        await this.storage.put({ ...audio, key: key(this.account, story.url), account: this.account, url: story.url, parts: story.parts, voices });
        await this.refresh();
      }
      this.message = "Audio downloaded on this device. Saved sections work without internet.";
      if (typeof navigator !== "undefined") void navigator.storage?.persist?.().catch(() => false);
    } catch (error) { if (!abort.signal.aborted) this.message = error instanceof Error ? error.message : "Audio download failed. Retry when connected."; }
    finally { if (this.operation === abort) { this.operation = null; this.current = ""; this.changed(); } }
  }
  cancel() { this.operation?.abort(); this.operation = null; this.current = ""; this.message = "Download cancelled. Completed stories are kept; tap Download to retry."; this.changed(); }
  async remove(url?: string) {
    if (!url || this.current === url) this.cancel();
    try { for (const item of await this.storage.list(this.account)) if (!url || item.url === url) await this.storage.remove(item.key); await this.refresh(); }
    catch { this.message = "Audio could not be removed. Try again."; this.changed(); }
  }
  async retain(stories: SharedStory[]) {
    this.allowed = new Map(stories.map(item => [item.url, JSON.stringify(item.parts)]));
    if (this.current && !this.allowed.has(this.current)) this.cancel();
    if (this.autoRemove) for (const item of this.records) if (this.allowed.get(item.url) !== JSON.stringify(item.parts)) await this.remove(item.url);
  }
  dispose(clear = false) { this.dead = true; this.cancel(); if (clear) void this.remove(); }
}
