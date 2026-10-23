"use client";

import { useEffect, useRef, useState } from "react";
import { useEarthquakeAudio } from "./EarthquakeAudio";
import EarthquakeAlert, { type EarthquakeReport } from "./EarthquakeAlert";
import EarthquakeMap from "./EarthquakeMap";
import { hazardKinds, hazardLabels } from "./disaster-map";
import { normalizeDisasterSettings, normalizeDisasterNotification, defaultDisasterSettings, disasterAnnouncement, appendDisasterAlerts, matchesDisasterSettings, previewDisaster, type DisasterSettings, type DisasterNotification } from "./disaster-alerts";
import "./earthquake-alerts.css";

type Settings = DisasterSettings;
type Quake = EarthquakeReport;
const defaults = defaultDisasterSettings;

export function earthquakeAnnouncement(e: Quake) {
  return `Earthquake reported by ${e.source}. Magnitude ${e.magnitude.toFixed(1)}, ${e.place}. About ${Math.round(e.distanceKm)} kilometres from your phone location, at a depth of ${Math.round(e.depthKm)} kilometres.`;
}

async function request<T>(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") {
    const csrf = await fetch("/api/auth/csrf", { credentials: "same-origin", cache: "no-store", signal });
    if (!csrf.ok) throw new Error("Refresh Signal to restore your secure session.");
    headers["X-XSRF-TOKEN"] = (await csrf.json()).token;
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, { method, headers, credentials: "same-origin", cache: "no-store", signal,
    ...(body ? { body: JSON.stringify(body) } : {}) });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not check disaster reports. Retrying in one minute.");
  return data as T;
}

export function useEarthquakeAlerts(account: string, available: boolean) {
  const storageKey = `signal.earthquakes.v1:${account}`;
  const [settings, setSettings] = useState(defaults);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Disaster alerts are off on this device.");
  const [queue, setQueue] = useState<DisasterNotification[]>([]);
  const eligibleQueue = queue.filter(event => matchesDisasterSettings(event, settings));
  const latest = eligibleQueue[0] ?? null;
  const announced = useRef(new Set<string>());
  const [preview, setPreview] = useState<DisasterNotification | null>(null);
  const [previewKind, setPreviewKind] = useState<DisasterNotification["kind"]>("earthquake");
  const [showMap, setShowMap] = useState(false);
  const [mapTargetQuake, setMapTargetQuake] = useState<DisasterNotification | null>(null);
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number; radiusKm?: number } | null>(null);
  const { audioStatus, speak, stop } = useEarthquakeAudio();
  const [retry, setRetry] = useState(0);
  const current = useRef(settings);
  useEffect(() => { current.current = settings; }, [settings]);
  const seen = useRef(new Set<string>());
  const monitorRequest = useRef<AbortController | null>(null);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    const handleHash = () => {
      if (["#earthquake-map", "#disaster-map"].includes(window.location.hash)) {
        setShowMap(true);
      }
    };
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const storedSeen = JSON.parse(localStorage.getItem(`${storageKey}:seen`) || "[]");
      seen.current = new Set(Array.isArray(storedSeen) ? storedSeen.filter(id => typeof id === "string").slice(-2000) : []);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrate this device's persisted settings after server rendering.
      setSettings(normalizeDisasterSettings(saved, crypto.randomUUID()));
      setQueue([]);
      setPreview(null);
      announced.current.clear();
    } catch { setSettings({ ...defaults, deviceId: crypto.randomUUID() }); }
    setReady(true);
    return stop;
  }, [storageKey, stop]);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); }
    catch { /* Monitoring can continue for the current session. */ }
  }, [settings, ready, storageKey]);

  useEffect(() => {
    if (!ready || !available || !settings.enabled) return;
    const abort = new AbortController();
    monitorRequest.current = abort;
    let busy = false;
    const path = `/api/disasters/devices/${settings.deviceId}`;
    const check = async () => {
      if (busy || abort.signal.aborted || document.visibilityState === "hidden") return;
      busy = true;
      try {
        if (!window.isSecureContext || !navigator.geolocation) throw new Error("Disaster alerts need HTTPS and a browser with location access.");
        setStatus("Updating phone location and checking disaster reports…");
        const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
          { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 }));
        if (abort.signal.aborted) return;
        setUserCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude, radiusKm: settings.radiusKm });
        let pushEndpoint = "";
        if ("serviceWorker" in navigator) {
          try {
            const registration = await navigator.serviceWorker.getRegistration();
            pushEndpoint = (await registration?.pushManager?.getSubscription())?.endpoint || "";
          } catch { /* Optional push support must not prevent open-app alerts. */ }
        }
        const saved = await request<{ backgroundPush: boolean }>(path, "PUT", {
          latitude: position.coords.latitude, longitude: position.coords.longitude,
          radiusKm: settings.radiusKm, minimumMagnitude: settings.minimumMagnitude, pushEndpoint,
          hazardKinds: settings.hazardKinds, minimumAlertLevel: settings.minimumAlertLevel,
        }, abort.signal);
        const result = await request<{ events: DisasterNotification[]; checkedAtUtc: string; source: string; warnings?: string[] }>(path, "GET", null, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(`${(result.warnings ?? []).join(" ")} ${result.source} checked at ${new Date(result.checkedAtUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Phone location refreshed. ${saved.backgroundPush ? "Background phone notifications linked." : "Enable Phone notifications above for alerts while closed."}`);
        try {
          const savedSeen: unknown = JSON.parse(localStorage.getItem(`${storageKey}:seen`) || "[]");
          if (Array.isArray(savedSeen)) savedSeen.filter(id => typeof id === "string").forEach(id => seen.current.add(id));
        } catch { /* Use the session's seen IDs. */ }
        setQueue(previous => appendDisasterAlerts(previous.filter(event => matchesDisasterSettings(event, current.current)),
          result.events.map(normalizeDisasterNotification).filter(event => matchesDisasterSettings(event, current.current)), seen.current, current.current.hazardKinds));
      } catch (error) {
        if (abort.signal.aborted) return;
        const locationError = error as GeolocationPositionError;
        setStatus(locationError.code === 1 ? "Location blocked. Allow location access in your phone's site settings, then tap Check now."
          : locationError.code === 2 || locationError.code === 3 ? "Phone location unavailable. Check GPS and tap Check now. Retrying in one minute."
          : error instanceof Error ? error.message : "Disaster check unavailable. Retrying in one minute.");
      } finally { busy = false; }
    };
    void check();
    const interval = setInterval(() => void check(), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { abort.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [ready, available, settings.enabled, settings.deviceId, settings.radiusKm, settings.minimumMagnitude, settings.hazardKinds, settings.minimumAlertLevel, retry, storageKey, speak]);

  const turnOff = async () => {
    // Keep the registration until removal succeeds so a failed request can be retried.
    setStatus("Turning off disaster monitoring…");
    setDisabling(true);
    monitorRequest.current?.abort();
    try {
      await request(`/api/disasters/devices/${settings.deviceId}`, "DELETE", null);
      setSettings(value => ({ ...value, enabled: false }));
      setQueue([]);
      setPreview(null);
      stop();
      setStatus("Disaster alerts are off on this device. Its saved location was removed.");
    } catch {
      setStatus("Could not turn off background alerts. Check your connection and try Turn off again.");
    } finally { setDisabling(false); }
  };

  useEffect(() => {
    if (!latest || !settings.enabled || !available || preview) return;
    seen.current.add(latest.notificationKey);
    seen.current = new Set([...seen.current].slice(-2000));
    try { localStorage.setItem(`${storageKey}:seen`, JSON.stringify([...seen.current])); } catch { /* Session deduplication remains available. */ }
    if (!announced.current.has(latest.notificationKey)) {
      announced.current.add(latest.notificationKey);
      if (settings.voice) speak(disasterAnnouncement(latest));
    }
  }, [latest, settings.enabled, settings.voice, available, storageKey, speak, preview]);

  const alert = preview ?? (settings.enabled && available ? latest : null);
  const previewAnnouncement = "This is a test of the full-screen disaster alert. No disaster has been detected.";
  return {
    banner: alert ? <EarthquakeAlert key={alert.notificationKey} remaining={preview ? 0 : Math.max(0, eligibleQueue.length - 1)} quake={alert} preview={!!preview} audioStatus={audioStatus}
      onRead={() => speak(preview ? previewAnnouncement : disasterAnnouncement(alert))} onStop={stop}
      onDismiss={() => { stop(); if (preview) setPreview(null); else setQueue(previous => previous.filter(event => event.notificationKey !== alert.notificationKey)); }}
      onOpenMap={() => { setMapTargetQuake(alert); setShowMap(true); }} /> : null,
    controls: available ? <section className="earthquake-settings" id="earthquake-alerts" aria-label="Disaster alerts">
      <h3 id="disaster-alerts">Disaster alerts</h3>
      <p>Nearby earthquakes, floods, tropical cyclones, wildfires, volcanic activity, and droughts from GeoNet, USGS, and GDACS. Uses this phone’s current location, separately from your weather location.</p>
      <fieldset className="disaster-alert-types"><legend>Alert me about</legend>
        {hazardKinds.map(kind => <label key={kind}><input type="checkbox" checked={settings.hazardKinds.includes(kind)}
          disabled={settings.hazardKinds.length === 1 && settings.hazardKinds.includes(kind)} onChange={event => {
            const kinds = event.target.checked ? [...settings.hazardKinds, kind] : settings.hazardKinds.filter(k => k !== kind);
            setSettings(value => ({ ...value, hazardKinds: kinds }));
            setQueue(previous => previous.filter(e => kinds.includes(e.kind)));
          }} />{hazardLabels[kind]}</label>)}
      </fieldset>
      <div className="earthquake-options">
        <label>Within <select aria-label="Disaster distance" value={settings.radiusKm} onChange={e => setSettings(s => ({ ...s, radiusKm: Number(e.target.value) }))}>
          {[50, 100, 300, 500, 1000].map(km => <option key={km} value={km}>{km} km</option>)}</select></label>
        <label>Earthquake magnitude <select aria-label="Minimum earthquake magnitude" value={settings.minimumMagnitude} onChange={e => setSettings(s => ({ ...s, minimumMagnitude: Number(e.target.value) }))}>
          {[2, 3, 4, 5, 6, 7].map(m => <option key={m} value={m}>{m}.0+</option>)}</select></label>
        <label>GDACS alert level <select aria-label="Minimum disaster alert level" value={settings.minimumAlertLevel}
          onChange={e => setSettings(value => ({ ...value, minimumAlertLevel: e.target.value as Settings["minimumAlertLevel"] }))}>
          <option value="green">All levels (green+)</option><option value="orange">Orange and red</option><option value="red">Red only</option>
        </select></label>
        <label><input type="checkbox" checked={settings.voice} onChange={e => { setSettings(s => ({ ...s, voice: e.target.checked })); if (!e.target.checked) stop(); }} />Azure voice notification</label>
      </div>
      <div className="earthquake-actions">
        <button type="button" disabled={!ready || disabling} onClick={() => {
          if (settings.enabled) void turnOff();
          else { setSettings(s => ({ ...s, enabled: true })); if (settings.voice) speak("Test notification. Disaster voice alerts are ready while Signal is open."); }
        }}>{settings.enabled ? "Turn off disaster alerts" : "Enable disaster alerts"}</button>
        <button type="button" onClick={() => { setMapTargetQuake(null); setShowMap(true); }}>View disaster map</button>
        <button type="button" onClick={() => speak("Test notification. A nearby disaster has been reported. This is a voice test only.")}>Test voice</button>
        <button type="button" onClick={stop}>Stop voice</button>
        <label className="disaster-preview-kind">Preview type <select aria-label="Preview disaster type" value={previewKind}
          onChange={event => setPreviewKind(event.target.value as DisasterNotification["kind"])}>{hazardKinds.map(kind => <option key={kind} value={kind}>{hazardLabels[kind]}</option>)}</select></label>
        <button type="button" onClick={() => {
          setPreview(previewDisaster(previewKind));
          if (settings.voice) speak(previewAnnouncement);
        }}>Preview full-screen alert</button>
        {settings.enabled && <button type="button" onClick={() => setRetry(r => r + 1)}>Check now</button>}
      </div>
      <p role="status">{status}</p>
      <small>Uses Azure’s neural voice with your saved English reading voice, or the default voice.</small>
      {!alert && audioStatus && <p role="status">{audioStatus}</p>}
      <small>Checks every minute. Earthquakes must be new within 15 minutes; other disasters must have a GDACS report updated within 24 hours. A new episode or changed alert level can alert again. GDACS data is cached for six minutes. Distance is to the reported point, not the affected boundary. Azure voice needs Signal open and may require a tap. Closed-app pushes use your phone’s normal notification sound and your last known location for up to 24 hours; reopen Signal to refresh it. Location is removed when disabled and expires from storage after seven days. Reports can be delayed or revised. Coverage is incomplete. Follow local authorities for instructions; this is not an early-warning or evacuation service.</small>
    </section> : null,
    map: <EarthquakeMap
      isOpen={showMap}
      onClose={() => {
        setShowMap(false);
        setMapTargetQuake(null);
        if (["#earthquake-map", "#disaster-map"].includes(window.location.hash)) {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      }}
      targetQuake={mapTargetQuake}
      userCoordinates={userCoords}
    />,
  };
}
