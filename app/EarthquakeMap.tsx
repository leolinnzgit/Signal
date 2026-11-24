"use client";

/* Effects synchronize request state and the external Azure Maps SDK. */
/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EarthquakeReport } from "./EarthquakeAlert";
import {
  mapLayerKinds,
  mapLayerLabels,
  mapEvents,
  newsToMapEvents,
  filterAnyMapEvents,
  eventColor,
  eventSymbol,
  eventDetails,
  groupMapPins,
  overviewPosition,
  type MapEvent,
  type MapLayerKind,
  type DisasterReport,
  type NewsMapArticle,
  type MapNewsEvent,
  type AnyMapEvent,
  type MapPinGroup,
} from "./disaster-map";

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
  news?: NewsMapArticle[];
  warnings?: string[];
  userLocation: { latitude: number; longitude: number; radiusKm: number } | null;
  checkedAtUtc: string;
};

export type NewsMapFeedResponse = {
  articles: NewsMapArticle[];
  pendingCount: number;
  totalChecked: number;
  checkedAtUtc: string;
  warning?: string | null;
};

export default function EarthquakeMap({
  isOpen,
  onClose,
  targetQuake,
  userCoordinates,
  onOpenArticle,
}: {
  isOpen: boolean;
  onClose: () => void;
  targetQuake?: EarthquakeReport | MapEvent | null;
  userCoordinates?: { latitude: number; longitude: number; radiusKm?: number } | null;
  onOpenArticle?: (article: MapNewsEvent) => void;
}) {
  const userLatitude = userCoordinates?.latitude;
  const userLongitude = userCoordinates?.longitude;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userMarkerRef = useRef<any>(null);
  const cameraRef = useRef<{ center: number[]; zoom: number } | null>(null);
  const followUpPolledRef = useRef(false);

  const [data, setData] = useState<EarthquakeMapFeedResponse | null>(null);
  const [newsData, setNewsData] = useState<NewsMapFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"auto" | "geonet" | "usgs">("auto");
  const [minMagnitude, setMinMagnitude] = useState<number>(0);
  const [activeQuake, setActiveQuake] = useState<AnyMapEvent | null>(null);
  const [kinds, setKinds] = useState<MapLayerKind[]>([...mapLayerKinds]);
  const [selectedNewsTopic, setSelectedNewsTopic] = useState<string>("");
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

  // Fetch disaster feed and extracted news locations in parallel
  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    let cancelled = false;
    followUpPolledRef.current = false;
    setLoading(true);
    setError(null);

    const lat = userCoordinates?.latitude;
    const lon = userCoordinates?.longitude;
    const feedQuery = new URLSearchParams();
    const newsQuery = new URLSearchParams();
    if (lat !== undefined && lon !== undefined) {
      feedQuery.set("latitude", lat.toString());
      feedQuery.set("longitude", lon.toString());
      newsQuery.set("latitude", lat.toString());
      newsQuery.set("longitude", lon.toString());
    }
    if (selectedSource !== "auto") {
      feedQuery.set("source", selectedSource);
    }

    const fetchFeed = fetch(`/api/earthquakes/map-feed?${feedQuery.toString()}`, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).then((res) => {
      if (!res.ok) throw new Error("Could not retrieve disaster map data.");
      return res.json() as Promise<EarthquakeMapFeedResponse>;
    });

    const fetchNews = fetch(`/api/articles/map?${newsQuery.toString()}`, {
      signal: controller.signal,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(async (res): Promise<NewsMapFeedResponse | null> => {
        if (res.status === 404 || res.status === 401) return null;
        if (!res.ok) return null;
        return (await res.json()) as NewsMapFeedResponse;
      })
      .catch(() => null);

    Promise.all([fetchFeed, fetchNews])
      .then(([feedData, mappedNews]) => {
        if (cancelled) return;
        setData(feedData);
        setNewsData(mappedNews);
        const locationKnown = !!feedData.userLocation || (lat !== undefined && lon !== undefined);
        const combinedNews = mappedNews?.articles?.length
          ? mappedNews.articles
          : (feedData.news ?? []);
        const all: AnyMapEvent[] = [
          ...newsToMapEvents(combinedNews, locationKnown),
          ...mapEvents(feedData.events, feedData.disasters ?? [], !!feedData.userLocation),
        ];
        if (targetQuake) {
          const targetEvent: AnyMapEvent = { ...targetQuake, kind: "kind" in targetQuake ? targetQuake.kind : "earthquake" };
          all.unshift(targetEvent);
          setActiveQuake(targetEvent);
        } else {
          setActiveQuake(current => all.find(e => e.id === current?.id) ?? all[0] ?? null);
        }
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

  // If server still has pending unextracted news stories, do one quiet follow-up poll
  useEffect(() => {
    if (!isOpen || !newsData || newsData.pendingCount <= 0 || followUpPolledRef.current) return;
    followUpPolledRef.current = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const newsQuery = new URLSearchParams();
      if (userLatitude !== undefined && userLongitude !== undefined) {
        newsQuery.set("latitude", userLatitude.toString());
        newsQuery.set("longitude", userLongitude.toString());
      }
      fetch(`/api/articles/map?${newsQuery.toString()}`, {
        signal: controller.signal,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
        .then(res => (res.ok ? (res.json() as Promise<NewsMapFeedResponse>) : null))
        .then(next => {
          if (next) setNewsData(next);
        })
        .catch(() => {});
    }, 1500);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, newsData, userLatitude, userLongitude]);

  const allEvents = useMemo<AnyMapEvent[]>(() => {
    const locationKnown = !!data?.userLocation || (userLatitude !== undefined && userLongitude !== undefined);
    const combinedNews = newsData?.articles?.length ? newsData.articles : (data?.news ?? []);
    const result: AnyMapEvent[] = [
      ...newsToMapEvents(combinedNews, locationKnown),
      ...mapEvents(data?.events ?? [], data?.disasters ?? [], !!data?.userLocation),
    ];
    if (targetQuake && !result.some(e => e.id === targetQuake.id)) {
      result.unshift({ ...targetQuake, kind: "kind" in targetQuake ? targetQuake.kind : "earthquake" });
    }
    return result;
  }, [data, newsData, targetQuake, userLatitude, userLongitude]);

  const newsTopics = useMemo(() => {
    const set = new Set<string>();
    for (const item of allEvents) {
      if (item.kind === "news") {
        for (const topic of item.topics) {
          if (topic.trim()) set.add(topic.trim());
        }
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allEvents]);

  const events = useMemo(
    () => filterAnyMapEvents(allEvents, kinds, minMagnitude, selectedNewsTopic),
    [allEvents, kinds, minMagnitude, selectedNewsTopic],
  );
  const selectedEvent = events.find(e => e.id === activeQuake?.id) ?? events[0] ?? null;
  const pinGroups = useMemo(() => groupMapPins(events), [events]);

  const activeCluster = useMemo<MapNewsEvent[]>(() => {
    if (!selectedEvent || selectedEvent.kind !== "news") return [];
    const matchingGroup = pinGroups.find(
      g => g.kind === "news" && g.items.some(item => item.id === selectedEvent.id),
    );
    return (matchingGroup?.items.filter((item): item is MapNewsEvent => item.kind === "news")) ?? [selectedEvent];
  }, [pinGroups, selectedEvent]);

  const activeClusterIndex = selectedEvent?.kind === "news"
    ? Math.max(0, activeCluster.findIndex(item => item.id === selectedEvent.id))
    : 0;

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => setRefresh(value => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  // Selecting a report or news story also moves the map camera.
  const selectQuake = useCallback((quake: AnyMapEvent) => {
    setActiveQuake(quake);
    if (mapInstanceRef.current && quake.latitude !== undefined && quake.longitude !== undefined) {
      const currentZoom = mapInstanceRef.current.getCamera?.()?.zoom ?? 2;
      const targetZoom = quake.kind === "news" ? Math.max(currentZoom, 5) : Math.max(currentZoom, 7);
      mapInstanceRef.current.setCamera({
        center: [quake.longitude, quake.latitude],
        zoom: targetZoom,
        type: "ease",
        duration: 500,
      });
    }
  }, []);

  const selectPinGroup = useCallback((group: MapPinGroup) => {
    let nextItem = group.items[0];
    if (group.kind === "news" && group.items.length > 1 && selectedEvent?.kind === "news") {
      const currentIndex = group.items.findIndex(item => item.id === selectedEvent.id);
      if (currentIndex >= 0) {
        nextItem = group.items[(currentIndex + 1) % group.items.length];
      }
    }
    selectQuake(nextItem);
  }, [selectedEvent, selectQuake]);

  const selectPinGroupRef = useRef(selectPinGroup);
  useEffect(() => {
    selectPinGroupRef.current = selectPinGroup;
  }, [selectPinGroup]);

  // Reset stored camera when opening with a new target
  useEffect(() => { cameraRef.current = null; }, [targetQuake, isOpen]);

  // Initialize or dispose Azure Map instance once per open session / configuration
  useEffect(() => {
    if (!isOpen || !data?.azureMapsConfigured || !data.subscriptionKey || !sdkLoaded || !window.atlas) {
      return;
    }
    setMapReady(false);
    const container = mapContainerRef.current;
    if (!container) return;

    const theme = document.documentElement.dataset.theme === "light" ? "road" : "night";
    const firstLocated = allEvents.find(e => e.latitude !== undefined && e.longitude !== undefined);
    const defaultCenter = targetQuake
      ? [targetQuake.longitude ?? 174.77, targetQuake.latitude ?? -41.28]
      : data.userLocation
        ? [data.userLocation.longitude, data.userLocation.latitude]
        : firstLocated
          ? [firstLocated.longitude ?? 174.77, firstLocated.latitude ?? -41.28]
          : [174.77, -41.28];

    if (mapInstanceRef.current) {
      mapInstanceRef.current.dispose();
      mapInstanceRef.current = null;
    }
    markersRef.current = [];
    userMarkerRef.current = null;

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
      });
    } catch {
      setSdkFailed(true);
      // Keep the coordinate overview available if WebGL is unavailable.
    }

    return () => {
      markersRef.current = [];
      userMarkerRef.current = null;
      if (mapInstanceRef.current) {
        const camera = mapInstanceRef.current.getCamera?.();
        if (camera?.center && Number.isFinite(camera.zoom)) cameraRef.current = { center: camera.center, zoom: camera.zoom };
        mapInstanceRef.current.dispose();
        mapInstanceRef.current = null;
      }
      setMapReady(false);
    };
    // Intentionally excludes `events` and `allEvents` so filter toggles update markers without recreating the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, data?.azureMapsConfigured, data?.subscriptionKey, sdkLoaded, targetQuake, host]);

  // Synchronize user location pin on the active Azure Map
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map || !window.atlas) return;

    if (userMarkerRef.current) {
      if (typeof map.markers?.remove === "function") {
        try { map.markers.remove(userMarkerRef.current); } catch { /* ignore */ }
      }
      userMarkerRef.current?.htmlContent?.remove?.();
      userMarkerRef.current = null;
    }

    const userLoc = data?.userLocation ?? (userLatitude !== undefined && userLongitude !== undefined
      ? { latitude: userLatitude, longitude: userLongitude }
      : null);
    if (userLoc) {
      const userEl = document.createElement("div");
      userEl.className = "earthquake-map-user-marker";
      userEl.title = "Your location";
      userEl.innerHTML = `<div class="user-pulse"></div><div class="user-dot"></div>`;
      const userMarker = new window.atlas.HtmlMarker({
        position: [userLoc.longitude, userLoc.latitude],
        htmlContent: userEl,
      });
      map.markers.add(userMarker);
      userMarkerRef.current = userMarker;
    }
  }, [mapReady, data?.userLocation, userLatitude, userLongitude]);

  // Synchronize news & disaster markers whenever filtered pinGroups or selection changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!mapReady || !map || !window.atlas) return;

    if (markersRef.current.length > 0) {
      if (typeof map.markers?.remove === "function") {
        try { map.markers.remove(markersRef.current); } catch { /* ignore */ }
      } else if (typeof map.markers?.clear === "function") {
        try { map.markers.clear(); } catch { /* ignore */ }
      }
      for (const oldMarker of markersRef.current) {
        oldMarker?.htmlContent?.remove?.();
      }
      markersRef.current = [];
    }

    const added: unknown[] = [];
    for (const group of pinGroups) {
      const first = group.items[0];
      const isSelected = !!selectedEvent && group.items.some(item => item.id === selectedEvent.id);
      const markerEl = document.createElement("div");

      if (group.kind === "news") {
        markerEl.className = `earthquake-map-pin news-pin${group.items.length > 1 ? " multi" : ""}${isSelected ? " selected" : ""}`;
      } else {
        const isMajor = group.kind === "earthquake" && (first.kind === "earthquake" ? (first.magnitude ?? 0) >= 5.0 : false);
        markerEl.className = `earthquake-map-pin${isMajor ? " major" : ""}${isSelected ? " selected" : ""}`;
      }

      markerEl.style.setProperty("--pin-color", eventColor(first));
      markerEl.innerHTML = `<span class="pin-mag">${group.label}</span><span class="pin-wave"></span>`;
      markerEl.title = group.title;
      markerEl.tabIndex = 0;
      markerEl.setAttribute("role", "button");
      markerEl.setAttribute("aria-label", group.title);

      const marker = new window.atlas.HtmlMarker({
        position: [group.longitude, group.latitude],
        htmlContent: markerEl,
      });

      map.events.add("click", marker, () => selectPinGroupRef.current(group));
      markerEl.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectPinGroupRef.current(group);
        }
      });

      map.markers.add(marker);
      added.push(marker);
    }
    markersRef.current = added;
  }, [mapReady, pinGroups, selectedEvent?.id]);

  if (!isOpen || !host) return null;

  const allNewsCount = allEvents.filter(e => e.kind === "news").length;
  const visibleNewsCount = events.filter(e => e.kind === "news").length;
  const visibleDisasterCount = events.filter(e => e.kind !== "news").length;
  const isNewsOnly = kinds.length === 1 && kinds[0] === "news";

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
            <h2>News &amp; Disaster Map</h2>
            <div className="earthquake-map-status-badges">
              <span className="source-badge">
                {data
                  ? visibleNewsCount > 0 || newsData?.pendingCount
                    ? `${data.source} + GDACS · ${visibleDisasterCount} reports · ${visibleNewsCount} news${newsData?.pendingCount ? " · locating more…" : ""}`
                    : `${data.source} + GDACS · ${visibleDisasterCount} reports`
                  : "Loading reports…"}
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
          <div className="hazard-filters" role="group" aria-label="Map layers">
            {mapLayerKinds.map(kind => (
              <button
                key={kind}
                type="button"
                aria-pressed={kinds.includes(kind)}
                onClick={() => setKinds(current => current.includes(kind) ? current.filter(k => k !== kind) : [...current, kind])}
              >
                <span style={{ background: eventColor({ kind }) }} />
                {mapLayerLabels[kind]} ({allEvents.filter(e => e.kind === kind).length})
              </button>
            ))}
            {allNewsCount > 0 && (
              <button
                type="button"
                className="news-map-quick-toggle"
                aria-pressed={isNewsOnly}
                onClick={() => setKinds(isNewsOnly ? [...mapLayerKinds] : ["news"])}
              >
                {isNewsOnly ? "All layers" : "News only"}
              </button>
            )}
            {newsTopics.length > 1 && kinds.includes("news") && (
              <select
                className="news-map-topic-select"
                aria-label="Filter map news by topic"
                value={selectedNewsTopic}
                onChange={e => setSelectedNewsTopic(e.target.value)}
              >
                <option value="">All news topics</option>
                {newsTopics.map(topic => (
                  <option key={topic} value={topic}>{topic}</option>
                ))}
              </select>
            )}
          </div>
          <p>News pins show the main extracted location when a story names a clear place. GDACS global reports updated in the past week. Pins show reported locations, not affected boundaries or evacuation zones.</p>
          <p className="disaster-map-updated">{data ? `Checked ${new Date(data.checkedAtUtc).toLocaleString()}. Refreshes every minute.` : "Checking feeds…"}</p>
          {data?.warnings?.map(warning => <p role="alert" key={warning}>{warning}</p>)}
          {newsData?.warning && <p role="status">{newsData.warning}</p>}
        </div>

        {/* Main Workspace: Map Canvas + Details Drawer */}
        <div className="earthquake-map-body">
          <div className="earthquake-map-canvas-area">
            {loading && !data && (
              <div className="earthquake-map-loading" role="status">
                <div className="spinner" />
                <p>Loading news locations and disaster reports…</p>
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
                <p className="coordinate-overview-label">Global coordinate overview · select a pin for details</p>
                <div className="radar-canvas-wrap">
                  <svg viewBox="-240 -130 480 260" className="radar-grid" role="img" aria-label="Global news and disaster coordinates, north at top">
                    <rect x="-220" y="-110" width="440" height="220" className="radar-ring outer" />
                    {[-180, -90, 0, 90, 180].map(lon => <g key={lon}><line x1={lon / 180 * 220} y1="-110" x2={lon / 180 * 220} y2="110" className="radar-axis" /><text x={lon / 180 * 220} y="124" textAnchor="middle" className="radar-label">{lon}°</text></g>)}
                    {[-90, -45, 0, 45, 90].map(lat => <line key={lat} x1="-220" y1={-lat / 90 * 110} x2="220" y2={-lat / 90 * 110} className="radar-axis" />)}
                    <text x="-215" y="-115" className="radar-label">90°N</text><text x="-215" y="106" className="radar-label">90°S</text>
                    {/* Plotted news & disaster pins */}
                    {pinGroups.map(group => {
                      const first = group.items[0];
                      const { cx, cy } = overviewPosition(group.latitude, group.longitude);
                      const color = eventColor(first);
                      const isSelected = !!selectedEvent && group.items.some(item => item.id === selectedEvent.id);

                      return (
                        <g
                          key={group.key}
                          className={`radar-quake-group ${isSelected ? "selected" : ""}`}
                          onClick={() => selectPinGroup(group)}
                          cursor="pointer"
                          role="button"
                          tabIndex={0}
                          aria-label={group.title}
                          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectPinGroup(group); } }}
                        >
                          <circle cx={cx} cy={cy} r={isSelected ? 14 : 9} fill={color} opacity={0.85} />
                          {isSelected && (
                            <circle cx={cx} cy={cy} r={22} fill="none" stroke={color} strokeWidth="2" opacity={0.6}>
                              <animate attributeName="r" from="10" to="28" dur="1.5s" repeatCount="indefinite" />
                              <animate attributeName="opacity" from="0.8" to="0" dur="1.5s" repeatCount="indefinite" />
                            </circle>
                          )}
                          <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#ffffff">
                            {group.label}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}
          </div>

          {/* Active Detail Card */}
          {selectedEvent && selectedEvent.kind === "news" && (
            <aside className="earthquake-active-card news-active-card" aria-label="Selected news story details">
              <div className="card-mag" style={{ background: eventColor(selectedEvent) }}>
                <span>NEWS</span>
                <strong>{activeCluster.length > 1 ? `${activeClusterIndex + 1}/${activeCluster.length}` : "NW"}</strong>
              </div>
              <div className="card-info">
                <div className="news-card-badges">
                  <span className="news-card-location">📍 {selectedEvent.locationName}</span>
                  {selectedEvent.topics.slice(0, 3).map(topic => (
                    <span key={topic} className="news-card-topic">{topic}</span>
                  ))}
                </div>
                <h3>{selectedEvent.place}</h3>
                <div className="card-meta">
                  <span>{selectedEvent.source} · {new Date(selectedEvent.timeUtc).toLocaleString()}</span>
                  {selectedEvent.distanceKm != null && (
                    <span>{Math.round(selectedEvent.distanceKm).toLocaleString()} km away</span>
                  )}
                </div>
                {selectedEvent.description && <p className="disaster-description">{selectedEvent.description}</p>}
                {activeCluster.length > 1 && (
                  <div className="news-cluster-nav" aria-label="Stories at this location">
                    <button
                      type="button"
                      onClick={() => selectQuake(activeCluster[(activeClusterIndex - 1 + activeCluster.length) % activeCluster.length])}
                    >
                      ◀ Prev
                    </button>
                    <span>{activeClusterIndex + 1} of {activeCluster.length} in {selectedEvent.locationName}</span>
                    <button
                      type="button"
                      onClick={() => selectQuake(activeCluster[(activeClusterIndex + 1) % activeCluster.length])}
                    >
                      Next ▶
                    </button>
                  </div>
                )}
              </div>
              <div className="card-actions">
                {onOpenArticle && (
                  <button
                    type="button"
                    className="card-action-btn"
                    onClick={() => {
                      onOpenArticle(selectedEvent);
                      onClose();
                    }}
                  >
                    Read in Signal
                  </button>
                )}
                {selectedEvent.url && (
                  <a
                    className="card-link"
                    href={selectedEvent.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open original news article"
                  >
                    Open original ↗
                  </a>
                )}
              </div>
            </aside>
          )}

          {selectedEvent && selectedEvent.kind !== "news" && (
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

          {/* Bottom Drawer */}
          <footer className="earthquake-map-drawer" aria-label="Recent disaster reports">
            <div className="drawer-scroller">
              {events.length === 0 ? (
                <p className="no-events">No stories or reports match the selected layers and filters. Feed coverage varies by region.</p>
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
                          {quake.kind === "news"
                            ? `📍 ${quake.locationName} · ${quake.source}`
                            : `${mapLayerLabels[quake.kind]} · ${eventDetails(quake)}`}
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
