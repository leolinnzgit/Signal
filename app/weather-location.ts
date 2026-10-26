type WeatherLocation = { latitude: number; longitude: number; name: string };
type LocationStatus = "unsupported" | "denied" | "error";

// Resolve device location again on each refresh, rather than following the first fix forever.
export function startWeatherLocationRefresh(options: {
  location: WeatherLocation | null;
  geolocation?: Pick<Geolocation, "getCurrentPosition">;
  load: (latitude: number, longitude: number, name: string) => Promise<void>;
  failed: (status: LocationStatus) => void;
  visible: () => boolean;
  interval: (callback: () => void, milliseconds: number) => number;
  clearInterval: (id: number) => void;
}) {
  let stopped = false;
  let pending = false;
  const load = async (latitude: number, longitude: number, name: string) => {
    try { if (!stopped) await options.load(latitude, longitude, name); }
    catch { if (!stopped) options.failed("error"); }
    finally { pending = false; }
  };
  const refresh = () => {
    if (stopped || pending) return;
    pending = true;
    if (options.location) {
      void load(options.location.latitude, options.location.longitude, options.location.name);
    } else if (!options.geolocation) {
      pending = false;
      options.failed("unsupported");
    } else {
      options.geolocation.getCurrentPosition(
        ({ coords }) => void load(coords.latitude, coords.longitude, ""),
        error => {
          pending = false;
          if (!stopped) options.failed(error.code === 1 ? "denied" : "error");
        },
        // Ask for a fresh GPS-quality fix when the device can provide one.
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
    }
  };
  refresh();
  const timer = options.interval(() => { if (options.visible()) refresh(); }, 30 * 60 * 1_000);
  return () => { stopped = true; options.clearInterval(timer); };
}
