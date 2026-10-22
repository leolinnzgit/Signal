"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EarthquakeReport } from "./EarthquakeAlert";

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
  userLocation: { latitude: number; longitude: number; radiusKm: number } | null;
  checkedAtUtc: string;
};

function getMagnitudeColor(mag: number): string {
  if (mag >= 6.0) return "#ef4444"; // red-500
  if (mag >= 5.0) return "#f97316"; // orange-500
  if (mag >= 4.0) return "#eab308"; // yellow-500
  return "#06b6d4"; // cyan-500
}

export default function EarthquakeMap({
  isOpen,
  onClose,
  targetQuake,
  userCoordinates,
}: {
  isOpen: boolean;
  onClose: () => void;
  targetQuake?: EarthquakeReport | null;
  userCoordinates?: { latitude: number; longitude: number; radiusKm?: number } | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapInstanceRef = useRef<any>(null);
  const [data, setData] = useState<EarthquakeMapFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdkLoaded, setSdkLoaded] = useState(false);
  const [selectedSource, setSelectedSource] = useState<"auto" | "geonet" | "usgs">("auto");
  const [minMagnitude, setMinMagnitude] = useState<number>(0);
  const [activeQuake, setActiveQuake] = useState<EarthquakeReport | null>(null);
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
    if (!isOpen) return;
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
    };
    document.head.appendChild(script);
  }, [isOpen]);

  // Fetch earthquake feed and Azure Maps configuration
  useEffect(() => {
    if (!isOpen) return;
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
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then((res) => {
        if (!res.ok) throw new Error("Could not retrieve earthquake map data.");
        return res.json();
      })
      .then((feedData: EarthquakeMapFeedResponse) => {
        if (cancelled) return;
        setData(feedData);
        if (targetQuake) {
          setActiveQuake(targetQuake);
        } else if (feedData.events.length > 0) {
          setActiveQuake(feedData.events[0]);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Earthquake feed unavailable.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedSource, userCoordinates, targetQuake]);

  // Initialize or update Azure Map instance
  useEffect(() => {
    if (!isOpen || !data?.azureMapsConfigured || !data.subscriptionKey || !sdkLoaded || !window.atlas) {
      return;
    }
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
        center: defaultCenter,
        zoom: targetQuake ? 7 : 5,
        style: theme,
        view: "Auto",
      });

      mapInstanceRef.current = map;

      map.events.add("ready", () => {
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
        const userLoc = data.userLocation ?? userCoordinates;
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
        const filteredEvents = data.events.filter((e) => e.magnitude >= minMagnitude);
        filteredEvents.forEach((quake) => {
          if (quake.latitude === undefined || quake.longitude === undefined) return;
          const markerEl = document.createElement("div");
          markerEl.className = `earthquake-map-pin ${quake.magnitude >= 5.0 ? "major" : ""}`;
          markerEl.style.setProperty("--pin-color", getMagnitudeColor(quake.magnitude));
          markerEl.innerHTML = `<span class="pin-mag">${quake.magnitude.toFixed(1)}</span><span class="pin-wave"></span>`;
          markerEl.title = `M ${quake.magnitude.toFixed(1)} - ${quake.place}`;

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

          map.markers.add(marker);
        });
      });
    } catch {
      // Map failed to initialize; fallback to radar preview
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.dispose();
        mapInstanceRef.current = null;
      }
    };
  }, [isOpen, data, sdkLoaded, minMagnitude, targetQuake, userCoordinates]);

  // Pan to selected earthquake when activeQuake changes
  const selectQuake = (quake: EarthquakeReport) => {
    setActiveQuake(quake);
    if (mapInstanceRef.current && quake.latitude !== undefined && quake.longitude !== undefined) {
      mapInstanceRef.current.setCamera({
        center: [quake.longitude, quake.latitude],
        zoom: 7,
        type: "ease",
        duration: 500,
      });
    }
  };

  if (!isOpen || !host) return null;

  const events = (data?.events ?? []).filter((e) => e.magnitude >= minMagnitude);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="earthquake-map-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Earthquake map visualization"
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
            <h2>Earthquake Map Visualization</h2>
            <div className="earthquake-map-status-badges">
              <span className="source-badge">
                {data ? `${data.source} · ${events.length} reports` : "Loading reports…"}
              </span>
              {data?.azureMapsConfigured ? (
                <span className="azure-badge active" title="Azure Maps Gen2 active">
                  <span className="dot" /> Azure Maps
                </span>
              ) : (
                <span className="azure-badge standby" title="Configure Azure Maps key for live satellite/night maps">
                  Azure Maps (Free F0 Ready)
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
                onClick={() => setSelectedSource("auto")}
              >
                Auto (Local)
              </button>
              <button
                type="button"
                className={`filter-btn ${selectedSource === "geonet" ? "active" : ""}`}
                onClick={() => setSelectedSource("geonet")}
              >
                GeoNet (NZ)
              </button>
              <button
                type="button"
                className={`filter-btn ${selectedSource === "usgs" ? "active" : ""}`}
                onClick={() => setSelectedSource("usgs")}
              >
                USGS (Global)
              </button>
            </div>

            <div className="filter-group" role="group" aria-label="Magnitude filter">
              {[0, 3, 4, 5].map((mag) => (
                <button
                  key={mag}
                  type="button"
                  className={`filter-btn ${minMagnitude === mag ? "active" : ""}`}
                  onClick={() => setMinMagnitude(mag)}
                >
                  {mag === 0 ? "All" : `${mag}.0+`}
                </button>
              ))}
            </div>

            <button type="button" className="earthquake-map-close" onClick={onClose} aria-label="Close earthquake map">
              ✕
            </button>
          </div>
        </header>

        {/* Main Workspace: Map Canvas + Details Drawer */}
        <div className="earthquake-map-body">
          <div className="earthquake-map-canvas-area">
            {loading && !data && (
              <div className="earthquake-map-loading" role="status">
                <div className="spinner" />
                <p>Loading seismic feed and Azure Maps…</p>
              </div>
            )}

            {error && (
              <div className="earthquake-map-error" role="alert">
                <p>{error}</p>
                <button type="button" onClick={() => setSelectedSource(selectedSource)}>
                  Retry
                </button>
              </div>
            )}

            {/* Azure Maps Web SDK Container */}
            {data?.azureMapsConfigured ? (
              <div
                ref={mapContainerRef}
                className="earthquake-azure-map-container"
                aria-label="Interactive Azure Map"
              />
            ) : (
              /* Fallback SVG Radar Visualization when Azure Maps key is not configured */
              <div className="earthquake-radar-fallback">
                <div className="azure-setup-banner">
                  <div>
                    <strong>Azure Maps is in free-tier standby.</strong>
                    <p>
                      Run <code>Configure Signal Maps.cmd</code> in your Signal folder with your free Azure Maps key to
                      unlock high-resolution satellite, night, and terrain maps.
                    </p>
                  </div>
                </div>

                <div className="radar-canvas-wrap">
                  <svg viewBox="-250 -250 500 500" className="radar-grid" aria-hidden="true">
                    <circle cx="0" cy="0" r="220" className="radar-ring outer" />
                    <circle cx="0" cy="0" r="150" className="radar-ring mid" />
                    <circle cx="0" cy="0" r="80" className="radar-ring inner" />
                    <line x1="-240" y1="0" x2="240" y2="0" className="radar-axis" />
                    <line x1="0" y1="-240" x2="0" y2="240" className="radar-axis" />
                    <text x="5" y="-85" className="radar-label">
                      100 km
                    </text>
                    <text x="5" y="-155" className="radar-label">
                      300 km
                    </text>
                    <text x="5" y="-225" className="radar-label">
                      500 km
                    </text>

                    {/* User center point */}
                    <circle cx="0" cy="0" r="6" className="user-radar-point" />

                    {/* Plotted earthquakes */}
                    {events.map((e, index) => {
                      const dist = Math.min(e.distanceKm || 120, 500);
                      const angle = ((index * 67) % 360) * (Math.PI / 180);
                      const r = (dist / 500) * 220;
                      const cx = Math.sin(angle) * r;
                      const cy = -Math.cos(angle) * r;
                      const color = getMagnitudeColor(e.magnitude);
                      const isSelected = activeQuake?.id === e.id;

                      return (
                        <g
                          key={e.id}
                          className={`radar-quake-group ${isSelected ? "selected" : ""}`}
                          onClick={() => selectQuake(e)}
                          cursor="pointer"
                        >
                          <circle cx={cx} cy={cy} r={isSelected ? 14 : 9} fill={color} opacity={0.85} />
                          {isSelected && (
                            <circle cx={cx} cy={cy} r={22} fill="none" stroke={color} strokeWidth="2" opacity={0.6}>
                              <animate attributeName="r" from="10" to="28" dur="1.5s" repeatCount="indefinite" />
                              <animate attributeName="opacity" from="0.8" to="0" dur="1.5s" repeatCount="indefinite" />
                            </circle>
                          )}
                          <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fontWeight="bold" fill="#ffffff">
                            {e.magnitude.toFixed(1)}
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
          {activeQuake && (
            <aside className="earthquake-active-card" aria-label="Selected earthquake details">
              <div className="card-mag" style={{ background: getMagnitudeColor(activeQuake.magnitude) }}>
                <span>MAG</span>
                <strong>{activeQuake.magnitude.toFixed(1)}</strong>
              </div>
              <div className="card-info">
                <h3>{activeQuake.place}</h3>
                <div className="card-meta">
                  <span>
                    <strong>{Math.round(activeQuake.distanceKm)}</strong> km away
                  </span>
                  <span>
                    <strong>{Math.round(activeQuake.depthKm)}</strong> km depth
                  </span>
                  <span>
                    {activeQuake.source} · {new Date(activeQuake.timeUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
              {activeQuake.url && (
                <a
                  className="card-link"
                  href={activeQuake.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="View official seismic report"
                >
                  Full report ↗
                </a>
              )}
            </aside>
          )}

          {/* Recent Earthquakes List Drawer */}
          <footer className="earthquake-map-drawer" aria-label="Recent earthquake list">
            <div className="drawer-scroller">
              {events.length === 0 ? (
                <p className="no-events">No earthquakes matching magnitude {minMagnitude}.0+ in this feed.</p>
              ) : (
                events.map((quake) => {
                  const isSelected = activeQuake?.id === quake.id;
                  const color = getMagnitudeColor(quake.magnitude);
                  return (
                    <button
                      key={quake.id}
                      type="button"
                      className={`drawer-quake-item ${isSelected ? "selected" : ""}`}
                      onClick={() => selectQuake(quake)}
                    >
                      <span className="item-mag" style={{ borderColor: color, color }}>
                        {quake.magnitude.toFixed(1)}
                      </span>
                      <div className="item-details">
                        <span className="item-place">{quake.place}</span>
                        <span className="item-sub">
                          {Math.round(quake.distanceKm)} km · {Math.round(quake.depthKm)} km depth
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
