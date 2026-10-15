import { normalizeReadingVoices, type ReadingVoicePreferences } from "./headline-audio";

export type ArticleAudioStreamStatus = { starts: number[]; complete: boolean; duration: number; error: string | null };
type Stream = { url: string; statusUrl: string; status?: ArticleAudioStreamStatus };
const readyStreams = new Map<string, Stream>();

export async function openArticleAudioStream(parts: string[], language: string, voices: ReadingVoicePreferences, signal: AbortSignal,
  onStatus: (status: ArticleAudioStreamStatus) => void, fetcher: typeof fetch = fetch, seconds = 3) {
  signal.throwIfAborted();
  const key = JSON.stringify([parts, language, normalizeReadingVoices(voices), seconds]);
  let stream = readyStreams.get(key);
  const readStatus = async (candidate: Stream) => {
    const response = await fetcher(candidate.statusUrl, { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) throw new Error("The audio stream expired. Start reading again.");
    const status = await response.json() as ArticleAudioStreamStatus;
    if (!Array.isArray(status.starts) || status.starts.length > parts.length || status.starts.some((start, index) => !Number.isFinite(start)
      || start < 0 || (index > 0 && start <= status.starts[index - 1])) || typeof status.complete !== "boolean"
      || !Number.isFinite(status.duration) || status.duration < 0 || (status.complete && status.starts.length !== parts.length)) {
      throw new Error("The audio stream returned incomplete timing. Try again.");
    }
    if (status.error) throw new Error(status.error);
    return status;
  };
  if (stream) {
    try { stream.status = await readStatus(stream); }
    catch (reason) { signal.throwIfAborted(); readyStreams.delete(key); stream = undefined; }
  }
  if (!stream) {
    const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) throw new Error("Sign in again to stream this article.");
    const { token } = await csrf.json() as { token?: string };
    if (!token) throw new Error("Sign in again to stream this article.");
    const response = await fetcher("/api/article-audio-stream", {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token },
      body: JSON.stringify({ titles: parts, seconds, language, voices: normalizeReadingVoices(voices) }),
    });
    const data = await response.json().catch(() => null) as Stream & { error?: string } | null;
    if (!response.ok) throw new Error(data?.error || "Streaming audio is unavailable. Try again or prepare a recording.");
    if (!data || !/^\/api\/article-audio-stream\/[a-f0-9]{32}$/u.test(data.url) || data.statusUrl !== `${data.url}/status`) {
      throw new Error("The audio stream could not be opened. Try again.");
    }
    stream = data;
  }
  const opened = stream;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (timer !== undefined) clearTimeout(timer); };
  signal.addEventListener("abort", stop, { once: true });
  const deliver = (status: ArticleAudioStreamStatus) => {
    if (signal.aborted) return;
    opened.status = status;
    onStatus(status);
    if (status.complete) {
      readyStreams.delete(key); readyStreams.set(key, opened);
      while (readyStreams.size > 2) readyStreams.delete(readyStreams.keys().next().value!);
      signal.removeEventListener("abort", stop);
    } else timer = setTimeout(() => { void poll(); }, 1000);
  };
  const poll = async () => {
    try { deliver(await readStatus(opened)); }
    catch (reason) {
      if (!signal.aborted) onStatus({ starts: opened.status?.starts ?? [], complete: false, duration: 0,
        error: reason instanceof Error ? reason.message : "The audio stream stopped. Try again." });
      signal.removeEventListener("abort", stop);
    }
  };
  signal.throwIfAborted();
  if (opened.status?.complete) deliver(opened.status);
  else timer = setTimeout(() => { void poll(); }, 500);
  return opened.url;
}
