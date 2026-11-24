export const hazardKinds = ["earthquake", "flood", "storm", "wildfire", "volcano", "drought", "weather"] as const;
export type HazardKind = typeof hazardKinds[number];
export type MapLayerKind = HazardKind | "news";
export const mapLayerKinds: readonly MapLayerKind[] = ["news", ...hazardKinds];
export const hazardLabels: Record<HazardKind, string> = {
  earthquake: "Earthquakes", flood: "Floods", storm: "Cyclones", wildfire: "Wildfires", volcano: "Volcanoes", drought: "Droughts", weather: "Severe weather",
};
export const mapLayerLabels: Record<MapLayerKind, string> = {
  news: "News",
  ...hazardLabels,
};
export type MapEvent = {
  id: string; kind: HazardKind; source: string; place: string; timeUtc: string;
  latitude?: number; longitude?: number; url: string; distanceKm: number | null;
  magnitude?: number; depthKm?: number; description?: string; alertLevel?: string; endTimeUtc?: string | null;
};
export type DisasterReport = Omit<MapEvent, "place"> & { title: string };
export type NewsMapArticle = {
  id: string;
  kind: "news";
  title: string;
  locationName: string;
  source: string;
  summary: string;
  url: string;
  imageUrl?: string;
  topics: string[];
  publishedAtUtc: string;
  latitude: number;
  longitude: number;
  distanceKm: number | null;
  isRead?: boolean;
  isBookmarked?: boolean;
};
export type MapNewsEvent = {
  id: string;
  kind: "news";
  source: string;
  place: string;
  locationName: string;
  timeUtc: string;
  latitude: number;
  longitude: number;
  url: string;
  distanceKm: number | null;
  description?: string;
  imageUrl?: string;
  topics: string[];
  isRead?: boolean;
  isBookmarked?: boolean;
};
export type AnyMapEvent = MapEvent | MapNewsEvent;
export type MapPinGroup = {
  key: string;
  kind: MapLayerKind;
  latitude: number;
  longitude: number;
  items: AnyMapEvent[];
  label: string;
  title: string;
};

export function mapEvents(earthquakes: Omit<MapEvent, "kind">[], disasters: DisasterReport[], locationKnown = true): MapEvent[] {
  return [...earthquakes.map(e => ({ ...e, distanceKm: locationKnown ? e.distanceKm : null, kind: "earthquake" as const })), ...disasters.map(e => ({ ...e, place: e.title }))];
}
export function newsToMapEvents(news: readonly NewsMapArticle[], locationKnown = true): MapNewsEvent[] {
  return news
    .filter(item => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .map(item => ({
      id: item.id,
      kind: "news" as const,
      source: item.source,
      place: item.title,
      locationName: item.locationName,
      timeUtc: item.publishedAtUtc,
      latitude: item.latitude,
      longitude: item.longitude,
      url: item.url,
      distanceKm: locationKnown ? item.distanceKm : null,
      description: item.summary,
      imageUrl: item.imageUrl,
      topics: Array.isArray(item.topics) ? item.topics : [],
      isRead: item.isRead,
      isBookmarked: item.isBookmarked,
    }));
}
export function filterMapEvents(events: MapEvent[], kinds: HazardKind[], minimumMagnitude: number) {
  return events.filter(e => kinds.includes(e.kind) && (e.kind !== "earthquake" || (e.magnitude ?? 0) >= minimumMagnitude));
}
export function filterAnyMapEvents(
  events: readonly AnyMapEvent[],
  kinds: readonly MapLayerKind[],
  minimumMagnitude: number,
  newsTopic = "",
): AnyMapEvent[] {
  const normalizedTopic = newsTopic.trim().toLowerCase();
  return events.filter(e => {
    if (!kinds.includes(e.kind)) return false;
    if (e.kind === "earthquake") return (e.magnitude ?? 0) >= minimumMagnitude;
    if (e.kind === "news" && normalizedTopic) {
      return e.topics.some(topic => topic.trim().toLowerCase() === normalizedTopic);
    }
    return true;
  });
}
export function eventColor(event: Pick<AnyMapEvent, "kind"> & { magnitude?: number }): string {
  if (event.kind === "news") return "#10b981";
  if (event.kind !== "earthquake") return { flood: "#38bdf8", storm: "#a78bfa", wildfire: "#fb923c", volcano: "#f472b6", drought: "#facc15", weather: "#e11d48" }[event.kind];
  const mag = event.magnitude ?? 0;
  return mag >= 6 ? "#ef4444" : mag >= 5 ? "#f97316" : mag >= 4 ? "#eab308" : "#06b6d4";
}
export function eventSymbol(event: Pick<AnyMapEvent, "kind"> & { magnitude?: number }): string {
  if (event.kind === "news") return "NW";
  return event.kind === "earthquake" ? (event.magnitude ?? 0).toFixed(1)
    : { flood: "FL", storm: "TC", wildfire: "WF", volcano: "VO", drought: "DR", weather: "WX" }[event.kind];
}
export function eventDetails(event: AnyMapEvent): string {
  if (event.kind === "news") {
    return event.distanceKm == null
      ? event.locationName
      : `${event.locationName} · ${Math.round(event.distanceKm).toLocaleString()} km away`;
  }
  const distance = event.distanceKm == null ? "Distance unavailable" : `${Math.round(event.distanceKm).toLocaleString()} km away`;
  return event.kind === "earthquake" ? `${distance} · ${Math.round(event.depthKm ?? 0)} km depth`
    : `${distance} · ${event.alertLevel === "unknown" ? "Alert level unavailable" : `${event.alertLevel ?? "unknown"} alert`}`;
}
export function groupMapPins(events: readonly AnyMapEvent[]): MapPinGroup[] {
  const groups: MapPinGroup[] = [];
  const newsBuckets = new Map<string, MapPinGroup>();

  for (const event of events) {
    if (event.latitude === undefined || event.longitude === undefined) continue;
    if (!Number.isFinite(event.latitude) || !Number.isFinite(event.longitude)) continue;

    if (event.kind !== "news") {
      groups.push({
        key: `${event.kind}:${event.id}`,
        kind: event.kind,
        latitude: event.latitude,
        longitude: event.longitude,
        items: [event],
        label: eventSymbol(event),
        title: `${mapLayerLabels[event.kind]}: ${event.place}`,
      });
      continue;
    }

    const bucketLat = Math.round(event.latitude * 20) / 20;
    const bucketLon = Math.round(event.longitude * 20) / 20;
    const key = `news:${bucketLat.toFixed(2)}:${bucketLon.toFixed(2)}`;
    const existing = newsBuckets.get(key);
    if (existing) {
      existing.items.push(event);
      existing.label = existing.items.length > 1 ? String(existing.items.length) : "NW";
      existing.title = `${existing.items.length} news stories near ${event.locationName}`;
    } else {
      const group: MapPinGroup = {
        key,
        kind: "news",
        latitude: event.latitude,
        longitude: event.longitude,
        items: [event],
        label: "NW",
        title: `News (${event.locationName}): ${event.place}`,
      };
      newsBuckets.set(key, group);
      groups.push(group);
    }
  }

  return groups;
}
// An unconfigured map still plots real coordinates rather than invented bearings or distances.
export function overviewPosition(latitude: number, longitude: number) {
  return { cx: longitude / 180 * 220, cy: -latitude / 90 * 110 };
}
