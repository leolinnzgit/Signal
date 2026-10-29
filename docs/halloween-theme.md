# Halloween branding

The general engine now also supports Christmas, New Year and Chinese New Year;
see [Seasonal themes](seasonal-themes.md) for the current schedule and calendar.

Signal and SignalWatch share an October-only Halloween theme: a pumpkin mark,
pumpkin orange accents, plum surfaces and warm paper in the web light theme.
The app names, navigation and saved light/dark preference stay the same.

The web login, dashboard, offline shell, favicon, watch demo and watch support
pages use `public/seasonal-branding.js`. It follows the device's local calendar,
refreshes at midnight and on return to the page, and restores the standard
branding on November 1. The seasonal script and SVG are included in the public
service-worker cache. Installed launcher icons retain the usual Signal identity.

SignalWatch **0.18.1 (30)** applies the same October rule to its native app and
briefing tile. The app checks again on resume and at local midnight. It adds a
small pumpkin and edition label above the usual scrolling content. Disaster
warnings retain their red warning treatment in both native and browser previews.
Signal Companion remains **0.12.0 (21)**.

The themed APK is installed from the existing `/signalwatch/` download page.
This release does not publish to Google Play or install itself onto a watch.

Release verification (28 October 2026): client type checking, 228 client tests, 106 Watch unit tests, native release lint (0 errors, 38 warnings), signed bundle/APK verification, phone/desktop light/dark and October/November boundary checks, offline reopening and existing preview/approval regressions passed. Both public HTTPS APK downloads matched the checked release hash. The live phone/desktop app and watch preview passed browser checks. IIS publication backed up the database and preserved all recorded production configuration hashes. Physical watch QA remains outstanding; no device was connected.
