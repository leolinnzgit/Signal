/* Local calendar time, refreshed at midnight and when returning to the app. */
(() => {
  let timer;
  function refresh() {
    const now = new Date();
    const halloween = now.getMonth() === 9;
    document.documentElement.dataset.season = halloween ? "halloween" : "standard";
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) {
      favicon.href = halloween ? "/icons/signal-halloween.svg" : "/icons/signal-medallion-64.png";
      favicon.type = halloween ? "image/svg+xml" : "image/png";
    }
    clearTimeout(timer);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 50);
  }
  refresh();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
