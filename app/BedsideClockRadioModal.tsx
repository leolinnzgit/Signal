"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { describeWeather } from "./weather-briefing";
import type { DailyBriefingData } from "./daily-briefing";
import {
  playHarmonicChime,
  formatClockDisplay,
  shouldAlarmTrigger,
  calculateTimeUntilAlarm,
  checkBedsideBriefingAudioCache,
  prewarmBedsideBriefingAudio,
  type BedsideBriefingCacheState,
} from "./bedside-clock";
import "./bedside-clock.css";

export { playHarmonicChime } from "./bedside-clock";

export interface BedsideClockWeather {
  temperature: number;
  condition?: string;
  location?: string;
  locationName?: string;
  weatherCode?: number;
}

export interface BedsideClockRadioModalProps {
  isOpen: boolean;
  onClose: () => void;
  weather?: BedsideClockWeather | null;
  alarmTime?: string;
  alarmEnabled?: boolean;
  onChangeAlarmTime?: (time: string) => void;
  onToggleAlarm?: (enabled: boolean) => void;
  onTriggerBriefing: () => void;
  briefingTitle?: string;
  briefingData?: DailyBriefingData | null;
  briefingLanguage?: string;
}

export default function BedsideClockRadioModal({
  isOpen,
  onClose,
  weather,
  alarmTime = "07:00",
  alarmEnabled = true,
  onChangeAlarmTime,
  onToggleAlarm,
  onTriggerBriefing,
  briefingTitle = "Signal Executive Briefing",
  briefingData,
  briefingLanguage = "en-NZ",
}: BedsideClockRadioModalProps) {
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [localAlarmTime, setLocalAlarmTime] = useState<string>(alarmTime);
  const [isAlarmEnabled, setIsAlarmEnabled] = useState<boolean>(alarmEnabled);
  const [nightMode, setNightMode] = useState<boolean>(false);
  const [isRinging, setIsRinging] = useState<boolean>(false);
  const [showSeconds, setShowSeconds] = useState<boolean>(false);
  const [cacheState, setCacheState] = useState<BedsideBriefingCacheState>({
    ready: false,
    status: "idle",
    audioBytes: 0,
  });
  const chimeIntervalRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setLocalAlarmTime(alarmTime);
  }, [alarmTime]);

  useEffect(() => {
    setIsAlarmEnabled(alarmEnabled);
  }, [alarmEnabled]);

  useEffect(() => {
    if (!isOpen || !briefingData) return;
    const abort = new AbortController();

    void checkBedsideBriefingAudioCache(briefingData, briefingLanguage).then((res) => {
      setCacheState(res);
      if (!res.ready && !abort.signal.aborted) {
        setCacheState((prev) => ({ ...prev, status: "caching" }));
        void prewarmBedsideBriefingAudio(briefingData, briefingLanguage, { signal: abort.signal }).then((pRes) => {
          if (!abort.signal.aborted) {
            setCacheState(pRes);
          }
        });
      }
    });

    return () => abort.abort();
  }, [briefingData, briefingLanguage, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setInterval(() => {
      const now = new Date();
      setCurrentTime(now);

      // Check alarm trigger matching HH:MM
      const display = formatClockDisplay(now);

      if (shouldAlarmTrigger(display.timeString24, now.getSeconds(), localAlarmTime, isRinging, isAlarmEnabled)) {
        setIsRinging(true);
        playHarmonicChime(audioCtxRef.current);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [localAlarmTime, isAlarmEnabled, isOpen, isRinging]);

  // Repeated gentle chimes every 8s if ringing
  useEffect(() => {
    if (isRinging) {
      chimeIntervalRef.current = window.setInterval(() => {
        playHarmonicChime(audioCtxRef.current);
      }, 8000);
    } else if (chimeIntervalRef.current) {
      window.clearInterval(chimeIntervalRef.current);
      chimeIntervalRef.current = null;
    }
    return () => {
      if (chimeIntervalRef.current) {
        window.clearInterval(chimeIntervalRef.current);
        chimeIntervalRef.current = null;
      }
    };
  }, [isRinging]);

  const handleWakeWithBriefing = useCallback(() => {
    setIsRinging(false);
    onClose();
    onTriggerBriefing();
  }, [onClose, onTriggerBriefing]);

  const handleSnooze = useCallback(() => {
    setIsRinging(false);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        window.setTimeout(() => {
          new Notification("⏰ Wake-Up Snooze Complete", {
            body: "Your 10-minute briefing snooze has elapsed. Tap to listen to your morning briefing.",
            icon: "/icons/signal-medallion-192.png",
          });
        }, 10 * 60 * 1000);
      } catch {}
    }
  }, []);

  if (!isOpen) return null;

  const display = formatClockDisplay(currentTime);
  const { hours24, minutes, seconds, hour12, ampm, dateFormatted } = display;

  return (
    <div
      className={`bedside-clock-overlay ${nightMode ? "night-mode" : ""} ${isRinging ? "is-ringing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Bedside Clock Radio"
    >
      <div className="bedside-clock-container">
        {/* Top Status Bar */}
        <header className="bedside-clock-header">
          <div className={`clock-alarm-pill ${isAlarmEnabled ? "alarm-on" : "alarm-off"}`}>
            <button
              type="button"
              className="clock-alarm-toggle-btn"
              onClick={() => {
                const next = !isAlarmEnabled;
                setIsAlarmEnabled(next);
                onToggleAlarm?.(next);
              }}
              title={isAlarmEnabled ? "Alarm is ON. Click to turn OFF" : "Alarm is OFF. Click to turn ON"}
              aria-pressed={isAlarmEnabled}
            >
              <span className="alarm-icon" aria-hidden="true">⏰</span>
              <span className="alarm-status-label">{isAlarmEnabled ? "Alarm ON" : "Alarm OFF"}</span>
            </button>
            <div className="clock-alarm-time-wrap">
              <input
                type="time"
                className="clock-alarm-time-input"
                value={localAlarmTime}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val) {
                    setLocalAlarmTime(val);
                    onChangeAlarmTime?.(val);
                  }
                }}
                aria-label="Wake-up alarm time"
                title="Edit wake-up alarm time"
              />
            </div>
            <span className="clock-alarm-countdown" title="Time until wake-up alarm">
              {isAlarmEnabled ? calculateTimeUntilAlarm(localAlarmTime, currentTime).formatted : "Disabled"}
            </span>
          </div>

          {cacheState.ready && (
            <div className="clock-cache-badge ready" title={cacheState.message}>
              ⚡ Briefing Cached (Offline)
            </div>
          )}

          {cacheState.status === "caching" && (
            <div className="clock-cache-badge caching" title="Pre-caching morning neural briefing audio...">
              ⏳ Caching Audio...
            </div>
          )}

          <div className="clock-actions-top">
            <button
              type="button"
              className="clock-toggle-btn"
              onClick={() => setNightMode((prev) => !prev)}
              title="Toggle OLED Night / Amber Mode"
            >
              {nightMode ? "☀️ Standard Glow" : "🌙 OLED Amber Mode"}
            </button>
            <button
              type="button"
              className="clock-close-btn"
              onClick={onClose}
              aria-label="Close Clock Radio"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Central Ambient Time Display */}
        <main className="bedside-clock-center">
          {isRinging && (
            <div className="clock-ringing-banner" role="alert">
              🔔 Time to Wake Up! Executive Briefing is Ready
            </div>
          )}

          <div className="clock-purpose-tag" aria-hidden="true">
            <span>Bedside Clock Radio</span>
            <span className="dot-sep">&bull;</span>
            <span>Wake-Up Alarm &amp; Briefing</span>
          </div>

          <div
            className="clock-digital-time"
            onClick={() => setShowSeconds((prev) => !prev)}
            title="Click to toggle seconds"
          >
            <span className="digits-hour">{String(hour12).padStart(2, "0")}</span>
            <span className="digits-colon">:</span>
            <span className="digits-minute">{minutes}</span>
            {showSeconds && (
              <span className="digits-seconds">:{seconds}</span>
            )}
            <span className="digits-ampm">{ampm}</span>
          </div>

          <p className="clock-date-line">{dateFormatted}</p>

          {/* Weather Glance */}
          {weather && (
            <div className="clock-weather-glance">
              <span className="weather-temp">{weather.temperature}&deg;C</span>
              {(weather.condition || (weather.weatherCode !== undefined ? describeWeather(weather.weatherCode) : null)) && (
                <span className="weather-desc">&bull; {weather.condition || describeWeather(weather.weatherCode!)}</span>
              )}
              {(weather.location || weather.locationName) && (
                <span className="weather-loc">&bull; {weather.location || weather.locationName}</span>
              )}
            </div>
          )}
        </main>

        {/* Bottom Radio & Briefing Controls */}
        <footer className="bedside-clock-footer">
          <button
            type="button"
            className="clock-primary-btn briefing-play-btn"
            onClick={handleWakeWithBriefing}
            title="Start your executive voice briefing"
          >
            🔊 Wake &amp; Play Briefing
          </button>

          <button
            type="button"
            className="clock-secondary-btn snooze-btn"
            onClick={handleSnooze}
            title="Snooze alarm for 10 minutes"
          >
            💤 Snooze 10m
          </button>

          <button
            type="button"
            className="clock-secondary-btn test-alarm-btn"
            onClick={() => {
              setIsRinging(true);
              playHarmonicChime(audioCtxRef.current);
            }}
            title="Test the wake-up alarm ring and harmonic chime experience"
          >
            🔔 Test Alarm
          </button>

          {isRinging && (
            <button
              type="button"
              className="clock-stop-alarm-btn"
              onClick={() => setIsRinging(false)}
              title="Stop alarm ringing"
            >
              ⏹️ Stop Ringing
            </button>
          )}

          <button
            type="button"
            className="clock-tertiary-btn test-chime-btn"
            onClick={() => playHarmonicChime(audioCtxRef.current)}
            title="Preview the gentle harmonic chime sound"
          >
            🎵 Preview Chime
          </button>
        </footer>
      </div>
    </div>
  );
}
