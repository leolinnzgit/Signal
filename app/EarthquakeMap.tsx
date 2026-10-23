"use client";

/* Effects synchronize request state and the external Azure Maps SDK. */
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EarthquakeReport } from "./EarthquakeAlert";
import { hazardKinds, hazardLabels, mapEvents, filterMapEvents, eventColor, eventSymbol, eventDetails, overviewPosition, type MapEvent, type HazardKind, type DisasterReport } from "./disaster-map";

// Ambient declarations for Azure Maps Web SDK v3 (atlas) loaded from CDN
/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    atlas?: {
      Map: new (container: HTMLElement, options: Record<string, any>) => any;
      Popup: new (options?: Record<string, any>) => any;
      HtmlMarker: new (options?: Record<string, any>) => any;
      control: {
        ZoomControl: new (options?: Record<string, any>) => any;
        PitchControl: new (options?: Record<string, any>) => any;
        CompassControl: new (options?: Record<string, any>) => any;
        StyleControl: new (options?: Record<string, any>) => any;
      };
      data: {
        Position: new (longitude: number, latitude: number) => any;
      };
    };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type EarthquakeMapFeedResponse = {
  azureMapsConfigured: boolean;
  subscriptionKey: string;
  source: string;
  events: EarthquakeReport[];
  disasters?: DisasterReport[];
  warnings?: string[];
  userLocation: { latitude: number; longitude: number; radiusKm: number } | null;
  checkedAtUtc: string;
};

export default function EarthquakeMap({
  isOpen,
  onClose,
  targetQuake,
  userCoordinates,
}: {
  isOpen: boolean;
  onClose: () => void;
  targetQuake?: EarthquakeReport | MapEvent | null;
  userCoordinates?: { latitude: number; longitude: number; radiusKm?: number } | null;
}) {
  const userLatitude = userCoordinates?.latitude;
  const userLongitude = userCoordinates?.longitude;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  const cameraRef = useRef<{ center: number[]; zoom: number } | null>(null);
  const [data, setData] = useState<EarthquakeMapFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"auto" | "geonet" | "usgs">("auto");
  const [minMagnitude, setMinMagnitude] = useState<number>(0);
  const [activeQuake, setActiveQuake] = useState<MapEvent | null>(null);
  const [kinds, setKinds] = useState<HazardKind[]>([...hazardKinds]);
  const [refresh, setRefresh] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [sdkFailed, setSdkFailed] = useState(false);
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    const followFullscreen = () => setHost(document.fullscreenElement ?? document.body);
    followFullscreen();
    document.addEventListener("fullscreenchange", followFullscreen);
    return () => document.removeEventListener("fullscreenchange", followFullscreen);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const element = dialogRef.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [isOpen, host]);

  // Load Azure Maps SDK script & stylesheet from Microsoft CDN if configured
  useEffect(() => {
    if (!isOpen || !data?.azureMapsConfigured) return;
    if (window.atlas) {
      setSdkLoaded(true);
      return;
    }
    const cssId = "azure-maps-sdk-css";
    if (!document.getElementById(cssId)) {
      const link = document.createElement("link");
      link.id = cssId;
      link.rel = "stylesheet";
      link.href = "https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.css";
      link.type = "text/css";
      document.head.appendChild(link);
    }
    const scriptId = "azure-maps-sdk-script";
    const existing = document.getElementById(scriptId);
    if (existing) {
      existing.addEventListener("load", () => setSdkLoaded(true));
      return;
    }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://atlas.microsoft.com/sdk/javascript/mapcontrol/3/atlas.min.js";
    script.async = true;
    script.onload = () => setSdkLoaded(true);
    script.onerror = () => {
      // Azure Maps CDN unavailable, fallback continues to display SVG radar
      setSdkLoaded(false);
      setSdkFailed(true);
    };
    document.head.appendChild(script);
  }, [isOpen, data?.azureMapsConfigured]);

  // Fetch earthquake feed and Azure Maps configuration
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    const lat = userCoordinates?.latitude;
    const lon = userCoordinates?.longitude;
    const query = new URLSearchParams();
    if (lat !== undefined && lon !== undefined) {
      query.set("latitude", lat.toString());
      query.set("longitude", lon.toString());
    }
    if (selectedSource !== "auto") {
      query.set("source", selectedSource);
    }

    fetch(`/api/earthquakes/map-feed?${query.toString()}`, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        if (!res.ok) throw new Error("Could not retrieve disaster map data.");
        return res.json();
      })
      .then((feedData: EarthquakeMapFeedResponse) => {
        if (cancelled) return;
        setData(feedData);
        const all = mapEvents(feedData.events, feedData.disasters ?? [], !!feedData.userLocation);
        if (targetQuake) all.unshift({ ...targetQuake, kind: "kind" in targetQuake ? targetQuake.kind : "earthquake" });
        setActiveQuake(current => all.find(e => e.id === current?.id) ?? all[0] ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Disaster feeds unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isOpen, selectedSource, userCoordinates?.latitude, userCoordinates?.longitude, targetQuake, refresh]);

  const allEvents = useMemo(() => {
    const result = mapEvents(data?.events ?? [], data?.disasters ?? [], !!data?.userLocation);
    if (targetQuake && !result.some(e => e.id === targetQuake.id)) result.unshift({ ...targetQuake, kind: "kind" in targetQuake ? targetQuake.kind : "earthquake" });
    return result;
  }, [data, targetQuake]);
  const events = useMemo(() => filterMapEvents(allEvents, kinds, minMagnitude), [allEvents, kinds, minMagnitude]);
  const selectedEvent = events.find(e => e.id === activeQuake?.id) ?? events[0] ?? null;

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => setRefresh(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  // Selecting a report also moves the map camera.
  const selectQuake = useCallback((quake: MapEvent) => {
    setActiveQuake(quake);
    if (mapInstanceRef.current && quake.latitude !== undefined && quake.longitude !== undefined) {
      mapInstanceRef.current.setCamera({
        center: [quake.longitude, quake.latitude],
        zoom: 7,
        type: "ease",
        duration: 500,
      });
    }
  }, []);


  // Initialize or update Azure Map instance
  useEffect(() => { cameraRef.current = null; }, [targetQuake]);

  useEffect(() => {
    if (!isOpen || !data?.azureMapsConfigured || !data.subscriptionKey || !sdkLoaded || !window.atlas) {
      return;
    }
    setMapReady(false);
    const container = mapContainerRef.current;
    if (!container) return;

    const theme = document.documentElement.dataset.theme === "light" ? "road" : "night";
    const defaultCenter = targetQuake
      ? [targetQuake.longitude ?? 174.77, targetQuake.latitude ?? -41.28]
      : data.userLocation
        ? [data.userLocation.longitude, data.userLocation.latitude]
        : data.events.length > 0
          ? [data.events[0].longitude ?? 174.77, data.events[0].latitude ?? -41.28]
          : [174.77, -41.28];

    // Dispose old map if switching container
    if (mapInstanceRef.current) {
      mapInstanceRef.current.dispose();
      mapInstanceRef.current = null;
    }

    try {
      const map = new window.atlas.Map(container, {
        authOptions: {
          authType: "subscriptionKey",
          subscriptionKey: data.subscriptionKey,
        },
        center: cameraRef.current?.center ?? defaultCenter,
        zoom: cameraRef.current?.zoom ?? (targetQuake ? 7 : 2),
        style: theme,
        view: "Auto",
      });

      mapInstanceRef.current = map;

      map.events.add("error", () => { setSdkFailed(true); setMapReady(false); });
      map.events.add("ready", () => {
        setSdkFailed(false);
        setMapReady(true);
        // Add zoom and pitch controls
        map.controls.add(
          [
            new window.atlas!.control.ZoomControl(),
            new window.atlas!.control.PitchControl(),
            new window.atlas!.control.CompassControl(),
            new window.atlas!.control.StyleControl({
              mapStyles: ["road", "night", "grayscale_dark", "satellite", "satellite_road_labels"],
            }),
          ],
          { position: "top-right" },
        );

        // Add user location pin if available
        const userLoc = data.userLocation ?? (userLatitude !== undefined && userLongitude !== undefined ? { latitude: userLatitude, longitude: userLongitude } : null);
        if (userLoc) {
          const userEl = document.createElement("div");
          userEl.className = "earthquake-map-user-marker";
          userEl.title = "Your location";
          userEl.innerHTML = `<div class="user-pulse"></div><div class="user-dot"></div>`;
          const userMarker = new window.atlas!.HtmlMarker({
            position: [userLoc.longitude, userLoc.latitude],
            htmlContent: userEl,
          });
          map.markers.add(userMarker);
        }

        // Add earthquake markers
        const filteredEvents = events;
        filteredEvents.forEach((quake) => {
          if (quake.latitude === undefined || quake.longitude === undefined) return;
          const markerEl = document.createElement("div");
          markerEl.className = `earthquake-map-pin ${(quake.magnitude ?? 0) >= 5.0 ? "major" : ""}`;
          markerEl.style.setProperty("--pin-color", eventColor(quake));
          markerEl.innerHTML = `<span class="pin-mag">${eventSymbol(quake)}</span><span class="pin-wave"></span>`;
          markerEl.title = `${hazardLabels[quake.kind]}: ${quake.place}`;

          const marker = new window.atlas!.HtmlMarker({
            position: [quake.longitude, quake.latitude],
            htmlContent: markerEl,
          });

          map.events.add("click", marker, () => {
            setActiveQuake(quake);
            map.setCamera({
              center: [quake.longitude, quake.latitude],
              zoom: Math.max(map.getCamera().zoom, 7),
              type: "ease",
              duration: 500,
            });
          });

          markerEl.tabIndex = 0;
          markerEl.setAttribute("role", "button");
          markerEl.setAttribute("aria-label", markerEl.title);
          markerEl.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectQuake(quake); } });
          map.markers.add(marker);
        });
      });
    } catch {
      setSdkFailed(true);
      // Keep the coordinate overview available if WebGL is unavailable.
    }

    return () => {
      if (mapInstanceRef.current) {
        const camera = mapInstanceRef.current.getCamera();
        if (camera.center && Number.isFinite(camera.zoom)) cameraRef.current = { center: camera.center, zoom: camera.zoom };
        mapInstanceRef.current.dispose();
        mapInstanceRef.current = null;
      }
    };
  }, [isOpen, data, sdkLoaded, events, targetQuake, userLatitude, userLongitude, host, selectQuake]);


  if (!isOpen || !host) return null;


  return createPortal(
    <dialog
      ref={dialogRef}
      className="earthquake-map-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Disaster map"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="earthquake-map-modal">
        {/* Header Bar */}
        <header className="earthquake-map-header">
          <div className="earthquake-map-title-group">
            <h2>Disaster Map</h2>
            <div className="earthquake-map-status-badges">
              <span className="source-badge">
                {data ? `${data.source} + GDACS · ${events.length} reports` : "Loading reports…"}
              </span>
              {data?.azureMapsConfigured ? (
                <span className="azure-badge active" title="Azure Maps Gen2 active">
                  <span className="dot" /> Azure Maps
                </span>
              ) : (
                <span className="azure-badge standby" title="Configure Azure Maps key for live satellite/night maps">
                  Coordinate overview
                </span>
              )}
            </div>
          </div>

          {/* Filter and Source Controls */}
          <div className="earthquake-map-filters">
            <div className="filter-group" role="group" aria-label="Earthquake source">
              <button
                type="button"
                className={`filter-btn ${selectedSource === "auto" ? "active" : ""}`}
                aria-pressed={selectedSource === "auto"}
                onClick={() => setSelectedSource("auto")}
              >
                Auto (Local)
              </button>
              <button
                type="button"
                className={`filter-btn ${selectedSource === "geonet" ? "active" : ""}`}
                aria-pressed={selectedSource === "geonet"}
                onClick={() => setSelectedSource("geonet")}
              >
                GeoNet (NZ)
              </button>
              <button
                type="button"
                className={`filter-btn ${selectedSource === "usgs" ? "active" : ""}`}
                aria-pressed={selectedSource === "usgs"}
                onClick={() => setSelectedSource("usgs")}
              >
                USGS (Global)
              </button>
            </div>

            <div className="filter-group" role="group" aria-label="Earthquake magnitude filter">
              {[0, 3, 4, 5].map((mag) => (
                <button
                  key={mag}
                  type="button"
                  className={`filter-btn ${minMagnitude === mag ? "active" : ""}`}
                  aria-pressed={minMagnitude === mag}
                  onClick={() => setMinMagnitude(mag)}
                >
                  {mag === 0 ? "All magnitudes" : `${mag}.0+`}
                </button>
              ))}
            </div>

            <button type="button" className="filter-btn" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? "Updating…" : "Refresh"}</button>
            {data?.azureMapsConfigured && <button type="button" className="filter-btn" onClick={() => mapInstanceRef.current?.setCamera({ center: [0, 20], zoom: 1.5 })}>World view</button>}
            <button type="button" className="earthquake-map-close" onClick={onClose} aria-label="Close disaster map">
              ✕
            </button>
          </div>
        </header>
        <div className="disaster-map-toolbar">
          <div className="hazard-filters" role="group" aria-label="Disaster types">
            {hazardKinds.map(kind => <button key={kind} type="button" aria-pressed={kinds.includes(kind)}
              onClick={() => setKinds(current => current.includes(kind) ? current.filter(k => k !== kind) : [...current, kind])}>
              <span style={{ background: eventColor({ kind } as MapEvent) }} />{hazardLabels[kind]} ({allEvents.filter(e => e.kind === kind).length})
            </button>)}
          </div>
          <p>GDACS global reports updated in the past week. Pins show reported locations, not affected boundaries or evacuation zones. Follow local authorities for instructions.</p>
          <p className="disaster-map-updated">{data ? `Checked ${new Date(data.checkedAtUtc).toLocaleString()}. Refreshes every minute.` : "Checking feeds…"}</p>
          {data?.warnings?.map(warning => <p role="alert" key={warning}>{warning}</p>)}
        </div>

        {/* Main Workspace: Map Canvas + Details Drawer */}
        <div className="earthquake-map-body">
          <div className="earthquake-map-canvas-area">
            {loading && !data && (
              <div className="earthquake-map-loading" role="status">
                <div className="spinner" />
                <p>Loading earthquake and disaster reports…</p>
              </div>
            )}

            {error && (
              <div className="earthquake-map-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => setRefresh(value => value + 1)}>
                  Retry
                </button>
              </div>
            )}

            {/* Azure Maps Web SDK Container */}
            {data?.azureMapsConfigured && (
              <div
                ref={mapContainerRef}
                className="earthquake-azure-map-container"
                aria-label="Interactive Azure Map"
              />
            )}
            {(!data?.azureMapsConfigured || !mapReady || sdkFailed) && (
              <div className="earthquake-radar-fallback">
                <p className="coordinate-overview-label">Global coordinate overview · select a report for details</p>
                <div className="radar-canvas-wrap">
                  <svg viewBox="-240 -130 480 260" className="radar-grid" role="img" aria-label="Global disaster coordinates, north at top">
                    <rect x="-220" y="-110" width="440" height="220" className="radar-ring outer" />
                    {[-180, -90, 0, 90, 180].map(lon => <g key={lon}><line x1={lon / 180 * 220} y1="-110" x2={lon / 180 * 220} y2="110" className="radar-axis" /><text x={lon / 180 * 220} y="124" textAnchor="middle" className="radar-label">{lon}°</text></g>)}
                    {[-90, -45, 0, 45, 90].map(lat => <line key={lat} x1="-220" y1={-lat / 90 * 110} x2="220" y2={-lat / 90 * 110} className="radar-axis" />)}
                    <text x="-215" y="-115" className="radar-label">90°N</text><text x="-215" y="106" className="radar-label">90°S</text>
                    {/* Plotted earthquakes */}
                    {events.map(e => {
                      if (e.latitude === undefined || e.longitude === undefined) return null;
                      const { cx, cy } = overviewPosition(e.latitude, e.longitude);
                      const color = eventColor(e);
                      const isSelected = selectedEvent?.id === e.id;

                      return (
                        <g
                          key={e.id}
                          className={`radar-quake-group ${isSelected ? "selected" : ""}`}
                          onClick={() => selectQuake(e)}
                          cursor="pointer" role="button" tabIndex={0} aria-label={`${hazardLabels[e.kind]}: ${e.place}`}
                          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectQuake(e); } }}
                        >
                          <circle cx={cx} cy={cy} r={isSelected ? 14 : 9} fill={color} opacity={0.85} />
                          {isSelected && (
                            <circle cx={cx} cy={cy} r={22} fill="none" stroke={color} strokeWidth="2" opacity={0.6}>
                              <animate attributeName="r" from="10" to="28" dur="1.5s" repeatCount="indefinite" />
                              <animate attributeName="opacity" from="0.8" to="0" dur="1.5s" repeatCount="indefinite" />
                            </circle>
                          )}
                          <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#ffffff">
                            {eventSymbol(e)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}
          </div>

          {/* Active Earthquake Detail Card */}
          {selectedEvent && (
            <aside className="earthquake-active-card" aria-label="Selected disaster details">
              <div className="card-mag" style={{ background: eventColor(selectedEvent) }}>
                <span>{selectedEvent.kind === "earthquake" ? "MAG" : selectedEvent.kind}</span>
                <strong>{eventSymbol(selectedEvent)}</strong>
              </div>
              <div className="card-info">
                <h3>{selectedEvent.place}</h3>
                <div className="card-meta">
                  <span>{eventDetails(selectedEvent)}</span>
                  <span>
                    {selectedEvent.source} · {new Date(selectedEvent.timeUtc).toLocaleString()}
                  </span>
                </div>
                {selectedEvent.description && <p className="disaster-description">{selectedEvent.description}</p>}
                {selectedEvent.endTimeUtc && <small>Report period through {new Date(selectedEvent.endTimeUtc).toLocaleDateString()}</small>}
              </div>
              {selectedEvent.url && (
                <a
                  className="card-link"
                  href={selectedEvent.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View source disaster report"
                >
                  Full report ↗
                </a>
              )}
            </aside>
          )}

          {/* Recent Earthquakes List Drawer */}
          <footer className="earthquake-map-drawer" aria-label="Recent disaster reports">
            <div className="drawer-scroller">
              {events.length === 0 ? (
                <p className="no-events">No reports match the selected disaster types and earthquake magnitude. Feed coverage varies by region.</p>
              ) : (
                events.map((quake) => {
                  const isSelected = selectedEvent?.id === quake.id;
                  const color = eventColor(quake);
                  return (
                    <button
                      key={quake.id}
                      type="button"
                      className={`drawer-quake-item ${isSelected ? "selected" : ""}`}
                      onClick={() => selectQuake(quake)}
                    >
                      <span className="item-mag" style={{ borderColor: color, color }}>
                        {eventSymbol(quake)}
                      </span>
                      <div className="item-details">
                        <span className="item-place">{quake.place}</span>
                        <span className="item-sub">
                          {hazardLabels[quake.kind]} · {eventDetails(quake)}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </footer>
        </div>
      </div>
    </dialog>,
    host,
  );
}
