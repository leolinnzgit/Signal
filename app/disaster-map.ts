export const hazardKinds = ["earthquake", "flood", "storm", "wildfire", "volcano", "drought"] as const;
export type HazardKind = typeof hazardKinds[number];
export const hazardLabels: Record<HazardKind, string> = {
  earthquake: "Earthquakes", flood: "Floods", storm: "Cyclones", wildfire: "Wildfires", volcano: "Volcanoes", drought: "Droughts",
};
export type MapEvent = {
  id: string; kind: HazardKind; source: string; place: string; timeUtc: string;
  latitude?: number; longitude?: number; url: string; distanceKm: number | null;
  magnitude?: number; depthKm?: number; description?: string; alertLevel?: string; endTimeUtc?: string | null;
};
export type DisasterReport = Omit<MapEvent, "place"> & { title: string };

export function mapEvents(earthquakes: Omit<MapEvent, "kind">[], disasters: DisasterReport[], locationKnown = true): MapEvent[] {
  return [...earthquakes.map(e => ({ ...e, distanceKm: locationKnown ? e.distanceKm : null, kind: "earthquake" as const })), ...disasters.map(e => ({ ...e, place: e.title }))];
}
export function filterMapEvents(events: MapEvent[], kinds: HazardKind[], minimumMagnitude: number) {
  return events.filter(e => kinds.includes(e.kind) && (e.kind !== "earthquake" || (e.magnitude ?? 0) >= minimumMagnitude));
}
export function eventColor(event: MapEvent): string {
  if (event.kind !== "earthquake") return { flood: "#38bdf8", storm: "#a78bfa", wildfire: "#fb923c", volcano: "#f472b6", drought: "#facc15" }[event.kind];
  const mag = event.magnitude ?? 0;
  return mag >= 6 ? "#ef4444" : mag >= 5 ? "#f97316" : mag >= 4 ? "#eab308" : "#06b6d4";
}
export function eventSymbol(event: MapEvent): string {
  return event.kind === "earthquake" ? (event.magnitude ?? 0).toFixed(1)
    : { flood: "FL", storm: "TC", wildfire: "WF", volcano: "VO", drought: "DR" }[event.kind];
}
export function eventDetails(event: MapEvent): string {
  const distance = event.distanceKm == null ? "Distance unavailable" : `${Math.round(event.distanceKm).toLocaleString()} km away`;
  return event.kind === "earthquake" ? `${distance} · ${Math.round(event.depthKm ?? 0)} km depth`
    : `${distance} · ${event.alertLevel === "unknown" ? "Alert level unavailable" : `${event.alertLevel ?? "unknown"} alert`}`;
}
// An unconfigured map still plots real coordinates rather than invented bearings or distances.
export function overviewPosition(latitude: number, longitude: number) {
  return { cx: longitude / 180 * 220, cy: -latitude / 90 * 110 };
}
