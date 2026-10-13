Signal reads the current weather and today's forecast when the signed-in dashboard opens and weather becomes available. It uses the selected weather location (or permitted device location), Celsius, and the saved English recorded reading voice. The summary includes current conditions, temperature, feels-like temperature, wind, today's conditions, high, low, and rain probability.

Browsers that block automatic sound show **Play weather**. **Stop weather** stops the briefing, and **Read weather on opening** remembers the automatic playback preference on this device. Opening a headline player or article stops weather audio. Periodic weather refreshes update the available recording without automatically repeating it. If weather or location is unavailable, no briefing is spoken.

Today's forecast is matched against the weather location's observation date, rather than the device's date or an arbitrary first forecast entry. Audio uses Signal's existing authenticated recorded narration endpoint and never creates a separate speech subscription.

Validation: run `npm run iis:test` for type checks and client/server tests. Run `node tests/weather-audio.test-browser.mjs` with the host's Playwright module in `SIGNAL_PLAYWRIGHT_MODULE` and, when needed, `SIGNAL_BROWSER_CHANNEL=msedge` for playback lifecycle and dashboard integration checks.
