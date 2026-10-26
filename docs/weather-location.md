# Device weather location

The Signal website and installed web app request a fresh high-accuracy device
location. The forecast uses those coordinates. The town label, such as Hamilton,
comes from a separate Azure Maps reverse lookup rather than the forecast timezone.
The compact phone header keeps the town visible beneath the temperature; extra
weather details stay hidden there to leave space for the clock.

The authenticated `GET /api/weather/location` endpoint uses the existing private
`AzureMaps:SubscriptionKey` setting and requests only populated-place results.
Coordinates are rounded to three decimal places for town lookup. Results are
cached in memory for one hour, with a limit of 512 entries; missing names are
cached for five minutes. The HTTP client does not log provider request URLs or
send account cookies to Azure. No new configuration is needed when Azure Maps is
already configured for Signal's disaster map.

Town lookup runs alongside the forecast with a short timeout. Missing
configuration, an unknown town, or a provider failure leaves **Current location**
as the label and does not prevent the weather from loading. A manually selected
city keeps its saved name and bypasses device-town lookup. Refreshing device
weather requests fresh coordinates and resolves the new town after travelling.

Checks: `npm run iis:typecheck`, `npm run test:client`, `npm run test:server`,
`npm run iis:build`, then `node tests/weather-location.test-browser.mjs` (with the
existing Playwright module configured when it is installed outside node_modules).
The browser check covers Hamilton on phone and desktop layouts, moving to
Wellington, an unavailable geocoder, and a saved city.

Provider reference: [Azure Maps reverse geocoding](https://learn.microsoft.com/en-us/rest/api/maps/search/get-reverse-geocoding?view=rest-maps-2026-01-01).
