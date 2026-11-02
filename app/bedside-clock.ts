import type { DailyBriefingData } from "./daily-briefing.ts";
import {
  computeBriefingPackId,
  BrowserCacheStorageAudioStore,
  MemoryBriefingAudioStore,
  saveOfflineBriefingPack,
  type BriefingAudioCacheStore,
} from "./daily-briefing-offline.ts";

export const CHIME_FREQUENCIES = [523.25, 659.25, 783.99, 1046.5]; // C5, E5, G5, C6 arpeggio

export interface ClockDisplay {
  hours24: string;
  minutes: string;
  seconds: string;
  hour12: number;
  ampm: "AM" | "PM";
  dateFormatted: string;
  timeString24: string;
}

export function formatClockDisplay(date: Date = new Date()): ClockDisplay {
  const h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();

  const hours24 = String(h).padStart(2, "0");
  const minutes = String(m).padStart(2, "0");
  const seconds = String(s).padStart(2, "0");
  const hour12 = h % 12 || 12;
  const ampm = h >= 12 ? "PM" : "AM";
  const dateFormatted = date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return {
    hours24,
    minutes,
    seconds,
    hour12,
    ampm,
    dateFormatted,
    timeString24: `${hours24}:${minutes}`,
  };
}

export function shouldAlarmTrigger(
  currentTimeStr: string,
  currentSeconds: number,
  alarmTime: string,
  isAlreadyRinging: boolean,
): boolean {
  if (isAlreadyRinging) return false;
  return currentTimeStr === alarmTime && currentSeconds === 0;
}

export function calculateSnoozeAlarmTime(currentTime: Date = new Date(), snoozeMinutes: number = 10): string {
  const snoozeDate = new Date(currentTime.getTime() + snoozeMinutes * 60 * 1000);
  const hours = String(snoozeDate.getHours()).padStart(2, "0");
  const mins = String(snoozeDate.getMinutes()).padStart(2, "0");
  return `${hours}:${mins}`;
}

export function playHarmonicChime(audioContext?: AudioContext | null): void {
  try {
    const ctx = audioContext || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    const notes = CHIME_FREQUENCIES;
    const now = ctx.currentTime;

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + idx * 0.18);

      gain.gain.setValueAtTime(0.001, now + idx * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, now + idx * 0.18 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.18 + 1.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.18);
      osc.stop(now + idx * 0.18 + 1.3);
    });
  } catch {
    // AudioContext blocked or unsupported in test / headless environment
  }
}

export interface BedsideBriefingCacheState {
  ready: boolean;
  status: "idle" | "checking" | "cached" | "caching" | "failed";
  packId?: string;
  audioBytes: number;
  message?: string;
}

export async function checkBedsideBriefingAudioCache(
  briefing?: DailyBriefingData,
  language = "en-NZ",
  store?: BriefingAudioCacheStore,
): Promise<BedsideBriefingCacheState> {
  if (!briefing) {
    return { ready: false, status: "idle", audioBytes: 0, message: "No active briefing loaded." };
  }

  const packId = computeBriefingPackId(briefing, language);
  const audioStore = store || (typeof caches !== "undefined" ? new BrowserCacheStorageAudioStore(caches) : new MemoryBriefingAudioStore());

  try {
    const blob = await audioStore.get(packId);
    if (blob && blob.size > 44) {
      return {
        ready: true,
        status: "cached",
        packId,
        audioBytes: blob.size,
        message: `Offline audio ready (${(blob.size / 1024).toFixed(0)} KB).`,
      };
    }
  } catch {}

  return { ready: false, status: "idle", packId, audioBytes: 0, message: "Audio not yet cached locally." };
}

export async function prewarmBedsideBriefingAudio(
  briefing?: DailyBriefingData,
  language = "en-NZ",
  options?: {
    store?: BriefingAudioCacheStore;
    signal?: AbortSignal;
  },
): Promise<BedsideBriefingCacheState> {
  if (!briefing) {
    return { ready: false, status: "failed", audioBytes: 0, message: "No briefing available to cache." };
  }

  const packId = computeBriefingPackId(briefing, language);
  const audioStore = options?.store || (typeof caches !== "undefined" ? new BrowserCacheStorageAudioStore(caches) : new MemoryBriefingAudioStore());

  // Check if already ready
  try {
    const existing = await audioStore.get(packId);
    if (existing && existing.size > 44) {
      return {
        ready: true,
        status: "cached",
        packId,
        audioBytes: existing.size,
        message: `Offline audio ready (${(existing.size / 1024).toFixed(0)} KB).`,
      };
    }
  } catch {}

  // Pack offline briefing
  try {
    const meta = await saveOfflineBriefingPack({
      briefing,
      language,
      audioStore,
      signal: options?.signal,
    });

    return {
      ready: meta.hasNeuralAudio && meta.audioBytes > 44,
      status: meta.hasNeuralAudio ? "cached" : "failed",
      packId,
      audioBytes: meta.audioBytes,
      message: meta.hasNeuralAudio
        ? `Offline briefing audio ready (${(meta.audioBytes / 1024).toFixed(0)} KB).`
        : (meta.audioWarning || "Synthesized script cached without audio."),
    };
  } catch (err) {
    return {
      ready: false,
      status: "failed",
      packId,
      audioBytes: 0,
      message: err instanceof Error ? err.message : "Failed to prewarm bedside briefing audio.",
    };
  }
}
