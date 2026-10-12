export function scrollReadingSectionIntoView(container: HTMLElement, highlight: HTMLElement, reducedMotion: boolean) {
  // Scroll only the reader, leaving the page and keyboard focus in place.
  const viewport = container.getBoundingClientRect();
  const firstLine = highlight.getClientRects()[0] ?? highlight.getBoundingClientRect();
  if (firstLine.top >= viewport.top + 24 && firstLine.bottom <= viewport.bottom - 24) return;
  container.scrollTo({
    top: Math.max(0, container.scrollTop + firstLine.top - viewport.top - Math.max(24, container.clientHeight / 4)),
    behavior: reducedMotion ? "instant" : "smooth",
  });
}
