"use client";

import { useEffect, useRef, useState } from "react";
import { useEarthquakeAudio } from "./EarthquakeAudio";
import EarthquakeAlert, { type EarthquakeReport } from "./EarthquakeAlert";
import "./earthquake-alerts.css";

type Settings = { enabled: boolean; voice: boolean; radiusKm: number; minimumMagnitude: number; deviceId: string };
type Quake = EarthquakeReport;
const defaults: Settings = { enabled: false, voice: true, radiusKm: 300, minimumMagnitude: 4, deviceId: "" };

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
  if (!response.ok) throw new Error(data.error || "Could not check earthquakes. Retrying in one minute.");
  return data as T;
}

export function useEarthquakeAlerts(account: string, available: boolean) {
  const storageKey = `signal.earthquakes.v1:${account}`;
  const [settings, setSettings] = useState(defaults);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Earthquake alerts are off on this device.");
  const [latest, setLatest] = useState<Quake | null>(null);
  const [preview, setPreview] = useState<Quake | null>(null);
  const { audioStatus, speak, stop } = useEarthquakeAudio();
  const [retry, setRetry] = useState(0);
  const current = useRef(settings);
  current.current = settings;
  const seen = useRef(new Set<string>());
  const monitorRequest = useRef<AbortController | null>(null);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const storedSeen = JSON.parse(localStorage.getItem(`${storageKey}:seen`) || "[]");
      seen.current = new Set(Array.isArray(storedSeen) ? storedSeen.filter(id => typeof id === "string").slice(-200) : []);
      setSettings({
        enabled: saved?.enabled === true, voice: saved?.voice !== false,
        radiusKm: [50, 100, 300, 500, 1000].includes(saved?.radiusKm) ? saved.radiusKm : 300,
        minimumMagnitude: [2, 3, 4, 5, 6, 7].includes(saved?.minimumMagnitude) ? saved.minimumMagnitude : 4,
        deviceId: typeof saved?.deviceId === "string" && /^[0-9a-f-]{36}$/i.test(saved.deviceId) ? saved.deviceId : crypto.randomUUID(),
      });
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
    const path = `/api/earthquakes/devices/${settings.deviceId}`;
    const check = async () => {
      if (busy || abort.signal.aborted || document.visibilityState === "hidden") return;
      busy = true;
      try {
        if (!window.isSecureContext || !navigator.geolocation) throw new Error("Earthquake alerts need HTTPS and a browser with location access.");
        setStatus("Updating phone location and checking earthquakes…");
        const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject,
          { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 }));
        if (abort.signal.aborted) return;
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
        }, abort.signal);
        const result = await request<{ events: Quake[]; checkedAtUtc: string; source: string }>(path, "GET", null, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(`${result.source} checked at ${new Date(result.checkedAtUtc).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Phone location refreshed. ${saved.backgroundPush ? "Background phone notifications linked." : "Enable Phone notifications above for alerts while closed."}`);
        try {
          const savedSeen: unknown = JSON.parse(localStorage.getItem(`${storageKey}:seen`) || "[]");
          if (Array.isArray(savedSeen)) savedSeen.filter(id => typeof id === "string").forEach(id => seen.current.add(id));
        } catch { /* Use the session's seen IDs. */ }
        const fresh = result.events.filter(e => !seen.current.has(e.id));
        fresh.forEach(e => seen.current.add(e.id));
        seen.current = new Set([...seen.current].slice(-200));
        try { localStorage.setItem(`${storageKey}:seen`, JSON.stringify([...seen.current])); } catch { /* Session deduplication still works. */ }
        if (fresh.length) {
          const quake = fresh[fresh.length - 1];
          setPreview(null);
          setLatest(quake);
          if (current.current.voice) speak(fresh.map(earthquakeAnnouncement).join(" "));
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const locationError = error as GeolocationPositionError;
        setStatus(locationError.code === 1 ? "Location blocked. Allow location access in your phone's site settings, then tap Check now."
          : locationError.code === 2 || locationError.code === 3 ? "Phone location unavailable. Check GPS and tap Check now. Retrying in one minute."
          : error instanceof Error ? error.message : "Earthquake check unavailable. Retrying in one minute.");
      } finally { busy = false; }
    };
    void check();
    const interval = setInterval(() => void check(), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { abort.abort(); clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [ready, available, settings.enabled, settings.deviceId, settings.radiusKm, settings.minimumMagnitude, retry, storageKey, speak]);

  const turnOff = async () => {
    // Keep the registration until removal succeeds so a failed request can be retried.
    setStatus("Turning off earthquake monitoring…");
    setDisabling(true);
    monitorRequest.current?.abort();
    try {
      await request(`/api/earthquakes/devices/${settings.deviceId}`, "DELETE", null);
      setSettings(value => ({ ...value, enabled: false }));
      setLatest(null);
      setPreview(null);
      stop();
      setStatus("Earthquake alerts are off on this device. Its saved location was removed.");
    } catch {
      setStatus("Could not turn off background alerts. Check your connection and try Turn off again.");
    } finally { setDisabling(false); }
  };

  const alert = preview ?? (settings.enabled ? latest : null);
  const previewAnnouncement = "This is a test of the full-screen earthquake alert. No earthquake has been detected.";
  return {
    banner: alert ? <EarthquakeAlert key={alert.id} quake={alert} preview={!!preview} audioStatus={audioStatus}
      onRead={() => speak(preview ? previewAnnouncement : earthquakeAnnouncement(alert))} onStop={stop}
      onDismiss={() => { stop(); setPreview(null); setLatest(null); }} /> : null,
    controls: available ? <section className="earthquake-settings" id="earthquake-alerts" aria-label="Earthquake alerts">
      <h3>Earthquake alerts</h3>
      <p>Nearby earthquakes from GeoNet in New Zealand and USGS elsewhere. Uses this phone’s current location, separately from your weather location.</p>
      <div className="earthquake-options">
        <label>Within <select aria-label="Earthquake distance" value={settings.radiusKm} onChange={e => setSettings(s => ({ ...s, radiusKm: Number(e.target.value) }))}>
          {[50, 100, 300, 500, 1000].map(km => <option key={km} value={km}>{km} km</option>)}</select></label>
        <label>Magnitude <select aria-label="Minimum earthquake magnitude" value={settings.minimumMagnitude} onChange={e => setSettings(s => ({ ...s, minimumMagnitude: Number(e.target.value) }))}>
          {[2, 3, 4, 5, 6, 7].map(m => <option key={m} value={m}>{m}.0+</option>)}</select></label>
        <label><input type="checkbox" checked={settings.voice} onChange={e => { setSettings(s => ({ ...s, voice: e.target.checked })); if (!e.target.checked) stop(); }} />Azure voice notification</label>
      </div>
      <div className="earthquake-actions">
        <button type="button" disabled={!ready || disabling} onClick={() => {
          if (settings.enabled) void turnOff();
          else { setSettings(s => ({ ...s, enabled: true })); if (settings.voice) speak("Test notification. Earthquake voice alerts are ready while Signal is open."); }
        }}>{settings.enabled ? "Turn off earthquake alerts" : "Enable earthquake alerts"}</button>
        <button type="button" onClick={() => speak("Test notification. A nearby earthquake has been reported. This is a voice test only.")}>Test voice</button>
        <button type="button" onClick={stop}>Stop voice</button>
        <button type="button" onClick={() => {
          setPreview({ id: "preview", source: "Preview", magnitude: 5, place: "Example location", timeUtc: new Date().toISOString(), distanceKm: 25, depthKm: 10, url: "" });
          if (settings.voice) speak(previewAnnouncement);
        }}>Preview full-screen alert</button>
        {settings.enabled && <button type="button" onClick={() => setRetry(r => r + 1)}>Check now</button>}
      </div>
      <p role="status">{status}</p>
      <small>Uses Azure’s neural voice with your saved English reading voice, or the default voice.</small>
      {!alert && audioStatus && <p role="status">{audioStatus}</p>}
      <small>Checks every minute for new events from the last 15 minutes. Azure voice needs Signal open and may require a tap. Closed-app pushes use your phone’s normal notification sound and your last known location for up to 24 hours; reopen Signal to refresh it. Location is removed when disabled and expires from storage after seven days. Reports can be delayed or revised. This is not an earthquake early-warning service.</small>
    </section> : null,
  };
}
