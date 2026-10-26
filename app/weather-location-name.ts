// Keep a failed town lookup independent of the forecast itself.
export async function resolveWeatherLocationName(latitude: number, longitude: number, options: {
  signal?: AbortSignal;
  fetch?: typeof fetch;
} = {}): Promise<string | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || options.signal?.aborted) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5_000);
  try {
    const query = new URLSearchParams({ latitude: latitude.toFixed(3), longitude: longitude.toFixed(3) });
    const response = await (options.fetch ?? fetch)(`/api/weather/location?${query}`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("name" in data) || typeof data.name !== "string") return null;
    const name = data.name.trim().replace(/\s+/g, " ");
    return name.length > 0 && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
  } catch { return null; }
  finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
}
