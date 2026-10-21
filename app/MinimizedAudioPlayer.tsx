"use client";

import { useEffect, useRef } from "react";
import "./minimized-audio-player.css";

export default function MinimizedAudioPlayer({ title, onRestore, onClose }: {
  title: string;
  onRestore: () => void;
  onClose: () => void;
}) {
  const restore = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => restore.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return <aside className="minimized-audio-player" aria-label="Minimized audio player">
    <button ref={restore} type="button" className="minimized-audio-restore" onClick={onRestore} aria-label="Restore audio player">
      <span>Restore player</span>
      <strong>{title}</strong>
    </button>
    <button type="button" onClick={onClose} aria-label="Stop audio and close player" title="Stop and close">&#215;</button>
  </aside>;
}
