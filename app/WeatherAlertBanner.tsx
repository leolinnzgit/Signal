"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientWeatherAlert } from "./weather-briefing";
import "./weather-alerts.css";

export default function WeatherAlertBanner({
  alerts,
  onDismiss,
}: {
  alerts: ClientWeatherAlert[];
  onDismiss?: (id: string) => void;
}) {
  const [selectedAlert, setSelectedAlert] = useState<ClientWeatherAlert | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    const updateHost = () => setHost(document.fullscreenElement ?? document.body);
    updateHost();
    document.addEventListener("fullscreenchange", updateHost);
    return () => document.removeEventListener("fullscreenchange", updateHost);
  }, []);

  useEffect(() => {
    if (!selectedAlert) return;
    const el = dialogRef.current;
    if (!el) return;
    el.showModal();
    return () => {
      if (el.open) el.close();
    };
  }, [selectedAlert, host]);

  if (!alerts || alerts.length === 0) return null;

  const topAlert = alerts[0];
  const severityClass = topAlert.level.toLowerCase().includes("warning") ? "severe" : "watch";

  return (
    <>
      <section className={`weather-alert-banner ${severityClass}`} aria-label="Severe weather alert">
        <div className="weather-alert-banner-inner">
          <div className="weather-alert-badge">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="weather-alert-icon">
              <path d="M12 2L1 21h22L12 2zm0 3.8L20.2 19H3.8L12 5.8zM11 10v4h2v-4h-2zm0 6v2h2v-2h-2z" fill="currentColor" />
            </svg>
            <span>{topAlert.level.toUpperCase()}</span>
          </div>
          <div className="weather-alert-summary">
            <strong>{topAlert.headline}</strong>
            {topAlert.areaName && <span className="weather-alert-area"> · {topAlert.areaName}</span>}
          </div>
          <div className="weather-alert-actions">
            <button
              type="button"
              className="weather-alert-btn"
              onClick={() => setSelectedAlert(topAlert)}
            >
              Details
            </button>
            {onDismiss && (
              <button
                type="button"
                className="weather-alert-dismiss"
                onClick={() => onDismiss(topAlert.id)}
                aria-label="Dismiss alert banner"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Details Modal */}
      {selectedAlert && host &&
        createPortal(
          <dialog
            ref={dialogRef}
            className="weather-alert-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weather-alert-modal-title"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setSelectedAlert(null);
              }
            }}
            onCancel={(e) => {
              e.preventDefault();
              setSelectedAlert(null);
            }}
          >
            <div className="weather-alert-modal-content">
              <header className="weather-alert-modal-header">
                <span className={`modal-level-badge ${severityClass}`}>{selectedAlert.level}</span>
                <h2 id="weather-alert-modal-title">{selectedAlert.headline}</h2>
                <p className="modal-source">Issued by {selectedAlert.source}</p>
              </header>

              <div className="weather-alert-modal-body">
                {selectedAlert.areaName && (
                  <p>
                    <strong>Affected Area:</strong> {selectedAlert.areaName}
                  </p>
                )}
                {selectedAlert.effectiveTime && (
                  <p>
                    <strong>Effective:</strong> {new Date(selectedAlert.effectiveTime).toLocaleString()}
                  </p>
                )}
                {selectedAlert.expires && (
                  <p>
                    <strong>Expires:</strong> {new Date(selectedAlert.expires).toLocaleString()}
                  </p>
                )}
                {selectedAlert.description && (
                  <div className="modal-description">
                    <strong>Details & Safety Instructions:</strong>
                    <p>{selectedAlert.description}</p>
                  </div>
                )}
              </div>

              <footer className="weather-alert-modal-footer">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setSelectedAlert(null)}
                >
                  Close
                </button>
              </footer>
            </div>
          </dialog>,
          host
        )}
    </>
  );
}
