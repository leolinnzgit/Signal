export type PreparedHeadlineAudio = { blob: Blob; starts: number[] };

export async function prepareHeadlineAudio(
  titles: string[], seconds: number, language: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PreparedHeadlineAudio> {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in again to prepare screen-off audio.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again to prepare screen-off audio.");
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
