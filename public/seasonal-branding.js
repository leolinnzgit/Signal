/* Local calendar rules, shared with SignalWatch. No runtime calendar service. */
(() => {
  // BEGIN GENERATED CALENDAR
  const chineseNewYear = {
  "2026": "2026-02-17",
  "2027": "2027-02-06",
  "2028": "2028-01-26",
  "2029": "2029-02-13",
  "2030": "2030-02-03",
  "2031": "2031-01-23",
  "2032": "2032-02-11",
  "2033": "2033-01-31",
  "2034": "2034-02-19",
  "2035": "2035-02-08",
  "2036": "2036-01-28",
  "2037": "2037-02-15",
  "2038": "2038-02-04",
  "2039": "2039-01-24",
  "2040": "2040-02-12"
};
  // END GENERATED CALENDAR
  const seasons = ["standard", "halloween", "christmas", "new-year", "chinese-new-year"];
  function forDate(date) {
    const year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
    const start = chineseNewYear[year];
    if (start) {
      const [y, m, d] = start.split("-").map(Number);
      // Civil dates, independent of DST and the browser's UTC offset.
      const offset = (Date.UTC(year, month - 1, day) - Date.UTC(y, m - 1, d)) / 86400000;
      if (offset >= -1 && offset <= 14) return "chinese-new-year";
    }
    if (month === 10) return "halloween";
    if (month === 12 && day <= 26) return "christmas";
    if ((month === 12 && day >= 27) || (month === 1 && day <= 7)) return "new-year";
    return "standard";
  }
  let timer;
  function refresh() {
    const now = new Date();
    let season = forDate(now);
    // A URL override belongs only to the public sample preview, never account flows.
    const path = globalThis.location?.pathname || "";
    if (["/signalwatch/", "/signalwatch", "/signalwatch/index.html"].includes(path)) {
      const preview = new URLSearchParams(globalThis.location.search).get("theme");
      if (seasons.includes(preview)) season = preview;
    }
    document.documentElement.dataset.season = season;
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) {
      favicon.href = season === "standard" ? "/icons/signal-medallion-64.png" : `/icons/signal-${season}.svg`;
      favicon.type = season === "standard" ? "image/png" : "image/svg+xml";
    }
    clearTimeout(timer);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 50);
  }
  globalThis.SignalSeasons = Object.freeze({ forDate });
  refresh();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
