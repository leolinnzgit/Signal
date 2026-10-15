"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createHandGestureDetector, HAND_ACTION_LABELS, type HandAction, type HandFrame, type HandPoint, type HandTracking } from "./hand-gestures";
import { handGesturesBlocked, runHandGestureAction } from "./hand-gesture-actions";
import { createEyeGestureDetector, EYE_TRACKING_LABELS, type EyeFrame, type EyeTracking } from "./eye-gestures";
import "./hand-gestures.css";

const MODE_STORAGE_KEY = "signal-gesture-mode";

// Pinching is limited to reading/navigation controls. Account, sharing, delete,
// and other unrelated actions are deliberately outside the hand pointer.
const SELECTABLE = [
  ".story-link", ".open-story-button", ".listen-story-button",
  ".floating-navigation button", ".headline-player-transport button",
  ".headline-player-story-actions button", ".headline-player-back",
  ".article-browser-transport button", ".article-reader-actions button[aria-label='Close article reader']", "[data-hand-select]",
].join(",");

export default function HandGestureControls() {
  const [host, setHost] = useState<Element | null>(null);
  const [hostHeight, setHostHeight] = useState(0);
  const [guide, setGuide] = useState(false);
  const [practice, setPractice] = useState(false);
  const [mode, setMode] = useState<"hands" | "eyes">(() => {
    try { return localStorage.getItem(MODE_STORAGE_KEY) === "hands" ? "hands" : "eyes"; }
    catch { return "eyes"; }
  });
  const [eyeTracking, setEyeTracking] = useState<EyeTracking>("missing");
  const [eyeScores, setEyeScores] = useState<EyeFrame | null>(null);
  const [state, setState] = useState<"off" | "starting" | "on">("off");
  const [status, setStatus] = useState("Camera off");
  const [pointer, setPointer] = useState<HandPoint | null>(null);
  const [pointing, setPointing] = useState(false);
  const [toast, setToast] = useState(false);
  const [tracking, setTracking] = useState<HandTracking>("missing");
  const [showPreview, setShowPreview] = useState(true);
  const preview = useRef<HTMLCanvasElement>(null);
  const session = useRef(0);
  const cleanup = useRef<(() => void) | null>(null);
  const live = useRef({ practice });
  live.current = { practice };
  const selected = useRef<{ element: HTMLElement; since: number } | null>(null);
  const busy = useRef(false);
  const eyeDetector = useRef(createEyeGestureDetector());

  function saveMode(nextMode: "hands" | "eyes") {
    setMode(nextMode);
    try { localStorage.setItem(MODE_STORAGE_KEY, nextMode); } catch { /* Storage is optional. */ }
  }

  function changeMode(nextMode: "hands" | "eyes") {
    saveMode(nextMode);
    if (state !== "off") void start(nextMode, true);
  }

  function clearSelection() {
    selected.current?.element.classList.remove("hand-gesture-highlight");
    selected.current = null;
  }

  function stop(message = "Camera off") {
    session.current++;
    cleanup.current?.(); cleanup.current = null;
    clearSelection(); setPointer(null); setPointing(false); setTracking("missing"); setEyeTracking("missing"); setEyeScores(null); eyeDetector.current.reset(); setState("off"); setStatus(message);
  }

  useEffect(() => {
    const updateHost = () => {
      const player = [...document.querySelectorAll<HTMLElement>(".headline-player")].find((element) => element.style.display !== "none");
      const target = document.querySelector(".article-reader-backdrop") ?? player ?? document.querySelector(".signal-dashboard");
      setHost((current) => current === target ? current : target);
      setHostHeight(Math.min(innerHeight, target?.getBoundingClientRect().height ?? innerHeight));
    };
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("fullscreenchange", updateHost);
    window.addEventListener("resize", updateHost);
    const hidden = () => { if (document.hidden) stop("Camera stopped while Signal was hidden. Start it again when ready."); };
    const leave = () => stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      session.current++; cleanup.current?.(); clearSelection(); observer.disconnect();
      document.removeEventListener("fullscreenchange", updateHost);
      window.removeEventListener("resize", updateHost);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
    };
  }, []);

  useEffect(() => { clearSelection(); setPointer(null); }, [host, practice, guide]);
  useEffect(() => { eyeDetector.current.reset(); }, [host, practice]);
  useEffect(() => {
    if (guide || (state === "off" && status === "Camera off")) { setToast(false); return; }
    setToast(true);
    const timeout = window.setTimeout(() => setToast(false), 3500);
    return () => window.clearTimeout(timeout);
  }, [status, guide, state]);

  function updatePointer(point: HandPoint | undefined) {
    if (!point || live.current.practice) { clearSelection(); setPointer(null); setPointing(false); return; }
    const x = Math.max(10, Math.min(innerWidth - 10, point.x * innerWidth));
    const y = Math.max(10, Math.min(innerHeight - 10, point.y * innerHeight));
    setPointer({ x, y });
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>(SELECTABLE);
    const blockedByModal = handGesturesBlocked();
    const usable = !blockedByModal && element && !element.closest("[inert], [data-hand-gesture-ui]") && !element.matches(":disabled, [aria-disabled='true']");
    if (!usable) { clearSelection(); setPointing(false); return; }
    if (selected.current?.element !== element) {
      clearSelection(); selected.current = { element, since: performance.now() };
      element.classList.add("hand-gesture-highlight");
    }
    setPointing(true);
  }

  async function perform(action: HandAction) {
    if (busy.current) return;
    const label = HAND_ACTION_LABELS[action];
    if (live.current.practice) { setStatus(`Practice: ${label}. No action taken.`); return; }
    if (handGesturesBlocked()) { setStatus("Close the pop-up window before using reading gestures."); return; }
    if (action === "select") {
      const target = selected.current;
      if (!target || !target.element.isConnected || performance.now() - target.since < 350) {
        setStatus("Point at a reading button or story until it is outlined, then pinch."); return;
      }
      target.element.click(); clearSelection(); setStatus("Selected highlighted control"); return;
    }
    busy.current = true;
    try { setStatus(await runHandGestureAction(action)); }
    catch { setStatus("That action could not finish. Please use its on-screen control."); }
    finally { busy.current = false; }
  }

  async function start(targetMode: "hands" | "eyes" = mode, restart = false) {
    if (state !== "off" && !restart) return;
    if (!window.isSecureContext) { setStatus("Camera gestures need a secure HTTPS connection."); return; }
    if (!navigator.mediaDevices?.getUserMedia || !window.Worker || !window.createImageBitmap) {
      setStatus("Camera gestures are unavailable in this browser. Try an up-to-date Chrome or Samsung Internet."); return;
    }
    saveMode(targetMode);
    const currentSession = ++session.current;
    const isCurrent = () => session.current === currentSession;
    cleanup.current?.(); cleanup.current = null;
    clearSelection(); setPointer(null); setPointing(false); setTracking("missing");
    eyeDetector.current.reset(); setEyeScores(null); setEyeTracking("missing");
    setState("starting"); setStatus(`Allow the front camera to start ${targetMode === "eyes" ? "eye controls" : "hand gestures"}…`);
    let stream: MediaStream | null = null;
    let worker: Worker | null = null;
    let timer = 0;
    let startupTimer = 0;
    let video: HTMLVideoElement | null = null;
    const release = () => {
      window.clearTimeout(timer); window.clearTimeout(startupTimer);
      worker?.terminate(); stream?.getTracks().forEach((track) => track.stop());
      if (video) { video.pause(); video.srcObject = null; }
    };
    cleanup.current = release;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
      if (!isCurrent()) { release(); return; }
      stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => { if (isCurrent()) stop("Camera disconnected. Start again to reconnect."); }));
      video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (!isCurrent()) { release(); return; }
      setStatus(`Loading private ${targetMode === "eyes" ? "eye" : "hand"} recognition…`);
      worker = new Worker(new URL("./hand-gesture.worker.ts", import.meta.url));
      const detector = createHandGestureDetector();
      let lastVideoTime = -1;
      let responseTimer = 0;
      const originalRelease = release;
      cleanup.current = () => { window.clearTimeout(responseTimer); originalRelease(); };
      const capture = async () => {
        if (!isCurrent() || !video || !worker) return;
        if (video.readyState < 2 || video.currentTime === lastVideoTime) { timer = window.setTimeout(capture, 20); return; }
        lastVideoTime = video.currentTime;
        try {
          const context = preview.current?.getContext("2d");
          if (context && preview.current) context.drawImage(video, 0, 0, preview.current.width, preview.current.height);
          const bitmap = await createImageBitmap(video);
          if (!isCurrent()) { bitmap.close(); return; }
          worker.postMessage({ type: "frame", bitmap, timestamp: performance.now() }, [bitmap]);
          responseTimer = window.setTimeout(() => { if (isCurrent()) stop("Camera recognition stopped responding. Start again to retry."); }, 15000);
        } catch { if (isCurrent()) stop("Could not read the camera. Stop other camera apps and try again."); }
      };
      worker.onmessage = ({ data }: MessageEvent<HandFrame & { type: string; timestamp?: number; eye?: EyeFrame }>) => {
        if (!isCurrent()) return;
        window.clearTimeout(responseTimer);
        if (data.type === "ready") {
          window.clearTimeout(startupTimer); setState("on"); setStatus(targetMode === "eyes" ? "Look at the camera with both eyes open until Eyes ready appears." : "Ready. Show one hand inside the camera preview."); void capture();
        } else if (data.type === "result") {
          if (targetMode === "eyes") {
            const frame = data.eye ?? { faceCount: 0 };
            const result = eyeDetector.current.update(frame, Number.isFinite(data.timestamp) ? data.timestamp! : performance.now());
            setEyeTracking(result.state); setEyeScores(frame);
            const context = preview.current?.getContext("2d");
            if (context && preview.current && frame.points?.length) {
              context.fillStyle = "#23db92";
              for (const point of frame.points) {
                context.beginPath(); context.arc(point.x * preview.current.width, point.y * preview.current.height, 2, 0, Math.PI * 2); context.fill();
              }
            }
            if (handGesturesBlocked()) eyeDetector.current.reset();
            else if (result.action) void perform(result.action);
            // Sample again promptly so blinks and winks are captured across several frames.
            timer = window.setTimeout(capture, 16);
            return;
          }
          const result = detector.update(data, Number.isFinite(data.timestamp) ? data.timestamp! : performance.now());
          setTracking(result.state);
          const context = preview.current?.getContext("2d");
          if (context && preview.current && result.tracking) {
            context.fillStyle = "#23db92";
            for (const point of data.landmarks[0]) {
              context.beginPath(); context.arc(point.x * preview.current.width, point.y * preview.current.height, 2, 0, Math.PI * 2); context.fill();
            }
          }
          // A pinch uses the target held just before fingertips close together.
          if (result.action) void perform(result.action);
          updatePointer(result.pointer);
          timer = window.setTimeout(capture, 40);
        } else if (data.type === "error") stop("Camera recognition could not load or run. Stop and try again in Chrome or Samsung Internet.");
      };
      worker.onerror = () => { if (isCurrent()) stop("Camera recognition is unavailable. Try restarting it or updating your browser."); };
      startupTimer = window.setTimeout(() => { if (isCurrent()) stop("Camera recognition took too long to load. Please try again."); }, 60000);
      const assetRoot = new URL("/hand-gestures/v1/", location.origin).href;
      worker.postMessage({ type: "init", mode: targetMode, wasmRoot: assetRoot, modelPath: `${assetRoot}${targetMode === "eyes" ? "face-landmarker.bin" : "gesture-recognizer.bin"}` });
    } catch (error) {
      release();
      if (!isCurrent()) return;
      const denied = error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      stop(denied ? "Camera access was denied. Allow Camera in this site's browser settings, then start again."
        : "Could not start the front camera. Close other camera apps and try again.");
    }
  }

  if (!host) return null;
  // A windowed headline player establishes a fixed-position containing block.
  // Keep pointer display aligned with viewport-based elementFromPoint targeting.
  const containingBlock = getComputedStyle(host).transform !== "none" ? host.getBoundingClientRect() : null;
  const trackingText = mode === "eyes" ? EYE_TRACKING_LABELS[eyeTracking] : tracking === "tracking" ? "Hand detected" : tracking === "multiple" ? "Show just one hand" : "No hand in view";
  const isTracked = mode === "eyes" ? eyeTracking === "ready" : tracking === "tracking";
  const eyeFeedback = mode === "eyes" && eyeScores?.faceCount === 1 && <div className="eye-gesture-scores" aria-label="Eye closure feedback">
    <label>Your left eye <meter min={0} max={1} value={eyeScores.left ?? 0} /> {Math.round((eyeScores.left ?? 0) * 100)}% closed</label>
    <label>Your right eye <meter min={0} max={1} value={eyeScores.right ?? 0} /> {Math.round((eyeScores.right ?? 0) * 100)}% closed</label>
  </div>;
  return createPortal(<div className={`hand-gesture-dock${guide ? " hand-gesture-guide-open" : ""}`} style={guide ? { maxHeight: Math.max(160, hostHeight - 24) } : undefined} data-hand-gesture-ui>
    <div className="hand-gesture-bar">
      <button type="button" className={`hand-gesture-launch${state !== "off" ? " camera-active" : ""}`} onClick={() => setGuide((value) => !value)} aria-label="Hand and eye gesture guide" title={`Hand and eye gesture guide${state !== "off" ? ` · camera ${state === "starting" ? "starting" : "on"}${practice ? " · practice only" : ""}` : ""}`} aria-expanded={guide} aria-controls="hand-gesture-guide"><span aria-hidden="true">{mode === "eyes" ? "👁" : "✋"}</span><span className="hand-gesture-button-label">Hand &amp; eye controls</span>{state !== "off" && <span className="hand-gesture-camera-dot" aria-hidden="true" />}</button>
      {guide && state !== "off" && <span className="hand-camera-indicator">Camera {state === "starting" ? "starting" : "on"}</span>}
      {guide && state !== "off" && <button type="button" onClick={() => stop()}>Stop camera</button>}
    </div>
    {!guide && state === "on" && <div className={`hand-gesture-monitor${showPreview ? " has-preview" : ""}`}>
      {showPreview && <canvas ref={preview} width={160} height={120} aria-label="Live mirrored camera tracking preview" />}
      <p className={isTracked ? "hand-is-tracked" : ""} role="status">{trackingText}</p>
      {eyeFeedback}
      <small>{practice ? "Practice only" : "Controls active"}</small>
    </div>}
    {!guide && toast && <p className={`hand-gesture-toast${state === "on" ? " above-monitor" : ""}`} role="status">{practice ? "Practice only · " : ""}{status}</p>}
    {guide && <>
      <p className="hand-gesture-status" role="status">{status}</p>
      {state === "on" && <div className="hand-gesture-live">
        <canvas ref={preview} width={160} height={120} aria-label="Mirrored front camera preview" />
        <p className={isTracked ? "hand-is-tracked" : ""} role="status">{trackingText}</p>
        {eyeFeedback}
        <label><input type="checkbox" checked={practice} onChange={(event) => { setPractice(event.target.checked); clearSelection(); }} /> Practice only</label>
        <label><input type="checkbox" checked={showPreview} onChange={(event) => setShowPreview(event.target.checked)} /> Show tracking preview while using gestures</label>
        <p>{practice ? "Practice only: gestures are recognised without changing Signal." : "Controls active: gestures work while this guide is open."}</p>
      </div>}
    </>}
    {guide && <section id="hand-gesture-guide" className="hand-gesture-guide" aria-labelledby="hand-gesture-title">
      <h2 id="hand-gesture-title">Read hands-free</h2>
      <label className="gesture-mode-choice">Control mode <select value={mode} onChange={(event) => changeMode(event.target.value as "hands" | "eyes")}><option value="eyes">Eye winks &amp; long blink</option><option value="hands">Hand gestures</option></select></label>
      {mode === "eyes" ? <>
        <p>Rest your phone on a stand in good light. Face the front camera with your whole face in view. Keep both eyes naturally open until <strong>Eyes ready</strong> appears. Green dots and the eye meters show how Signal sees your eyes.</p>
        <ol>
          <li>Tap <strong>Start eye controls</strong> and allow camera access. Wait for <strong>Eyes ready</strong> in the preview.</li>
          <li>Close both eyes for about half a second to a second, or wink one eye briefly, then reopen both eyes to confirm the command.</li>
          <li>To practise without changing Signal, choose <strong>Practise gestures</strong>.</li>
        </ol>
        <dl>
          <dt>Wink your right eye</dt><dd>Keep your left eye open. Hold briefly, then reopen both eyes for the next topic in the feed, or the next story / headline in the reader or player.</dd>
          <dt>Wink your left eye</dt><dd>Keep your right eye open. Hold briefly, then reopen both eyes for the previous topic, story or headline. Left and right mean your own eyes, as shown in the mirrored preview.</dd>
          <dt>Long blink with both eyes</dt><dd>Close both eyes for about half a second to a second, then reopen. In the news feed this moves to the next topic. While narration or headline playback is open it pauses or resumes instead. Start audio using its on-screen Play button first. Your browser may require another Play tap to resume.</dd>
        </dl>
        <p>Brief natural blinks are ignored. Closing your eyes for more than about 3 seconds cancels the command. Losing face tracking also cancels it. Signal adjusts to how open your eyes normally look while you face the camera. Glasses, reflections, lighting and slow camera processing can affect recognition; use the touch controls if needed.</p>
      </> : <>
      <p>Rest your phone on a stand. Face the front camera in good light and show one whole hand with fingers spread. Wait for <strong>Hand detected</strong> in the preview, then move your hand. Green dots show the hand Signal can see.</p>
      <ol>
        <li>Tap <strong>Start hand gestures</strong> and allow camera access. This guide closes and gestures control Signal.</li>
        <li>In the news feed, swipe an open hand left for the next topic or right for the previous topic.</li>
        <li>To learn without changing anything, choose <strong>Practise gestures</strong>. Turn off <strong>Practice only</strong> and close this guide when ready.</li>
      </ol>
      <dl>
        <dt>Swipe an open hand left / right</dt><dd>In the news feed, move left for the next followed topic or right for the previous topic. From All topics, left opens the first followed topic and right opens the last. In a reader or headline player, swipes move between stories or headlines. Move sideways by about the width of your palm while keeping your hand in the preview. You do not need to hold it still first.</dd>
        <dt>Move an open hand up / down</dt><dd>Scroll up / down in the feed or reader. Lower your hand between gestures to repeat.</dd>
        <dt>Hold an open palm still</dt><dd>Hold for about one second to pause narration.</dd>
        <dt>Hold a closed fist</dt><dd>Hold briefly to resume narration. Start playback with an on-screen tap first; your browser may require another tap to resume audio.</dd>
        <dt>Hold a thumbs-up</dt><dd>Bookmark the current headline, reader article, or visible feed story. An existing bookmark stays saved.</dd>
        <dt>Point, then pinch</dt><dd>Move your index finger to position the on-screen dot. Hold over a story or reading button until outlined, then bring thumb and index fingertips together to activate it. Spread them apart before another pinch.</dd>
      </dl>
      <p>Lower your hand briefly between commands. Point at a story’s title and pinch to open it. Other pop-up windows suspend reading gestures. Tap the floating hand button to reopen this guide or stop the camera.</p>
      </>}
      <p>Only the selected control mode runs. Other pop-up windows suspend commands. Reopen this floating guide to switch modes, practise or stop the camera.</p>
      <p>Video is processed on your device and is not recorded or uploaded. Camera use consumes extra battery. The camera stops when Signal is hidden or you tap Stop camera. It never starts automatically.</p>
      <div className="hand-gesture-guide-actions">
        {state === "off" && <>
          <button type="button" onClick={() => { setPractice(false); setGuide(false); void start(mode); }}>{mode === "eyes" ? "Start eye controls" : "Start hand gestures"}</button>
          <button type="button" onClick={() => { const other = mode === "eyes" ? "hands" : "eyes"; setPractice(false); setGuide(false); void start(other); }}>{mode === "eyes" ? "Start hand gestures" : "Start eye controls"}</button>
          <button type="button" onClick={() => { setPractice(true); void start(mode); }}>Practise gestures</button>
        </>}
        {state === "on" && <button type="button" onClick={() => { setPractice(false); setGuide(false); }}>Use gestures now</button>}
        <button type="button" onClick={() => setGuide(false)}>Close guide</button>
      </div>
    </section>}
    {pointer && <span className={`hand-gesture-pointer${pointing ? " is-targeting" : ""}`} style={{ left: pointer.x - (containingBlock?.left ?? 0), top: pointer.y - (containingBlock?.top ?? 0) }} aria-hidden="true" />}
  </div>, host);
}
