"use client";

import { useEffect, useRef } from "react";
import "./minimized-audio-player.css";

export default function MinimizedAudioPlayer({
  title,
  statusLabel,
  playing,
  playbackDisabled = false,
  onTogglePlayback,
  onRestore,
  onClose,
}: {
  title: string;
  statusLabel?: string;
  playing?: boolean;
  playbackDisabled?: boolean;
  onTogglePlayback?: () => void;
  onRestore?: () => void;
  onClose: () => void;
}) {
  const restore = useRef<HTMLButtonElement>(null);
  const hasRestore = Boolean(onRestore);
  useEffect(() => {
    if (!hasRestore) return;
    const frame = requestAnimationFrame(() => restore.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [hasRestore]);

  return <aside className="minimized-audio-player" aria-label="Minimized audio player">
    {onTogglePlayback && (
      <button
        type="button"
        className="minimized-audio-toggle"
        disabled={playbackDisabled}
        aria-pressed={Boolean(playing)}
        aria-label={playing ? "Pause audio" : "Play audio"}
        title={playing ? "Pause" : "Play"}
        onClick={onTogglePlayback}
      >
        <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
      </button>
    )}
    {onRestore ? (
      <button ref={restore} type="button" className="minimized-audio-restore" onClick={onRestore} aria-label="Restore audio player">
        <span>{statusLabel ?? "Restore player"}</span>
        <strong>{title}</strong>
      </button>
    ) : (
      <div className="minimized-audio-restore minimized-audio-info">
        <span>{statusLabel ?? (playing ? "Playing" : "Paused")}</span>
        <strong>{title}</strong>
      </div>
    )}
    <button type="button" onClick={onClose} aria-label="Stop audio and close player" title="Stop and close">&#215;</button>
  </aside>;
}
