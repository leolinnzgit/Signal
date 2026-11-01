export interface CoHostVoiceMatch {
  isQuestion: boolean;
  questionText: string;
}

export interface CoHostState {
  asking: boolean;
  question?: string;
  answer?: string;
  mode?: "azure-ai" | "extractive" | "offline-local" | "empty";
  citations?: Array<{ url: string; title: string; source: string }>;
  error?: string;
}

/**
 * Detects voice co-host questions and extract clean query strings
 * from transcribed speech during briefing and car mode playback.
 */
export function detectCoHostQuestionIntent(input: string): CoHostVoiceMatch | null {
  const clean = (input || "").trim();
  if (!clean) return null;
  const lower = clean.toLowerCase();

  // Ignore navigation & standard player commands
  if (
    /^(?:pause|wait|hold|play|resume|start|next|skip|forward|previous|back|rewind|snooze|queue|stop|exit|close)$/i.test(
      lower,
    )
  ) {
    return null;
  }

  // 1. Explicit prefixes: "question: ...", "question ...", "hey co-host ...", "co-host ..."
  const prefixMatch = clean.match(
    /^(?:question[:\s]+|hey\s+co[- ]?host[:\s]+|co[- ]?host[:\s]+|ask\s+co[- ]?host[:\s]+)(.+)$/i,
  );
  if (prefixMatch && prefixMatch[1].trim().length >= 3) {
    return {
      isQuestion: true,
      questionText: prefixMatch[1].trim(),
    };
  }

  // 2. Conversational triggers: "tell me more about ...", "tell me about ...", "explain ...", "what is ...", etc.
  const triggers = [
    "tell me more about",
    "tell me about",
    "explain to me",
    "explain",
    "what is",
    "what's",
    "what are",
    "why is",
    "why are",
    "how is",
    "how does",
    "who is",
    "summarize today's",
    "summarize todays",
    "summarize the",
    "how are my",
    "do i need an umbrella",
  ];

  for (const trigger of triggers) {
    if (lower.startsWith(trigger) && clean.length > trigger.length + 2) {
      return {
        isQuestion: true,
        questionText: clean,
      };
    }
  }

  // 3. Questions ending in '?' with at least 3 words
  if (clean.endsWith("?") && clean.split(/\s+/).length >= 3) {
    return {
      isQuestion: true,
      questionText: clean,
    };
  }

  return null;
}
