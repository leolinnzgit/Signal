export type VoiceIntent = "all-topics" | "follow" | "filter" | "search" | "query";

export type VoiceCommandResult = {
  intent: VoiceIntent;
  query: string;
  raw: string;
};

export type VoiceTranscriptionResponse = {
  available: boolean;
  text: string;
  status?: string;
  reason: string;
};

/**
 * Cleans spoken speech transcripts into crisp search / topic queries
 * by trimming trailing dictation punctuation and collapsing whitespace.
 */
export function normalizeVoiceQuery(raw: string): string {
  return (raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^["""'']+|["""''.?!,;:。？！，；：]+$/g, "")
    .trim();
}

/**
 * Parses natural spoken commands such as "Search for earthquake", "Follow Rocket Lab",
 * "Filter by Wellington", or "Show all topics", falling back to a direct query.
 */
export function parseVoiceCommand(raw: string): VoiceCommandResult {
  const cleaned = normalizeVoiceQuery(raw);
  const lower = cleaned.toLowerCase();

  if (
    lower === "all topics" ||
    lower === "show all topics" ||
    lower === "all stories" ||
    lower === "clear topic" ||
    lower === "clear filter"
  ) {
    return { intent: "all-topics", query: "", raw: cleaned };
  }

  const followMatch = cleaned.match(/^(?:follow|add topic|subscribe to)\s+(.+)$/i);
  if (followMatch && followMatch[1]) {
    const q = normalizeVoiceQuery(followMatch[1]);
    if (q) return { intent: "follow", query: q, raw: cleaned };
  }

  const filterMatch = cleaned.match(/^(?:filter by|filter topic|show topic|open topic|topic)\s+(.+)$/i);
  if (filterMatch && filterMatch[1]) {
    const q = normalizeVoiceQuery(filterMatch[1]);
    if (q) return { intent: "filter", query: q, raw: cleaned };
  }

  const searchMatch = cleaned.match(/^(?:search for|search|find stories about|find|look up)\s+(.+)$/i);
  if (searchMatch && searchMatch[1]) {
    const q = normalizeVoiceQuery(searchMatch[1]);
    if (q) return { intent: "search", query: q, raw: cleaned };
  }

  return { intent: "query", query: cleaned, raw: cleaned };
}

/**
 * Downsamples Float32 PCM audio from the browser's hardware sample rate (e.g. 44.1/48 kHz) to 16 kHz.
 */
export function downsampleFloat32Buffer(
  buffer: Float32Array,
  inputRate: number,
  targetRate = 16000,
): Float32Array {
  if (targetRate <= 0 || inputRate <= 0 || buffer.length === 0) return new Float32Array(0);
  if (inputRate <= targetRate) return buffer;

  const ratio = inputRate / targetRate;
  const newLength = Math.max(1, Math.round(buffer.length / ratio));
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(buffer.length, Math.round((offsetResult + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      sum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? sum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

/**
 * Encodes mono Float32 PCM samples (-1..1) into a standard 16-bit PCM RIFF/WAVE binary payload
 * accepted natively by Azure AI Speech STT REST v1.
 */
export function encodePcm16Wav(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const dataByteLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate = SampleRate * BlockAlign
  view.setUint16(32, 2, true); // BlockAlign = 2 bytes
  view.setUint16(34, 16, true); // BitsPerSample = 16
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

/**
 * Sends a 16 kHz mono WAV buffer to Signal's Azure AI Speech STT endpoint with CSRF protection.
 */
export async function transcribeWavAudio(
  wavBytes: Uint8Array,
  language = "en-NZ",
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<VoiceTranscriptionResponse> {
  if (!wavBytes || wavBytes.byteLength < 44) {
    return { available: false, text: "", reason: "Recording was too short." };
  }

  try {
    const csrf = await fetcher("/api/auth/csrf", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!csrf.ok) throw new Error("Could not acquire security token.");
    const { token } = (await csrf.json()) as { token?: string };
    if (!token) throw new Error("Security token missing.");

    const cleanLang = encodeURIComponent((language || "en-NZ").trim());
    const response = await fetcher(`/api/voice-search/transcribe?language=${cleanLang}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
        "X-XSRF-TOKEN": token,
      },
      body: wavBytes as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error("Voice recognition is currently unavailable.");
    }

    const data = (await response.json()) as VoiceTranscriptionResponse;
    return {
      available: Boolean(data.available && data.text),
      text: data.text || "",
      status: data.status,
      reason: data.reason || "",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to transcribe voice recording.";
    return { available: false, text: "", reason: msg };
  }
}

export type ActiveVoiceSession = {
  /** Stops listening and processes captured speech (if recording WAV) or finishes recognition. */
  finish: () => void;
  /** Cancels capture immediately without emitting a result. */
  cancel: () => void;
};

type MinimalSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getWebSpeechConstructor(): (new () => MinimalSpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => MinimalSpeechRecognition;
    webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

export function isVoiceInputSupported(): boolean {
  if (typeof window === "undefined") return false;
  if (getWebSpeechConstructor()) return true;
  return Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function");
}

/**
 * Starts a voice capture session:
 * 1. Uses native Web Speech API when available for zero-latency, zero-quota dictation.
 * 2. Automatically falls back to Web Audio 16 kHz PCM WAV capture + Azure AI Speech STT
 *    on browsers without Web Speech (e.g. Firefox) or if cloud Web Speech fails.
 */
export function startVoiceCapture(callbacks: {
  language?: string;
  onStateChange: (state: "listening" | "transcribing" | "idle") => void;
  onTranscript: (transcript: string) => void;
  onError: (message: string) => void;
}): ActiveVoiceSession {
  const language =
    callbacks.language ||
    (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-NZ");

  let cancelled = false;
  let activeStopFn: (() => void) | null = null;
  let activeCancelFn: (() => void) | null = null;

  const startWavAzureFallback = async () => {
    if (cancelled) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      callbacks.onStateChange("idle");
      callbacks.onError("Voice input is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);

      const chunks: Float32Array[] = [];
      let totalSamples = 0;
      let heardSpeech = false;
      let silenceSince = 0;
      let finalized = false;

      const cleanupAudio = () => {
        try {
          processor.disconnect();
          source.disconnect();
        } catch {
          // Ignore
        }
        stream.getTracks().forEach((t) => t.stop());
        void audioCtx.close().catch(() => {});
      };

      const finalizeRecording = async () => {
        if (finalized) return;
        finalized = true;
        if (maxTimer) window.clearTimeout(maxTimer);
        cleanupAudio();

        if (cancelled || totalSamples === 0) {
          callbacks.onStateChange("idle");
          return;
        }

        callbacks.onStateChange("transcribing");
        const merged = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        const downsampled = downsampleFloat32Buffer(merged, audioCtx.sampleRate, 16000);
        const wavBytes = encodePcm16Wav(downsampled, 16000);
        const res = await transcribeWavAudio(wavBytes, language);

        if (cancelled) return;
        callbacks.onStateChange("idle");

        if (res.available && res.text.trim()) {
          callbacks.onTranscript(res.text.trim());
        } else {
          callbacks.onError(res.reason || "No speech detected.");
        }
      };

      processor.onaudioprocess = (event) => {
        if (finalized || cancelled) return;
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        chunks.push(copy);
        totalSamples += copy.length;

        // Simple RMS energy voice activity detector for hands-free auto-stop
        let sumSq = 0;
        for (let i = 0; i < copy.length; i++) sumSq += copy[i] * copy[i];
        const rms = Math.sqrt(sumSq / copy.length);
        const now = performance.now();

        if (rms > 0.018) {
          heardSpeech = true;
          silenceSince = 0;
        } else if (heardSpeech) {
          if (silenceSince === 0) silenceSince = now;
          else if (now - silenceSince > 1300) {
            void finalizeRecording();
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      callbacks.onStateChange("listening");

      const maxTimer = window.setTimeout(() => {
        void finalizeRecording();
      }, 7500);

      activeStopFn = () => {
        void finalizeRecording();
      };
      activeCancelFn = () => {
        finalized = true;
        window.clearTimeout(maxTimer);
        cleanupAudio();
        callbacks.onStateChange("idle");
      };
    } catch {
      if (!cancelled) {
        callbacks.onStateChange("idle");
        callbacks.onError("Microphone permission was denied or unavailable.");
      }
    }
  };

  const SpeechCtor = getWebSpeechConstructor();
  if (SpeechCtor) {
    try {
      const recognition = new SpeechCtor();
      recognition.lang = language;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;

      let resolved = false;
      let switchedToFallback = false;

      recognition.onresult = (event) => {
        if (cancelled) return;
        const transcript = event.results?.[0]?.[0]?.transcript?.trim() ?? "";
        if (transcript) {
          resolved = true;
          callbacks.onStateChange("idle");
          callbacks.onTranscript(transcript);
        }
      };

      recognition.onerror = (event) => {
        if (cancelled || resolved) return;
        if (
          event.error === "network" ||
          event.error === "service-not-allowed" ||
          event.error === "language-not-supported"
        ) {
          switchedToFallback = true;
          void startWavAzureFallback();
          return;
        }
        callbacks.onStateChange("idle");
        if (event.error === "not-allowed" || event.error === "audio-capture") {
          callbacks.onError("Allow microphone access to use voice search.");
        } else if (event.error !== "aborted") {
          callbacks.onError("No speech heard. Tap the microphone to try again.");
        }
      };

      recognition.onend = () => {
        if (cancelled || resolved || switchedToFallback) return;
        callbacks.onStateChange("idle");
      };

      callbacks.onStateChange("listening");
      recognition.start();

      activeStopFn = () => {
        try {
          recognition.stop();
        } catch {
          // Ignore
        }
      };
      activeCancelFn = () => {
        try {
          recognition.abort();
        } catch {
          // Ignore
        }
        callbacks.onStateChange("idle");
      };
    } catch {
      void startWavAzureFallback();
    }
  } else {
    void startWavAzureFallback();
  }

  return {
    finish: () => {
      if (!cancelled && activeStopFn) activeStopFn();
    },
    cancel: () => {
      cancelled = true;
      if (activeCancelFn) activeCancelFn();
    },
  };
}
