"use client";

import { useEffect, useRef, useState } from "react";
import {
  isVoiceInputSupported,
  parseVoiceCommand,
  startVoiceCapture,
  type ActiveVoiceSession,
  type VoiceCommandResult,
} from "./voice-input";
import "./voice-input.css";

export default function VoiceMicButton({
  label = "Voice search",
  language,
  disabled = false,
  className = "",
  onVoiceCommand,
  onError,
}: {
  label?: string;
  language?: string;
  disabled?: boolean;
  className?: string;
  onVoiceCommand: (command: VoiceCommandResult) => void;
  onError?: (message: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<"idle" | "listening" | "transcribing">("idle");
  const sessionRef = useRef<ActiveVoiceSession | null>(null);

  useEffect(() => {
    setSupported(isVoiceInputSupported());
    return () => {
      sessionRef.current?.cancel();
      sessionRef.current = null;
    };
  }, []);

  if (!supported) return null;

  function handleClick() {
    if (state === "listening") {
      sessionRef.current?.finish();
      return;
    }
    if (state === "transcribing") {
      return;
    }

    sessionRef.current?.cancel();
    sessionRef.current = startVoiceCapture({
      language,
      onStateChange: (next) => {
        setState(next);
        if (next === "idle") sessionRef.current = null;
      },
      onTranscript: (transcript) => {
        const parsed = parseVoiceCommand(transcript);
        if (parsed.query || parsed.intent === "all-topics") {
          onVoiceCommand(parsed);
        }
      },
      onError: (msg) => {
        onError?.(msg);
      },
    });
  }

  const activeTitle =
    state === "listening"
      ? "Listening… tap again when finished"
      : state === "transcribing"
        ? "Transcribing speech…"
        : label;

  return (
    <button
      type="button"
      className={[
        "voice-mic-btn",
        state === "listening" ? "is-listening" : "",
        state === "transcribing" ? "is-transcribing" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={handleClick}
      disabled={disabled || state === "transcribing"}
      aria-label={activeTitle}
      aria-pressed={state === "listening"}
      title={activeTitle}
    >
      {state === "listening" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="22" />
          <line x1="8" y1="22" x2="16" y2="22" />
        </svg>
      )}
    </button>
  );
}
