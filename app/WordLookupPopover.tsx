"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  computePopoverPosition,
  extractLookupSelection,
  extractSelectionContext,
  fetchWordLookup,
  type PopoverRect,
  type WordLookupMode,
  type WordLookupResponse,
} from "./word-lookup";
import "./word-lookup.css";

type PopoverState =
  | { kind: "closed" }
  | {
      kind: "pill";
      word: string;
      context: string;
      rect: PopoverRect;
    }
  | {
      kind: "result";
      word: string;
      context: string;
      rect: PopoverRect;
      mode: WordLookupMode;
      loading: boolean;
      result: WordLookupResponse | null;
      error: string;
    };

const IGNORED_ANCESTOR_SELECTOR =
  '[data-word-lookup-ui="true"], input, textarea, select, [contenteditable="true"], button';
const CONTEXT_ANCESTOR_SELECTOR = "p, h1, h2, h3, h4, li, blockquote, article";

function getSelectionAnchorRect(range: Range): PopoverRect | null {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }
  const clientRects = range.getClientRects();
  for (let i = 0; i < clientRects.length; i++) {
    const r = clientRects[i];
    if (r.width > 0 || r.height > 0) {
      return {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }
  }
  return null;
}

function getElementFromNode(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

export default function WordLookupPopover({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<PopoverState>({ kind: "closed" });
  const stateRef = useRef<PopoverState>(state);
  stateRef.current = state;

  const popoverRef = useRef<HTMLDivElement | null>(null);
  const requestAbort = useRef<AbortController | null>(null);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== "undefined" ? window.innerWidth : 1200,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  }));

  const abortInFlight = useCallback(() => {
    requestAbort.current?.abort();
    requestAbort.current = null;
  }, []);

  const dismiss = useCallback(() => {
    abortInFlight();
    setState({ kind: "closed" });
  }, [abortInFlight]);

  useEffect(() => () => abortInFlight(), [abortInFlight]);

  const inspectSelection = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (stateRef.current.kind === "pill") {
        setState({ kind: "closed" });
      }
      return;
    }

    const anchorEl = getElementFromNode(selection.anchorNode);
    const focusEl = getElementFromNode(selection.focusNode);
    if (!anchorEl || !focusEl) return;

    if (!root.contains(anchorEl) || !root.contains(focusEl)) {
      if (stateRef.current.kind === "pill") {
        setState({ kind: "closed" });
      }
      return;
    }

    if (
      anchorEl.closest(IGNORED_ANCESTOR_SELECTOR) ||
      focusEl.closest(IGNORED_ANCESTOR_SELECTOR)
    ) {
      return;
    }

    const word = extractLookupSelection(selection.toString());
    if (!word) {
      if (stateRef.current.kind === "pill") {
        setState({ kind: "closed" });
      }
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = getSelectionAnchorRect(range);
    if (!rect) return;

    const contextNode =
      anchorEl.closest(CONTEXT_ANCESTOR_SELECTOR) ?? focusEl.closest(CONTEXT_ANCESTOR_SELECTOR);
    const context = contextNode?.textContent
      ? extractSelectionContext(contextNode.textContent, word)
      : "";

    const current = stateRef.current;
    if (
      current.kind === "result" &&
      current.word === word &&
      current.context === context
    ) {
      return;
    }

    abortInFlight();
    setState({
      kind: "pill",
      word,
      context,
      rect,
    });
  }, [abortInFlight, containerRef]);

  useEffect(() => {
    let selectionTimer: number | null = null;

    const scheduleInspect = (delayMs: number) => {
      if (selectionTimer !== null) window.clearTimeout(selectionTimer);
      selectionTimer = window.setTimeout(() => {
        selectionTimer = null;
        inspectSelection();
      }, delayMs);
    };

    const handleMouseUp = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-word-lookup-ui="true"]')) return;
      scheduleInspect(10);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (stateRef.current.kind !== "closed") {
          dismiss();
        }
        return;
      }
      if (event.shiftKey || event.key.startsWith("Arrow")) {
        scheduleInspect(20);
      }
    };

    const handleSelectionChange = () => {
      scheduleInspect(180);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-word-lookup-ui="true"]')) return;
      if (stateRef.current.kind !== "closed") {
        dismiss();
      }
    };

    const handleResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };

    const handleScroll = () => {
      if (stateRef.current.kind === "pill") {
        setState({ kind: "closed" });
      }
    };

    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      if (selectionTimer !== null) window.clearTimeout(selectionTimer);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [dismiss, inspectSelection]);

  const runLookup = useCallback(
    async (word: string, context: string, rect: PopoverRect, mode: WordLookupMode) => {
      abortInFlight();
      const abort = new AbortController();
      requestAbort.current = abort;

      setState({
        kind: "result",
        word,
        context,
        rect,
        mode,
        loading: true,
        result: null,
        error: "",
      });

      try {
        const result = await fetchWordLookup(word, mode, context || undefined, abort.signal);
        if (abort.signal.aborted) return;

        if (!result.available) {
          setState({
            kind: "result",
            word,
            context,
            rect,
            mode,
            loading: false,
            result: null,
            error: result.reason || "No lookup result is available for this selection.",
          });
          return;
        }

        setState({
          kind: "result",
          word,
          context,
          rect,
          mode,
          loading: false,
          result,
          error: "",
        });
      } catch (err: unknown) {
        if (abort.signal.aborted) return;
        setState({
          kind: "result",
          word,
          context,
          rect,
          mode,
          loading: false,
          result: null,
          error:
            err instanceof Error
              ? err.message
              : "Word lookup could not be completed. Please try again.",
        });
      }
    },
    [abortInFlight],
  );

  if (state.kind === "closed") {
    return null;
  }

  const estimatedSize =
    state.kind === "pill"
      ? { width: 280, height: 44 }
      : { width: Math.min(360, Math.max(260, viewport.width - 24)), height: 320 };

  const position = computePopoverPosition(state.rect, viewport, estimatedSize);

  return (
    <div
      ref={popoverRef}
      data-word-lookup-ui="true"
      className={`word-lookup-popover${state.kind === "result" ? " is-expanded" : ""}`}
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {state.kind === "pill" ? (
        <div
          className="word-lookup-pill"
          role="toolbar"
          aria-label="Word lookup options"
        >
          <button
            type="button"
            className="word-lookup-pill-btn primary"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runLookup(state.word, state.context, state.rect, "english")}
          >
            English meaning
          </button>
          <span className="word-lookup-pill-sep" aria-hidden="true" />
          <button
            type="button"
            className="word-lookup-pill-btn"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runLookup(state.word, state.context, state.rect, "chinese")}
          >
            中文 Chinese
          </button>
          <button
            type="button"
            className="word-lookup-pill-close"
            onMouseDown={(event) => event.preventDefault()}
            onClick={dismiss}
            aria-label="Dismiss word lookup"
            title="Dismiss"
          >
            &times;
          </button>
        </div>
      ) : (
        <section
          className="word-lookup-card"
          role="dialog"
          aria-label={`Lookup for ${state.word}`}
        >
          <header className="word-lookup-card-header">
            <div className="word-lookup-heading">
              <h3 className="word-lookup-word">{state.result?.word || state.word}</h3>
              {state.mode === "english" && state.result?.phonetic && (
                <span className="word-lookup-phonetic">{state.result.phonetic}</span>
              )}
            </div>
            <button
              type="button"
              className="word-lookup-close"
              onClick={dismiss}
              aria-label="Close word lookup"
              title="Close"
            >
              &times;
            </button>
          </header>

          <div className="word-lookup-tabs" role="tablist" aria-label="Lookup mode">
            <button
              type="button"
              role="tab"
              aria-selected={state.mode === "english"}
              className="word-lookup-tab"
              onClick={() => {
                if (state.mode !== "english" || state.error) {
                  void runLookup(state.word, state.context, state.rect, "english");
                }
              }}
            >
              English meaning
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={state.mode === "chinese"}
              className="word-lookup-tab"
              onClick={() => {
                if (state.mode !== "chinese" || state.error) {
                  void runLookup(state.word, state.context, state.rect, "chinese");
                }
              }}
            >
              中文 Chinese
            </button>
          </div>

          <div className="word-lookup-body">
            {state.loading && (
              <p className="word-lookup-status" role="status">
                {state.mode === "english"
                  ? "Looking up English meaning…"
                  : "Translating to Chinese…"}
              </p>
            )}

            {!state.loading && state.error && (
              <div className="word-lookup-error" role="alert">
                <p>{state.error}</p>
                <button
                  type="button"
                  className="word-lookup-retry"
                  onClick={() => void runLookup(state.word, state.context, state.rect, state.mode)}
                >
                  Try again
                </button>
              </div>
            )}

            {!state.loading && !state.error && state.result && state.mode === "english" && (
              <>
                {state.result.contextNote && (
                  <p className="word-lookup-context-note">{state.result.contextNote}</p>
                )}
                <div className="word-lookup-meanings">
                  {state.result.meanings.map((meaning, mIdx) => (
                    <div key={`${meaning.partOfSpeech}-${mIdx}`} className="word-lookup-meaning-group">
                      <span className="word-lookup-pos">{meaning.partOfSpeech}</span>
                      <ol className="word-lookup-defs">
                        {meaning.definitions.map((def, dIdx) => (
                          <li key={dIdx}>{def}</li>
                        ))}
                      </ol>
                      {meaning.example && (
                        <p className="word-lookup-example">“{meaning.example}”</p>
                      )}
                      {meaning.synonyms && meaning.synonyms.length > 0 && (
                        <div className="word-lookup-synonyms" aria-label="Synonyms">
                          {meaning.synonyms.map((syn) => (
                            <span key={syn} className="word-lookup-chip">
                              {syn}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {state.result.source && (
                  <footer className="word-lookup-footer">
                    <span>Source: {state.result.source}</span>
                  </footer>
                )}
              </>
            )}

            {!state.loading && !state.error && state.result && state.mode === "chinese" && (
              <>
                <div className="word-lookup-zh-primary">
                  <span className="word-lookup-zh-label">Simplified Chinese (简体)</span>
                  <div className="word-lookup-zh-main" lang="zh-Hans">
                    {state.result.chineseSimplified}
                  </div>
                  {state.result.pinyin && (
                    <div className="word-lookup-pinyin">{state.result.pinyin}</div>
                  )}
                </div>

                {state.result.chineseTraditional &&
                  state.result.chineseTraditional !== state.result.chineseSimplified && (
                    <div className="word-lookup-zh-trad" lang="zh-Hant">
                      <span className="word-lookup-zh-label">繁體</span>
                      <span>{state.result.chineseTraditional}</span>
                    </div>
                  )}

                {state.result.contextNote && (
                  <p className="word-lookup-context-note">{state.result.contextNote}</p>
                )}

                {state.result.chineseSenses.length > 0 && (
                  <div className="word-lookup-zh-senses">
                    {state.result.chineseSenses.map((sense, idx) => (
                      <div key={`${sense.partOfSpeech}-${idx}`} className="word-lookup-zh-sense">
                        <span className="word-lookup-pos">{sense.partOfSpeech}</span>
                        <span className="word-lookup-zh-sense-text" lang="zh-Hans">
                          {sense.translation}
                        </span>
                        {sense.backTranslations.length > 0 && (
                          <span className="word-lookup-zh-back">
                            ({sense.backTranslations.join(", ")})
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {state.result.source && (
                  <footer className="word-lookup-footer">
                    <span>Source: {state.result.source}</span>
                  </footer>
                )}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
