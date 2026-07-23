const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "was", "were", "what", "when", "where", "who", "why",
  "with",
]);

function normalize(value: string) {
  return value.toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function topicMatchesText(searchableText: string, topic: string) {
  const normalizedText = normalize(searchableText);
  const normalizedTopic = normalize(topic);
  if (!normalizedText || !normalizedTopic) return false;

  if (` ${normalizedText} `.includes(` ${normalizedTopic} `)) return true;

  const textTokens = new Set(normalizedText.split(" "));
  const requiredTokens = Array.from(new Set(normalizedTopic.split(" ").filter((token) => !STOP_WORDS.has(token))));
  return requiredTokens.length > 0 && requiredTokens.every((token) => textTokens.has(token));
}
