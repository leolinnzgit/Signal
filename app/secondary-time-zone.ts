export type SecondaryTimeZonePreference = {
  name: string;
  timeZone: string;
};

export function isSupportedTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeSecondaryTimeZone(
  value: unknown,
): SecondaryTimeZonePreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { name?: unknown; timeZone?: unknown };
  if (typeof candidate.name !== "string" || typeof candidate.timeZone !== "string")
    return null;

  const name = candidate.name
    .split(",", 1)[0]
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const timeZone = candidate.timeZone.trim().slice(0, 80);
  return name && timeZone && isSupportedTimeZone(timeZone)
    ? { name, timeZone }
    : null;
}
