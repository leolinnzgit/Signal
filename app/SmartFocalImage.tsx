"use client";

import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import {
  enqueueLazyImageFocalAnalysis,
  formatFocalObjectPosition,
  getCachedImageCaption,
  getCachedImageFocalPoint,
  loadArticleImageCaption,
  type ImageFocalPoint,
} from "./article-image-caption";

export type SmartFocalImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  /** Analyze immediately instead of waiting for viewport dwell (used for Reader hero & full-screen player). */
  eagerAnalysis?: boolean;
  /** Populate empty alt="" with the AI image description when available. */
  aiAltFallback?: boolean;
};

export default function SmartFocalImage({
  src,
  alt = "",
  style,
  eagerAnalysis = false,
  aiAltFallback = false,
  ...rest
}: SmartFocalImageProps) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [focal, setFocal] = useState<ImageFocalPoint | null>(() => getCachedImageFocalPoint(src));
  const [aiCaption, setAiCaption] = useState<string>(() => getCachedImageCaption(src)?.caption ?? "");

  useEffect(() => {
    const cleanUrl = (src || "").trim();
    const cachedFocal = getCachedImageFocalPoint(cleanUrl);
    const cachedCaption = getCachedImageCaption(cleanUrl)?.caption ?? "";

    setFocal(cachedFocal);
    setAiCaption(cachedCaption);

    if (!cleanUrl.startsWith("https://")) {
      return;
    }

    // If eager (Reader / HeadlinePlayer), run immediately (deduplicated with ArticleImageCaption)
    if (eagerAnalysis) {
      const abort = new AbortController();
      loadArticleImageCaption(cleanUrl, fetch, abort.signal)
        .then((res) => {
          if (!abort.signal.aborted && res.available) {
            setFocal({ focalX: res.focalX ?? 0.5, focalY: res.focalY ?? 0.5 });
            if (res.caption) setAiCaption(res.caption);
          }
        })
        .catch(() => {
          // Keep default center crop on network error
        });
      return () => abort.abort();
    }

    // For feed thumbnails: if focal coordinates are already cached in localStorage or memory, zero network calls needed!
    if (cachedFocal) {
      return;
    }

    const element = imgRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }

    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelLazy: (() => void) | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        if (entry.isIntersecting) {
          if (!dwellTimer) {
            dwellTimer = setTimeout(() => {
              dwellTimer = null;
              observer.disconnect();
              cancelLazy = enqueueLazyImageFocalAnalysis(cleanUrl, (res) => {
                if (res.available) {
                  setFocal({ focalX: res.focalX ?? 0.5, focalY: res.focalY ?? 0.5 });
                  if (res.caption) setAiCaption(res.caption);
                }
              });
            }, 250);
          }
        } else if (dwellTimer) {
          clearTimeout(dwellTimer);
          dwellTimer = null;
        }
      },
      { rootMargin: "80px 0px", threshold: 0.15 },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      if (dwellTimer) clearTimeout(dwellTimer);
      if (cancelLazy) cancelLazy();
    };
  }, [src, eagerAnalysis]);

  const resolvedAlt = alt || (aiAltFallback && aiCaption ? aiCaption : "");
  const objectPosition = focal ? formatFocalObjectPosition(focal) : undefined;
  const mergedStyle = objectPosition ? { objectPosition, ...style } : style;

  return (
    <img
      ref={imgRef}
      src={src}
      alt={resolvedAlt}
      style={mergedStyle}
      data-smart-focal={focal ? "true" : undefined}
      {...rest}
    />
  );
}
