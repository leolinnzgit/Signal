export type PreparedHeadlineAudio = { blob: Blob; starts: number[] };
export type ReadingVoicePreferences = { en: string; zh: string };
export const READING_VOICES_STORAGE_KEY = "signal.recorded-reading-voices.v1";

// Keep ready PCM in this app session rather than in a mounted reader. Each
// headline is reusable even after heard titles are removed from the next queue.
export class PreparedAudioCache {
  private clips = new Map<string, { pcm: Blob; recording: PreparedHeadlineAudio }>();
  private recordings = new Map<PreparedHeadlineAudio, number>();
  private bytes = 0;
  private positions = new Map<string, number>();
  constructor(private maximumBytes = 96 * 1024 * 1024, private maximumClips = 512) {}

  key(titles: string[], seconds: number, language: string, voices?: ReadingVoicePreferences) {
    return JSON.stringify([titles, seconds, language, normalizeReadingVoices(voices)]);
  }

  get(titles: string[], seconds: number, language: string, voices?: ReadingVoicePreferences): PreparedHeadlineAudio | undefined {
    if (!titles.length) return;
    const keys = titles.map((title) => this.key([title], seconds, language, voices));
    const clips = keys.map((key) => this.clips.get(key));
    if (clips.some((clip) => !clip)) return;
    const starts: number[] = [];
    let bytes = 0;
    for (let index = 0; index < keys.length; index++) {
      const clip = clips[index]!;
      this.clips.delete(keys[index]);
      this.clips.set(keys[index], clip);
      starts.push(bytes / 32_000);
      bytes += clip.pcm.size;
      if (bytes > 0xffff_ffff - 36) throw new Error("This audio recording is too large. Try a shorter briefing.");
    }
    return { blob: pcmWave(clips.map((clip) => clip!.pcm), bytes), starts };
  }

  remember(titles: string[], seconds: number, language: string, voices: ReadingVoicePreferences | undefined, recording: PreparedHeadlineAudio) {
    if (recording.blob.size > this.maximumBytes) return;
    for (let index = 0; index < titles.length; index++) {
      const key = this.key([titles[index]], seconds, language, voices);
      // WAV offsets are seconds; round back to whole 16-bit samples.
      const start = 44 + Math.round(recording.starts[index] * 16_000) * 2;
      const end = index + 1 < titles.length ? 44 + Math.round(recording.starts[index + 1] * 16_000) * 2 : recording.blob.size;
      const clip = recording.blob.slice(start, end);
      this.remove(key);
      // Blob slices share their source. Charge the whole source WAV while any
      // of its clips remain, so evicting large clips cannot leave hidden memory.
      const references = this.recordings.get(recording) ?? 0;
      if (!references) this.bytes += recording.blob.size;
      this.recordings.set(recording, references + 1);
      this.clips.set(key, { pcm: clip, recording });
      while (this.bytes > this.maximumBytes || this.clips.size > this.maximumClips) {
        const oldest = this.clips.keys().next().value!;
        this.remove(oldest);
      }
    }
  }

  position(key: string) { return this.positions.get(key); }
  savePosition(key: string, time: number) {
    if (!Number.isFinite(time) || time < 0) return;
    this.positions.delete(key);
    this.positions.set(key, time);
    if (this.positions.size > 64) this.positions.delete(this.positions.keys().next().value!);
  }
  private remove(key: string) {
    const clip = this.clips.get(key);
    if (!clip) return;
    this.clips.delete(key);
    const references = this.recordings.get(clip.recording)! - 1;
    if (references) this.recordings.set(clip.recording, references);
    else { this.recordings.delete(clip.recording); this.bytes -= clip.recording.blob.size; }
  }
  clear() { this.clips.clear(); this.recordings.clear(); this.positions.clear(); this.bytes = 0; }
}

export const preparedAudioCache = new PreparedAudioCache();
let recordedEngine = "";
let maximumRecordedBatchCharacters = 15_000;

export function configureRecordedAudio(engine: string | null, batchCharacters: string | null) {
  if (engine && recordedEngine && recordedEngine !== engine) preparedAudioCache.clear();
  recordedEngine = engine ?? "";
  const value = Number(batchCharacters);
  maximumRecordedBatchCharacters = Number.isInteger(value) && value >= 240 && value <= 15_000 ? value : 15_000;
}

export function recordedArticleNarrationParts(title: string, paragraphs: string[]) {
  return recordedArticleNarrationSections(title, paragraphs).map((section) => section.text);
}

export function recordedArticleNarrationSections(title: string, paragraphs: string[]) {
  return articleNarrationSections(title, paragraphs, Math.min(900, maximumRecordedBatchCharacters));
}

function pcmWave(pcm: Blob[], bytes: number) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const tag = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, bytes + 36, true); tag(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, bytes, true);
  return new Blob([header, ...pcm], { type: "audio/wav" });
}

export function normalizeReadingVoices(value: unknown): ReadingVoicePreferences {
  const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const voice = (language: string) => typeof saved[language] === "string" && saved[language].length <= 160 ? saved[language].trim() : "";
  return { en: voice("en"), zh: voice("zh") };
}

export function preferScreenOffAudio(userAgent: string, standalone: boolean) {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || (standalone && /Android/i.test(userAgent));
}

export function prepareReadingVoicePreview(
  language: keyof ReadingVoicePreferences, voices: ReadingVoicePreferences,
  signal: AbortSignal, fetcher: typeof fetch = fetch,
) {
  const sample = language === "en"
    ? "Hello, this is your Signal reading voice. I can read the latest news while you listen."
    : "您好，這是您的 Signal 新聞朗讀聲音。讓我為您朗讀最新新聞。";
  return prepareHeadlineAudio([sample], 3, language, signal, fetcher, undefined, 15_000,
    { en: language === "en" ? voices.en : "", zh: language === "zh" ? voices.zh : "" });
}

export async function prepareHeadlineAudio(
  titles: string[], seconds: number, language: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (prepared: number, total: number) => void,
  maximumBatchCharacters = 15_000,
  voices?: ReadingVoicePreferences,
  cache: PreparedAudioCache | undefined = fetcher === fetch ? preparedAudioCache : undefined,
): Promise<PreparedHeadlineAudio> {
  signal.throwIfAborted();
  if (!titles.length || titles.some((title) => !title.trim() || title.length > 1_000)) {
    throw new Error("A headline could not be prepared as audio. Try another briefing.");
  }
  const ready = cache?.get(titles, seconds, language, voices);
  if (ready) { onProgress?.(titles.length, titles.length); return ready; }
  maximumBatchCharacters = Math.min(maximumBatchCharacters, maximumRecordedBatchCharacters);
  // Prepare bounded requests, then join their PCM into one recording. Switching
  // audio sources at batch boundaries would depend on a running background page.
  const batches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;
  for (const title of titles) {
    if (batch.length === 50 || (batch.length > 0 && characters + title.length > maximumBatchCharacters)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(title);
    characters += title.length;
  }
  batches.push(batch);
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in again to prepare screen-off audio.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again to prepare screen-off audio.");
  const starts: number[] = [];
  const pcm: Blob[] = [];
  let header: ArrayBuffer | undefined;
  let totalBytes = 0;
  onProgress?.(0, titles.length);
  for (const batchTitles of batches) {
    signal.throwIfAborted();
    const prepared = cache?.get(batchTitles, seconds, language, voices) ?? await prepareBatch(batchTitles, seconds, language, signal, token, fetcher, voices);
    const raw = await prepared.blob.arrayBuffer();
    signal.throwIfAborted();
    const view = new DataView(raw);
    const tag = (offset: number) => String.fromCharCode(...new Uint8Array(raw, offset, 4));
    // The server returns a fixed 44-byte mono PCM WAV header. Validate it before
    // removing batch headers, so corrupt or incompatible data never becomes audio.
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data"
      || view.getUint32(4, true) !== raw.byteLength - 8 || view.getUint32(16, true) !== 16
      || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
      || view.getUint32(24, true) !== 16_000 || view.getUint32(28, true) !== 32_000
      || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
      || view.getUint32(40, true) !== raw.byteLength - 44 || (raw.byteLength - 44) % 2 !== 0
      || prepared.starts.at(-1)! >= (raw.byteLength - 44) / 32_000) {
      throw new Error("The audio briefing was incomplete. Please try again.");
    }
    header ??= raw.slice(0, 44);
    const elapsed = totalBytes / 32_000;
    starts.push(...prepared.starts.map((time) => time + elapsed));
    pcm.push(prepared.blob.slice(44));
    totalBytes += raw.byteLength - 44;
    if (totalBytes > 0xffff_ffff - 36) throw new Error("This audio recording is too large. Try a shorter briefing.");
    onProgress?.(starts.length, titles.length);
  }
  const headerView = new DataView(header!);
  headerView.setUint32(4, totalBytes + 36, true);
  headerView.setUint32(40, totalBytes, true);
  const recording = { blob: new Blob([header!, ...pcm], { type: "audio/wav" }), starts };
  cache?.remember(titles, seconds, language, voices, recording);
  return recording;
}

export type ArticleNarrationSection = { text: string; paragraphIndex: number; start: number; end: number };

export function normalizeArticleReadingText(text: string) {
  return text.replace(/\s+/gu, " ").trim();
}

export function articleNarrationParts(title: string, paragraphs: string[], maximumPartLength = 900) {
  return articleNarrationSections(title, paragraphs, maximumPartLength).map((section) => section.text);
}

export function articleNarrationSections(title: string, paragraphs: string[], maximumPartLength = 900): ArticleNarrationSection[] {
  const partLength = Math.max(80, Math.min(900, Math.floor(maximumPartLength) || 900));
  const minimumBreak = Math.floor(partLength / 3);
  const body = paragraphs.map((text, paragraphIndex) => ({ text: normalizeArticleReadingText(text), paragraphIndex })).filter((paragraph) => paragraph.text);
  if (!body.length) throw new Error("The full article text is unavailable for reading aloud.");
  if (body.reduce((length, paragraph) => length + paragraph.text.length, title.length) > 40_000) {
    throw new Error("This article is too long to prepare as audio.");
  }
  return [{ text: normalizeArticleReadingText(title), paragraphIndex: -1 }, ...body].flatMap(({ text: paragraph, paragraphIndex }) => {
    let remaining = paragraph;
    const parts: string[] = [];
    while (remaining.length > partLength) {
      const window = remaining.slice(0, partLength);
      const sentences = [...window.matchAll(/(?:[.!?](?=\s)|[。！？])["'”’]?/gu)];
      const lastSentence = sentences.at(-1);
      let end = lastSentence ? lastSentence.index + lastSentence[0].length : 0;
      if (end < minimumBreak) end = window.lastIndexOf(" ") + 1;
      if (end < minimumBreak) end = partLength;
      // A hard split of a long word must preserve surrogate pairs, including emoji.
      if (/[\uD800-\uDBFF]/u.test(remaining[end - 1])) end--;
      parts.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end).trim();
    }
    if (remaining) parts.push(remaining);
    let offset = 0;
    return parts.map((text) => {
      const start = paragraph.indexOf(text, offset);
      offset = start + text.length;
      return { text, paragraphIndex, start, end: offset };
    });
  });
}

export function prepareArticleAudio(
  title: string, paragraphs: string[], language: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (prepared: number, total: number) => void,
  voices?: ReadingVoicePreferences,
  cache: PreparedAudioCache | undefined = fetcher === fetch ? preparedAudioCache : undefined,
) {
  // Smaller batches keep full articles inside the worker deadline. All parts
  // become one recording before playback, including when the phone is locked.
  return prepareHeadlineAudio(recordedArticleNarrationParts(title, paragraphs), 3, language, signal, fetcher, onProgress, 4_000, voices, cache);
}

async function prepareBatch(titles: string[], seconds: number, language: string, signal: AbortSignal, token: string, fetcher: typeof fetch, voices?: ReadingVoicePreferences): Promise<PreparedHeadlineAudio> {
  const response = await fetcher("/api/headline-audio", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({ titles, seconds, language, ...(voices && (voices.en || voices.zh) ? { voices } : {}) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || "Screen-off audio could not be prepared. Please try again.");
  }
  let starts: unknown;
  try { starts = JSON.parse(response.headers.get("X-Signal-Headline-Starts") ?? "null"); }
  catch { throw new Error("The audio briefing was incomplete. Please try again."); }
  if (!Array.isArray(starts) || starts.length !== titles.length || starts[0] !== 0
    || starts.some((time, index) => typeof time !== "number" || !Number.isFinite(time) || time < 0 || (index > 0 && time <= starts[index - 1]))) {
    throw new Error("The audio briefing was incomplete. Please try again.");
  }
  const blob = await response.blob();
  if (!blob.type.startsWith("audio/wav") || blob.size <= 44) throw new Error("The audio briefing was incomplete. Please try again.");
  return { blob, starts };
}

export function audioHeadlineIndex(starts: number[], time: number) {
  if (!starts.length || !Number.isFinite(time)) return 0;
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= time) low = middle;
    else high = middle;
  }
  return low;
}
