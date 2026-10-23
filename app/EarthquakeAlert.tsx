"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MapEvent } from "./disaster-map";
import { disasterLabels } from "./disaster-alerts";

export type EarthquakeReport = {
  id: string;
  source: string;
  magnitude: number;
  place: string;
  timeUtc: string;
  distanceKm: number;
  depthKm: number;
  url: string;
  latitude?: number;
  longitude?: number;
};

export default function EarthquakeAlert({
  quake,
  remaining = 0,
  preview,
  audioStatus,
  onRead,
  onStop,
  onDismiss,
  onOpenMap,
}: {
  quake: EarthquakeReport | MapEvent;
  remaining?: number;
  preview: boolean;
  audioStatus: string;
  onRead: () => void;
  onStop: () => void;
  onDismiss: () => void;
  onOpenMap?: () => void;
}) {
  const kind = "kind" in quake ? quake.kind : "earthquake";
  const label = disasterLabels[kind];
  const seismic = kind === "earthquake";
  const dialog = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    const followFullscreen = () => setHost(document.fullscreenElement ?? document.body);
    followFullscreen();
    document.addEventListener("fullscreenchange", followFullscreen);
    return () => document.removeEventListener("fullscreenchange", followFullscreen);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      if (element.open) element.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [host]);

  if (!host) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="earthquake-alert"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="earthquake-alert-title"
      aria-describedby="earthquake-alert-magnitude earthquake-alert-place earthquake-alert-facts"
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <div className="earthquake-alert-content">
        <header className="earthquake-alert-heading">
          <svg viewBox="0 0 48 48" aria-hidden="true">
            <path d="M24 5 45 42H3Z" />
            <path d="M24 17v12" />
            <circle cx="24" cy="35" r="1" />
          </svg>
          <p>{preview ? "Preview only · no disaster detected" : `Nearby ${label.toLowerCase()} report`}</p>
          <h2 id="earthquake-alert-title">{preview ? `Test ${label.toLowerCase()} alert` : seismic ? "Earthquake detected" : `${label} reported`}</h2>
        </header>
        <div className={`earthquake-alert-magnitude ${seismic ? "" : "disaster-alert-level"}`} id="earthquake-alert-magnitude">
          <span>{seismic ? "Magnitude" : "GDACS alert level"}</span>
          <strong>{seismic ? (quake.magnitude ?? 0).toFixed(1) : ("alertLevel" in quake ? quake.alertLevel : "unknown")?.toUpperCase()}</strong>
        </div>
        <p className="earthquake-alert-place" id="earthquake-alert-place">
          {quake.place}
        </p>
        <dl className="earthquake-alert-facts" id="earthquake-alert-facts">
          <div>
            <dt>From your phone</dt>
            <dd>
              {quake.distanceKm == null ? "Unknown" : Math.round(quake.distanceKm)} <span>km</span>
            </dd>
          </div>
          {seismic && <div>
            <dt>Depth</dt>
            <dd>
              {Math.round(quake.depthKm ?? 0)} <span>km</span>
            </dd>
          </div>}
        </dl>
        {"description" in quake && quake.description && <p className="disaster-alert-description">{quake.description}</p>}
        {"updatedAtUtc" in quake && typeof quake.updatedAtUtc === "string" && !seismic && <p className="earthquake-alert-source">Report updated {new Date(quake.updatedAtUtc).toLocaleString()}</p>}
        {!seismic && !preview && <p className="earthquake-alert-source">Distance is to the reported location. Follow local authorities for instructions.</p>}
        {remaining > 0 && <p role="status">{remaining} more {remaining === 1 ? "alert" : "alerts"} waiting. Dismiss to view the next report.</p>}
        <p className="earthquake-alert-source">
          {preview ? "Example report" : `Reported by ${quake.source}`} ·{" "}
          <time dateTime={quake.timeUtc}>{new Date(quake.timeUtc).toLocaleString()}</time>
        </p>
        {quake.url && (
          <a className="earthquake-alert-report" href={quake.url} target="_blank" rel="noopener noreferrer">
            View {quake.source} report ↗
          </a>
        )}
        <p className="earthquake-alert-audio" role="status">
          {audioStatus}
        </p>
        <div className="earthquake-alert-actions" role="group" aria-label={`${label} alert actions`}>
          <button type="button" className="earthquake-alert-dismiss" autoFocus onClick={onDismiss}>
            Dismiss alert
          </button>
          {onOpenMap && (
            <button type="button" onClick={onOpenMap}>
              View on map
            </button>
          )}
          <button type="button" onClick={onRead}>
            Read alert
          </button>
          <button type="button" onClick={onStop}>
            Stop voice
          </button>
        </div>
      </div>
    </dialog>,
    host,
  );
}
