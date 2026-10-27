import type { ArticleNarrationSection } from "./headline-audio";

export type ListeningHandoff = {
  id: string; status: "pending" | "accepted" | "ready" | "cancelled";
  url: string; title: string; source: string; partIndex: number; partCount: number; expiresAt: string; parts?: string[] | null;
};
export function validHandoffToken(value: unknown): value is string { return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/u.test(value); }
export function incomingWatchHandoff(search: string): string | null {
  const values = new URLSearchParams(search).getAll("watchHandoff");
  return values.length === 1 && validHandoffToken(values[0]) ? values[0] : null;
}
// Keep only a short-lived opaque ID across an optional Google sign-in round trip.
export function pendingWatchHandoff(search: string): string | null {
  const current = incomingWatchHandoff(search);
  try {
    if (current) sessionStorage.setItem("signal.pending-watch-transfer", JSON.stringify({ id: current, until: Date.now() + 5 * 60_000 }));
    if (current) return current;
    const saved = JSON.parse(sessionStorage.getItem("signal.pending-watch-transfer") || "null") as { id?: string; until?: number } | null;
    if (validHandoffToken(saved?.id) && typeof saved?.until === "number" && saved.until > Date.now()) return saved.id;
    sessionStorage.removeItem("signal.pending-watch-transfer");
  } catch { /* The original link still works without browser storage. */ }
  return current;
}
export function clearPendingWatchHandoff(id: string) {
  try { sessionStorage.removeItem("signal.pending-watch-transfer"); sessionStorage.removeItem(`signal.watch-transfer.${id}`); } catch { /* Optional tab storage. */ }
}
export function validateListeningHandoff(value: unknown, id: string): ListeningHandoff {
  const item = value as ListeningHandoff | null;
  if (!item || item.id !== id || !["pending", "accepted", "ready", "cancelled"].includes(item.status)
    || typeof item.title !== "string" || !item.title.trim() || item.title.length > 500 || typeof item.source !== "string" || item.source.length > 256
    || typeof item.url !== "string" || item.url.length > 2048 || !Number.isInteger(item.partCount) || item.partCount < 1 || item.partCount > 190
    || !Number.isInteger(item.partIndex) || item.partIndex < 0 || item.partIndex >= item.partCount || !Number.isFinite(Date.parse(item.expiresAt))) {
    throw new Error("This listening transfer is incomplete. Start again on your watch.");
  }
  const url = new URL(item.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("The transferred story link is invalid.");
  if (item.parts != null && (item.status !== "ready" || !Array.isArray(item.parts) || item.parts.length !== item.partCount
    || item.parts.some(part => typeof part !== "string" || !part.trim() || part.length > 1000)
    || item.parts.reduce((size, part) => size + part.length, 0) > 19_500)) throw new Error("The transferred story text is invalid.");
  return item;
}
export function handoffNarrationSections(item: ListeningHandoff): ArticleNarrationSection[] {
  if (item.status !== "ready" || !item.parts) throw new Error("Waiting for your watch to confirm it has paused.");
  return item.parts.slice(item.partIndex).map((text, index) => ({ text, paragraphIndex: index + item.partIndex, start: 0, end: text.length }));
}
async function errorMessage(response: Response) {
  const data = await response.json().catch(() => null) as { error?: string } | null;
  return data?.error || (response.status === 401 ? "Sign in to the same Signal account as your watch." : "The listening transfer could not be completed. Try again on your watch.");
}
export async function readListeningHandoff(id: string, receiverToken: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (!validHandoffToken(id) || !validHandoffToken(receiverToken)) throw new Error("Invalid listening transfer.");
  signal.throwIfAborted();
  const response = await fetcher(`/api/listening-handoffs/${id}`, { credentials: "same-origin", cache: "no-store", signal,
    headers: { "X-Signal-Handoff-Receiver": receiverToken } });
  if (!response.ok) throw new Error(await errorMessage(response));
  return validateListeningHandoff(await response.json(), id);
}
export async function changeListeningHandoff(id: string, action: "accept" | "cancel", receiverToken: string,
  signal: AbortSignal, fetcher: typeof fetch = fetch) {
  if (!validHandoffToken(id) || !validHandoffToken(receiverToken)) throw new Error("Invalid listening transfer.");
  signal.throwIfAborted();
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in to the same Signal account as your watch.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again before continuing this transfer.");
  const response = await fetcher(`/api/listening-handoffs/${id}/${action}`, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token }, body: JSON.stringify({ receiverToken }) });
  if (!response.ok) throw new Error(await errorMessage(response));
}
export function receiverToken(id: string): string {
  let saved: string | null = null;
  try { saved = sessionStorage.getItem(`signal.watch-transfer.${id}`); } catch { /* The transfer also works without tab storage. */ }
  if (validHandoffToken(saved)) return saved;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  try { sessionStorage.setItem(`signal.watch-transfer.${id}`, token); } catch { /* Keep it in this component instead. */ }
  return token;
}
