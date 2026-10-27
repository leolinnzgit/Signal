"use client";
import { useEffect, useRef, useState } from "react";
import { readListeningHandoff, validHandoffToken } from "./listening-handoff";

export type WatchTransferSnapshot = { parts: string[]; partIndex: number; session: string };
export async function watchTransferMutation(path: string, body: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const csrf = await fetcher("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
  if (!csrf.ok) throw new Error("Sign in to the same Signal account as your watch.");
  const { token } = await csrf.json() as { token?: string };
  if (!token) throw new Error("Sign in again to transfer listening.");
  const response = await fetcher(`/api/listening-handoffs${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-XSRF-TOKEN": token }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || "The listening transfer could not complete. Try again.");
  return data;
}
function delay(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, 3000);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
  });
}
export default function ContinueOnWatch({ url, title, source, imageUrl = "", snapshot, pause, onLockChange }: {
  url: string; title: string; source: string; imageUrl?: string; snapshot: () => WatchTransferSnapshot | null; pause: () => void; onLockChange: (locked: boolean) => void;
}) {
  const latest = useRef({ snapshot, pause, onLockChange }); latest.current = { snapshot, pause, onLockChange };
  const operation = useRef<AbortController | null>(null);
  const offer = useRef<{ id: string; sourceToken: string } | null>(null);
  const [active, setActive] = useState(false), [message, setMessage] = useState("");
  function cancelRemote() {
    const value = offer.current; offer.current = null;
    if (value) void watchTransferMutation(`/${value.id}/cancel`, { sourceToken: value.sourceToken }, AbortSignal.timeout(5000)).catch(() => {});
  }
  useEffect(() => () => { operation.current?.abort(); cancelRemote(); latest.current.onLockChange(false); }, [url]);
  function cancel() { operation.current?.abort(); cancelRemote(); latest.current.onLockChange(false); setActive(false); setMessage("Transfer cancelled. Use Play to continue here."); }
  async function start() {
    if (operation.current && !operation.current.signal.aborted) return;
    const initial = latest.current.snapshot(); if (!initial) { setMessage("Start full-story playback before transferring it."); return; }
    if (initial.parts.length > 190 || initial.parts.some(part => !part.trim() || part.length > 1000) || initial.parts.join("").length > 19_500) {
      setMessage("This story is too long to transfer. You can keep listening on your phone."); return;
    }
    const abort = new AbortController(); operation.current = abort;
    setActive(true); setMessage("Creating watch transfer…");
    try {
      const safeImage = (() => { try {
        const value = new URL(imageUrl);
        return value.href.length <= 2048 && value.protocol === "https:" && !value.username && !value.password
          && value.hostname !== "localhost" && value.hostname !== "[::1]" && !/^127\./u.test(value.hostname) ? value.href : "";
      } catch { return ""; } })();
      const value = await watchTransferMutation("", { url, title, source, imageUrl: safeImage, parts: initial.parts, partIndex: initial.partIndex, target: "watch" }, abort.signal);
      if (!validHandoffToken(value?.id) || !validHandoffToken(value?.sourceToken) || !Number.isFinite(Date.parse(value?.expiresAt))) throw new Error("The watch transfer is invalid.");
      abort.signal.throwIfAborted();
      offer.current = value;
      setMessage("Open SignalWatch and tap Continue from phone. Phone playback stays here until you accept.");
      const identity = JSON.stringify(initial.parts);
      while (Date.now() < Date.parse(value.expiresAt)) {
        await delay(abort.signal);
        const current = latest.current.snapshot();
        if (!current || current.session !== initial.session || JSON.stringify(current.parts) !== identity) throw new Error("Playback changed. Start a new transfer for this story.");
        const state = await readListeningHandoff(value.id, value.sourceToken, abort.signal);
        if (state.target !== "watch") throw new Error("This transfer is intended for a different device. Start again.");
        if (state.status === "cancelled") throw new Error("The watch declined this transfer. You can continue listening here.");
        if (state.status !== "accepted") continue;
        latest.current.onLockChange(true); latest.current.pause();
        const paused = latest.current.snapshot();
        if (!paused || paused.session !== initial.session || JSON.stringify(paused.parts) !== identity) throw new Error("Playback changed before it could be transferred.");
        await watchTransferMutation(`/${value.id}/ready`, { sourceToken: value.sourceToken, partIndex: paused.partIndex }, abort.signal);
        abort.signal.throwIfAborted(); offer.current = null;
        setMessage("Ready on your watch. Phone playback is paused."); return;
      }
      throw new Error("The watch transfer expired. Open SignalWatch and try again.");
    } catch (reason) {
      if (!abort.signal.aborted) setMessage(reason instanceof Error ? reason.message : "The watch transfer failed.");
    } finally {
      if (operation.current === abort) {
        cancelRemote(); latest.current.onLockChange(false);
        operation.current = null;
        if (!abort.signal.aborted) setActive(false);
      }
    }
  }
  return <div className="continue-on-watch">
    <button type="button" onClick={() => active ? cancel() : void start()}>{active ? "Cancel watch transfer" : "Continue on watch"}</button>
    {message && <p role="status">{message}</p>}
  </div>;
}
