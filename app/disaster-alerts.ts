import { hazardKinds, type HazardKind, type MapEvent } from "./disaster-map.ts";

export type DisasterNotification = MapEvent & { notificationKey: string; updatedAtUtc: string };
export type DisasterSettings = { enabled: boolean; voice: boolean; radiusKm: number; minimumMagnitude: number;
  deviceId: string; hazardKinds: HazardKind[]; minimumAlertLevel: "green" | "orange" | "red";
  weatherAlertThreshold: "all" | "warnings" };
export const defaultDisasterSettings: DisasterSettings = {
  enabled: false, voice: true, radiusKm: 300, minimumMagnitude: 4, deviceId: "", hazardKinds: [...hazardKinds], minimumAlertLevel: "green",
  weatherAlertThreshold: "all",
};
export const disasterLabels: Record<HazardKind, string> = {
  earthquake: "Earthquake", flood: "Flood", storm: "Tropical cyclone", wildfire: "Wildfire", volcano: "Volcanic activity", drought: "Drought", weather: "Severe weather",
};
export function normalizeDisasterSettings(value: Partial<DisasterSettings> | null, deviceId: string): DisasterSettings {
  const kinds = Array.isArray(value?.hazardKinds) ? hazardKinds.filter(kind => value.hazardKinds!.includes(kind)) : [...hazardKinds];
  return {
    enabled: value?.enabled === true, voice: value?.voice !== false,
    radiusKm: [50, 100, 300, 500, 1000].includes(value?.radiusKm ?? 0) ? value!.radiusKm! : 300,
    minimumMagnitude: [2, 3, 4, 5, 6, 7].includes(value?.minimumMagnitude ?? 0) ? value!.minimumMagnitude! : 4,
    deviceId: typeof value?.deviceId === "string" && /^[0-9a-f-]{36}$/i.test(value.deviceId) ? value.deviceId : deviceId,
    hazardKinds: kinds.length ? kinds : [...hazardKinds],
    minimumAlertLevel: value?.minimumAlertLevel === "orange" || value?.minimumAlertLevel === "red" ? value.minimumAlertLevel : "green",
    weatherAlertThreshold: value?.weatherAlertThreshold === "warnings" ? "warnings" : "all",
  };
}
export function normalizeDisasterNotification(event: MapEvent & { notificationKey?: string; updatedAtUtc?: string }): DisasterNotification {
  return { ...event, kind: event.kind ?? "earthquake", notificationKey: event.notificationKey ?? event.id, updatedAtUtc: event.updatedAtUtc ?? event.timeUtc };
}
export function disasterAnnouncement(event: MapEvent): string {
  const distance = event.distanceKm == null ? "" : ` About ${Math.round(event.distanceKm)} kilometres from your phone location.`;
  return event.kind === "earthquake"
    ? `Earthquake reported by ${event.source}. Magnitude ${(event.magnitude ?? 0).toFixed(1)}, ${event.place}.${distance} At a depth of ${Math.round(event.depthKm ?? 0)} kilometres.`
    : `${disasterLabels[event.kind]} reported by ${event.source}. ${event.alertLevel} alert. ${event.place}.${distance} Follow local authorities for instructions.`;
}
export function appendDisasterAlerts(queue: DisasterNotification[], events: DisasterNotification[], seen: Set<string>, kinds: HazardKind[]) {
  const keys = new Set([...seen, ...queue.map(e => e.notificationKey)]);
  const fresh = events.filter(e => { if (!kinds.includes(e.kind) || keys.has(e.notificationKey)) return false; keys.add(e.notificationKey); return true; });
  return [...queue.filter(e => kinds.includes(e.kind)), ...fresh];
}
export function matchesDisasterSettings(event: DisasterNotification, settings: DisasterSettings) {
  const levels = { green: 0, orange: 1, red: 2 };
  if (!settings.hazardKinds.includes(event.kind)) return false;
  if (event.distanceKm != null && event.distanceKm > settings.radiusKm) return false;
  if (event.kind === "earthquake") {
    return (event.magnitude ?? 0) >= settings.minimumMagnitude;
  }
  if (event.kind === "weather" && settings.weatherAlertThreshold === "warnings" && event.alertLevel !== "red") {
    return false;
  }
  return levels[event.alertLevel as keyof typeof levels] >= levels[settings.minimumAlertLevel];
}
export function previewDisaster(kind: HazardKind): DisasterNotification {
  const now = new Date().toISOString();
  return { id: `preview-${kind}`, notificationKey: `preview-${kind}`, kind, source: "Preview", timeUtc: now, updatedAtUtc: now,
    place: kind === "earthquake" ? "Cook Strait, New Zealand (Example)" : `${disasterLabels[kind]} near your location (Example)`,
    distanceKm: 42, latitude: -41.5, longitude: 174.5, url: "",
    ...(kind === "earthquake" ? { magnitude: 5.2, depthKm: 14 } : { alertLevel: "orange", description: "This is an example only. No disaster has been detected." }) };
}
