export type PreparedHeadlineAudio = { blob: Blob; starts: number[] };

export function preferScreenOffAudio(userAgent: string, standalone: boolean) {
  return standalone && /Android/i.test(userAgent);
}

export async function prepareHeadlineAudio(
  titles: string[], seconds: number, language: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (prepared: number, total: number) => void,
): Promise<PreparedHeadlineAudio> {
  signal.throwIfAborted();
  if (!titles.length || titles.some((title) => !title.trim() || title.length > 1_000)) {
    throw new Error("A headline could not be prepared as audio. Try another briefing.");
  }
  // Prepare bounded requests, then join their PCM into one recording. Switching
  // audio sources at batch boundaries would depend on a running background page.
  const batches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;
  for (const title of titles) {
    if (batch.length === 50 || characters + title.length > 15_000) {
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
    const prepared = await prepareBatch(batchTitles, seconds, language, signal, token, fetcher);
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
  return { blob: new Blob([header!, ...pcm], { type: "audio/wav" }), starts };
}

async function prepareBatch(titles: string[], seconds: number, language: string, signal: AbortSignal, token: string, fetcher: typeof fetch): Promise<PreparedHeadlineAudio> {
  const response = await fetcher("/api/headline-audio", {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
    body: JSON.stringify({ titles, seconds, language }),
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
