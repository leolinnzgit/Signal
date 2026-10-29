# Seasonal themes

Signal and SignalWatch automatically select a theme using the device's local
calendar. The web app keeps the saved light/dark preference. The native app,
briefing tile, public watch demo and support pages share the same theme identity.

| Theme | Active dates, inclusive | Appearance |
| --- | --- | --- |
| Halloween | October 1–31 | Pumpkin mark, orange and plum |
| Christmas | December 1–26 | Tree mark, evergreen and cranberry |
| New Year | December 27–January 7 | Fireworks mark, midnight blue and gold |
| Chinese New Year | Lunar New Year's Eve through the fifteenth day (Lantern Festival) | Lantern mark, red and gold |
| Standard | All other dates | Original Signal branding |

Chinese New Year dates for **2026–2040** come from the
[Hong Kong Observatory conversion tables](https://www.hko.gov.hk/en/gts/time/conversion.htm).
For example, 2027 uses February 5–20. These are civil celebration dates, evaluated
against the user's local date; changing time zones does not shift a festival to
a different Gregorian day. No network calendar request is made by either app.

`public/seasonal-calendar.json` is the checked source. After extending or updating
it, run `python scripts/Sync-SeasonalCalendar.py --watch-project ../SignalWatch`
to update the embedded web and native tables. Use `--check` to verify parity.
Beyond the checked year range, the app retains standard branding during the
lunar festival until its date table is extended; the fixed-date themes continue.

The web bootstrap and native app refresh at midnight and on return to the app.
The offline shell caches every seasonal mark. Launcher icons and app names keep
the usual Signal identity, and disaster warnings keep their red warning styling.

The [public watch demo](https://signal.tail445c22.ts.net/signalwatch/) has a
**Theme preview** picker. Its `?theme=christmas`, `?theme=new-year`, and
`?theme=chinese-new-year` links affect only that sample page. **Automatic** removes
the override; the account app and approval pages always use the actual calendar.

SignalWatch **0.19.1 (32)** includes these themes. Signal Companion is unchanged at
**0.12.0 (21)**. Install the signed watch APK from the existing download page.

Validation uses `npm run test:client` for the date windows, lunar calendar,
midnight/foreground refresh, preview isolation and cached marks. After building
the IIS client, `npm run test:seasonal-themes` checks every theme in login and
dashboard views at 390px/1280px in light/dark mode, exactly one loaded logo, the
public preview picker, layout and warning colors. Set `SIGNAL_PLAYWRIGHT_MODULE`
to the local Playwright module when it is not installed in the project.
