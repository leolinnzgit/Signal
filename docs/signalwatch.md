# SignalWatch release preparation

## Daily Cast, Talk to Signal debrief & Hazard Tile / Complication: SignalWatch 0.25.0 (39) and SignalCompanion 0.13.0 (23)

SignalWatch 0.25.0 (39) and SignalCompanion 0.13.0 (23) introduce Daily Cast podcast listening on the wrist, "Talk to Signal" voice executive debriefs, and an active hazard & severe weather Glance Tile and Wear OS Complication.

Key capabilities introduced:
- **Daily Cast on Wrist:** Wear OS users can browse Daily Cast presets (`/api/daily-cast`) or stream/play today's full episode directly. Two-host podcast dialog turns (David Vance & Sarah Chen) are natively partitioned into audio/speech sections with full `BriefingPlaybackService` and `NewsPlayer` integration, sleep timer support, rotary navigation, and offline encrypted caching in `DailyCastCache`. A dedicated "Today's Daily Cast" Glance Tile (`DailyCastTileService`) provides one-tap episode opening and playback from the watch face carousel.
- **Talk to Signal / Voice Executive Debrief:** Users can speak natural-language executive queries directly to their watch via microphone speech recognition (`RecognizerIntent`) or pick curated executive presets ("Morning NZ Business Brief", "Tech & AI Briefing", "Emergency & Hazard Status"). Watch queries are routed to `/api/voice-debrief/query`, rendering executive summaries and key takeaways on screen while triggering spoken debrief playback.
- **Active Hazard & Severe Weather Tile / Complication:** Real-time emergency hazard monitoring is integrated into the watch face via `HazardComplicationService` (`SHORT_TEXT` showing "✓ Calm" or "⚠️ RED" and `LONG_TEXT`) and a dedicated Glance Tile (`HazardTileService`). When GDACS, GeoNet earthquake, or MetService severe weather alerts are active, the tile renders an emergency warning with an immediate "View Hazards" launch button into the Disasters view.

Release validation (8 November 2026): all server checks, 461 client tests, and 98 Kotlin JVM test tasks passed across `app`, `phone`, and `shared` modules. Release lint reported zero errors. Signed APK/AAB, bundletool validation, unchanged upload certificate, 64-bit/16 KB alignment, and private signing material exclusion checks passed.

Checked artifacts:
- Watch: `../SignalWatch/outputs/play-release/0.25.0-39/`. APK SHA256: `a479bc1d14ea6855440d6870328ff7902fa484ce19325d4d920791bcb8e52a05`.
- Companion: `../SignalWatch/outputs/play-release/0.13.0-23/`. APK SHA256: `7cd3e6363f7dcc281be729ec03208865261b7f9dada79c4c8bcb49c72a9dc222`.
ADB listed no connected devices; physical-device verification remains physical QA.

Publication verification (8 November 2026): both Watch channels serve 0.25.0 (39), and both public HTTPS APK downloads match the checked hashes above. Active hazard tile/complication, Daily Cast podcast streaming, and Talk to Signal voice debriefs are deployed to IIS. Watch publication retained protected production file checksums, App_Data, and existing data.

## Disaster alert parity, severe weather warnings & preview: SignalWatch 0.24.1 (38) and SignalCompanion 0.12.1 (22)

SignalWatch 0.24.1 (38) and SignalCompanion 0.12.1 (22) establish full disaster alert parity between the Wear OS watch app, companion, and the Signal web app.

Severe weather warnings (`/#weather-alerts`), earthquakes (`/#earthquake-alerts`), and GDACS disasters (`/#disaster-alerts`) are fully supported across native push validation, Wear OS data layer forwarding, and watch UI feeds. Previously, native push notifications for severe weather were rejected due to restrictive URL pattern matching in `NativeNotice.valid()`. With `/#weather-alerts` whitelisted and payload URL propagation in `NativeNotice.show()`, weather warnings are delivered smoothly to both phone and watch.

Life-safety disaster alerts on the watch now default to enabled (`true`) whenever notifications are permitted, preventing silent drop of critical warnings. Active disaster alerts matching the user's phone location are synchronized directly into the watch's live feed and active alert modal from `/api/earthquakes/map-feed` and `/api/disasters/active`. The live hazards feed on the watch highlights RED and ORANGE severity events with dedicated styling and emergency badges ("RED ALERT" / "ORANGE ALERT"). Furthermore, a "Test disaster alert" preview action is available in the watch's Disasters view, matching the Signal web app's preview capability with a simulated Cook Strait M5.2 event.

Release validation (7 November 2026): all server checks, 461 client tests, and 98 Kotlin JVM test tasks passed across `app`, `phone`, and `shared` modules. Release lint reported zero errors. Signed APK/AAB, bundletool validation, unchanged upload certificate, 64-bit/16 KB alignment, and private signing material exclusion checks passed.

Checked artifacts:
- Watch: `../SignalWatch/outputs/play-release/0.24.1-38/`. APK SHA256: `e5a340b7b2658625aa8730abbfaeaa7cb88b4ad9dadabc21337ea7717844d819`.
- Companion: `../SignalWatch/outputs/play-release/0.12.1-22/`. APK SHA256: `7329ea1c3b2876ed8ebd3899b843f1c9f9e77fd507f2459a22b5b473877f281e`.
ADB listed no connected devices; physical-device verification remains physical QA.

Publication verification (7 November 2026): both Watch channels serve 0.24.1 (38), and both public HTTPS APK downloads match the checked hashes above. Active disaster feed parity and weather warnings are deployed to IIS. Watch publication retained protected production file checksums, App_Data, and existing data.

## Briefing queue sync, offline images and background handoff: SignalWatch 0.24.0 (37)

SignalWatch 0.24.0 (37) brings shared briefing and catch-up queue synchronization with the phone web app, disk caching for story preview images, and background wake-up for phone-to-watch handoff.

The briefing queue sync protocol mirrors Listen Later's account-scoped compare-and-swap mechanism (`/api/briefing-progress`), keeping up to 20 stories synchronized between the phone and watch along with section/part progress and heard fingerprints (capped at 200 items). Changes made offline are staged in an outbox and merged automatically upon reconnecting. The web app's Shared Listening panel now provides a dedicated "Resume briefing" flow alongside the saved single-story resume.

Story preview images fetched from the news feed are now cached to app-private disk storage (`context.cacheDir/story-images/`), enabling headline illustrations to render even when the watch is disconnected from the network or reopened after restart. Cache entries are automatically cleared upon account sign-out.

Phone-to-watch handoff now supports background wake-up: when an active audio stream or briefing is transferred to the watch while the app is closed, a high-priority Wear OS notification with a "Continue listening" action allows immediate resumption and launches `MainActivity` with the inbound handoff ID.

Release validation (7 November 2026): all 149 Watch release JVM tests passed, including new test suites for briefing state serialization, CAS outbox transitions, heard fingerprint merging, and story image caching. Release lint reported zero errors (42 warnings). Signed APK/AAB, bundletool validation, unchanged upload certificate, 64-bit/16 KB alignment, and private signing material exclusion checks passed.

Checked artifacts: `../SignalWatch/outputs/play-release/0.24.0-37/`. APK SHA256: `8eff247183b13d9f027a068f29bd744a79ec50bffa7f3b87498dd3cbd47a54aa`. ADB listed no connected devices. Physical-device verification using `Invoke-DeviceQa.ps1` and live BLE/Wi-Fi handover remain physical QA.

Publication verification (7 November 2026): both Watch channels serve 0.24.0 (37), and both public HTTPS APK downloads match the checked hash above. The live preview passed briefing sync CAS, offline story image caching, phone-to-watch background wake-up notification, shared Resume briefing dialog, and queue progression. Anonymous listening APIs remain protected; the deployed phone listening flow and companion 0.12.0 (21) were preserved. Watch publication retained all five protected production file checksums and preserved App_Data and existing listening progress. Source commit: SignalWatch `57ade95`.


## Sleep timer: SignalWatch 0.23.0 (36)

The player adds a compact Sleep timer control with 15-, 30- and 60-minute choices, Finish current story, a countdown, Change and Cancel. Timed choices use Android elapsed realtime, including preparation and pauses; changing the duration starts a fresh deadline. Expiry pauses playback, retains the current saved speech-section boundary, releases active/prefetched audio and requires an explicit Play to continue. Finish current story consumes the completed queue entry and leaves the next entry paused at its own saved section. The last story still completes normally. Explicitly changing stories cancels end-of-story mode; a timed deadline continues across ordinary queue advancement.

The timer lives only in the existing playback service and requests no new permissions or alarms. Closing the screen/app preserves it while that service is alive. Stop, replacement playback, service destruction (including the existing five-minute paused idle timeout), reboot and incoming/accepted phone handoff clear it. Timers do not transfer to the phone or restart audio. Expiry cancels a pending outgoing handoff. Playback checks deadlines again before resume, section advancement and recorded/local-voice starts, preventing delayed preparation from starting sound after expiry. Existing queue/progress, account-conflict and disaster-warning protections remain in place. Companion stays 0.12.0 (21).

Release validation (31 October 2026): all 144 Watch release JVM tests passed, including nine new timer tests for elapsed deadlines, duration changes, cancellation, stale callbacks, end-of-story boundaries and the next story's own saved section. Release lint reported zero errors (42 warnings). Signed APK/AAB, bundletool, unchanged upload certificate, 64-bit/16 KB alignment and private-file checks passed. Browser checks passed at 390px and 1280px for all timer choices, change/cancel, paused expiry, explicit resume, queue boundaries, Stop reset, existing tiles, downloads, browsing, images and phone handoff. Companion/shared phone code is unchanged.

Checked artifacts: `../SignalWatch/outputs/play-release/0.23.0-36/`. APK SHA256: `51b81c1e626e48a185abdc7b52b2065c40ec4c37d91339385f97aea64fa1bd7e`. ADB listed no connected devices. Screen-off timing, Bluetooth/installed Watch voice, interruptions and physical-device queue/handoff behavior remain device QA.

Publication verification (31 October 2026): both Watch channels serve 0.23.0 (36), and both public HTTPS APK downloads match the checked hash above. The live preview passed active timer expiry and explicit resume at the saved section, queue tile readiness, images, phone transfer, shared Resume and queue/download controls. Anonymous listening APIs remain protected; the deployed phone listening flow and companion 0.12.0 (21) were preserved. Watch-only publication retained all five protected production file checksums and all three saved listening data file checksums. Source commits: SignalWatch `aca58c5`, Signal preview/docs `dc87abe`. No Google Play upload was made.

## Listen later tile: SignalWatch 0.22.0 (35)

Add **Signal Listen later** from the Watch tile picker. It shows the current locally saved queue story and original speech section, the number of complete recorded stories ready offline, and active, paused or waiting download status. **Queue** opens a focused screen with the existing queue, downloads and playback controls. **Play queue** or **Resume** starts the current locally saved queue only after an explicit tap. A stale playback tap from another account or server is rejected. The briefing tile and unread complication remain available separately.

The tile reads existing account-bound encrypted queue and media state on a background executor. Viewing it makes no network calls, schedules no downloads and starts no playback. Queue edits, saved sections and download events request tile updates; Android controls when they render. An opportunistic five-minute freshness interval updates local charging/network status. Partial or changed recordings do not count as ready. Saved queue text remains playable with the installed Watch voice when recorded audio is missing. No new persistent store or account data collection is added. Companion remains 0.12.0 (21).

Release validation (30 October 2026): all 135 Watch release JVM tests passed, including seven tile tests covering saved sections, queue edits, account/server isolation, complete/partial recording readiness, waiting states, empty queues and stale playback taps. Release lint reported zero errors (42 warnings). Signed APK/AAB, bundletool, unchanged upload certificate, 64-bit/16 KB alignment and private-file checks passed. Both protected tile services are present in the packaged manifest. Preview checks passed at 390px and 1280px for explicit Play/Resume, offline counts, waiting states, completion, empty queues, downloads, images, existing handoff and browsing. Companion and shared phone code are unchanged.

Checked artifacts: `../SignalWatch/outputs/play-release/0.22.0-35/`. APK SHA256: `a400fbd7deab229abd4d7ee36cb4171f0130fe30af066e905b20eadf9b989e0c`. ADB listed no connected devices. Tile picker, small round-screen layout, app-exit/reboot recovery, network switching and notification actions remain physical-device QA.

Publication verification (30 October 2026): both Watch channels serve 0.22.0 (35), and both public HTTPS APK downloads match the checked hash above. The live preview passed tile offline counts, waiting for Wi-Fi, explicit Play/Resume at the saved section, images, phone transfer, shared Resume and queue/download controls. Anonymous listening APIs remain protected; the deployed phone listening flow and companion 0.12.0 (21) were preserved. Watch-only publication retained all five protected production file checksums and all three saved listening data file checksums. Source commits: SignalWatch `c13483a`, Signal preview/docs `5d067f1`. No Google Play upload was made.

## Background queue audio: SignalWatch 0.21.0 (34)

Watch downloads now run through Android WorkManager 2.10.5. Explicit requests persist across ordinary app exits and device restarts; interrupted sections resume from the existing encrypted cache. An account-bound, opt-in Automatic downloads control checks the current shared queue while the Watch is charging on unmetered Wi-Fi. Android controls timing; periodic checks have a 15-minute minimum interval and can be delayed by quotas or power management. A force-stopped app must be opened again. The phone browser still needs to stay open for its downloads. Companion remains 0.12.0 (21).

WorkManager stores opaque request/automatic-policy IDs and numeric progress. Account details, manual URLs and scheduling intent stay in encrypted SecureSession storage. HTTP sockets and DNS are pinned to the job's eligible network. Background sync verifies the account, flushes previously authorized offline edits through the existing idempotent compare-and-swap protocol, then refreshes the queue. Conflicts keep the newer server queue; it never starts playback. Every file commit checks the current account and request identity. A new manual request replaces older work, and stale notification actions cannot cancel a newer request. Cancel, clear or removal turns automatic mode off; sign-out clears intent and jobs. Disabling automatic mode preserves an explicit manual request. The cache remains encrypted and limited to 100 MB with the existing optional cleanup.

Transfers use bounded four-section/four-minute batches, preserving completed audio and scheduling continuations. Transient network/service failures retry with exponential backoff. Authentication failures turn automatic mode off; storage or invalid-data failures pause automatic attempts until an explicit retry. A private, silent notification shows numeric progress and Cancel downloads when notification permission is granted. WorkManager's data-sync foreground service supports active transfers; it uses a separate channel from news alerts and media playback. Opening that notification never starts sound.

Release validation (30 October 2026): all 128 Watch release JVM tests, 12 companion compatibility tests and 250 client tests passed. Release lint reported zero errors (42 warnings). Signed APK/AAB, bundletool, unchanged upload certificate, 64-bit/16 KB alignment and private-file checks passed. Preview checks passed at 390px and 1280px for automatic opt-in, cancellation retaining completed audio, clear/remove disabling automatic mode, manual constraints, cleanup, images and existing transfers. IIS publication/storage protection checks passed. Checked artifacts: `../SignalWatch/outputs/play-release/0.21.0-34/`. APK SHA256: `10b106b534a037035b0ae1369d8eaf798ddca292377133d7ed0684e328858303`.

ADB listed no connected devices. Physical app-exit/reboot, network switching, OS quota behaviour and notification-action QA remain required.

Publication verification (30 October 2026): both Watch download channels serve 0.21.0 (34), and their HTTPS APK downloads match the checked hash above. The live preview passed automatic opt-in/cancel with completed audio retained, news images, transfer, shared Resume and queue progression. Anonymous listening APIs remain protected, and the deployed phone listening flow remains available. Watch-only publication preserved all five protected production files and all three saved listening data file checksums. Companion 0.12.0 (21) was preserved. Source commits: SignalWatch `86e7369`, Signal preview/docs `b61459a`. No Google Play upload was made.

## Offline queue audio: SignalWatch 0.20.0 (33)

Download one Listen later story or the whole queue on the phone web app or Watch. Downloads use the current recorded reading voices, show progress and support cancellation/retry. Playback prefers a completed local recording, starts at the saved section and advances through the queue. Missing or damaged Watch recordings fall back to streaming when available, then the device voice. Browser offline playback uses a completed local recording or device voice. Queue order, text, shared positions and two-phase handoff remain independent of audio downloads. Media files stay on the downloading device.

The web Listening panel keeps its compact header entry. Its Offline audio disclosure shows storage use, the 100 MB browser-profile cap, queue download/cancel/clear controls and optional removal of audio when stories leave the queue. Each recording is committed to IndexedDB only after synthesis completes; cancelled and failed recordings cannot appear ready. Reloading preserves completed recordings and exact speech section offsets. Browser storage eviction can remove downloaded audio. Watch files and metadata use Android Keystore encryption in app-private no-backup storage, with a 100 MB audio cap, atomic per-section writes and retries that retain completed sections. Changed story text and voices invalidate the relevant recordings. Watch can optionally wait for Wi-Fi and charging while SignalWatch remains open. Keep the app open until downloads complete; background scheduling and automatic restart after process death are not promised. Sign-out clears downloaded media; ordinary cancellation and playback stop do not.

Release validation passed 115 Watch JVM tests, release lint (zero errors, 39 warnings), signed APK/AAB and bundletool verification, unchanged upload certificate, 64-bit/16 KB alignment and private-file exclusion. Checked artifacts: `../SignalWatch/outputs/play-release/0.20.0-33/`. APK SHA256: `7441c63b7121629d17686cdfcdc7715e5640cc8f0c8efb6f888064b81f32c0f4`.

Web validation passed type checking, 250 client tests, the full IIS/server check suite, durable recorded audio with exact section resume, cancellation/retry, account isolation, storage failure, cleanup and sign-out deletion. Phone and desktop queue handoff, preview audio controls and news images passed. The compact Listening panel passed at 360, 390 and 1280 pixels in both seasonal themes. The pending-Resume cancellation regression now holds its mocked response until the panel closes, avoiding a machine-timing dependency.

Native source commit: `8533bfe`; web implementation: `1a1adb4`. All 12 companion compatibility tests passed; companion remains 0.12.0 (21). The production IIS build passed. With the network fully offline, the built client reopened its cached shell and resumed both device-voice text and downloaded PCM at the exact section. Removing the local copy also removed its audio; a 401 still returned the sign-in screen. No ADB devices were connected, so physical-device download, screen-off, headphone and interruption QA remains pending.

Publication verification (30 October 2026): IIS and both Watch download channels serve 0.20.0 (33). Both HTTPS APK hashes match the checked artifact above, and the deployed web bundle includes persistent queue-audio storage and download controls. Live preview checks passed news images, downloads, queue progression, Resume and transfer. Anonymous listening APIs remain protected. Deployment backed up the database and preserved all four production configuration checksums and all three saved listening data file checksums. No Google Play upload was made.

## Seasonal themes: SignalWatch 0.19.1 (32)

[Seasonal themes](seasonal-themes.md) adds Christmas, New Year and Chinese New Year
to the existing Halloween style. The native app, briefing tile, web app, offline
shell and public demo share the same calendar rules and vector identities.
Chinese New Year uses checked Hong Kong Observatory dates for 2026–2040.
The public demo has a Theme preview picker that affects only its sample page.
Signal Companion remains 0.12.0 (21). Install the signed Watch APK to update the
native app; the seasonal web styling is delivered through the IIS deployment.

Release validation passed 111 Watch JVM tests, release lint (zero errors, 38 warnings), signed APK/AAB and bundletool checks, unchanged upload certificate, 64-bit/16 KB alignment and private-file exclusion. Checked artifacts are in `../SignalWatch/outputs/play-release/0.19.1-32/`. APK SHA256: `6c3034b77377c638244cf395f96a1b3a6b6c70dea20726a9af20c69fb792504f`.

Web/server validation passed client type checking, 236 client tests, the complete IIS check suite, full server topic matcher and audio tests, IIS storage and public watchdog checks, workspace cleanup tests, production IIS client build and package deployment. The public watch preview includes the Theme preview picker for automatic, standard, Halloween, Christmas, New Year and Chinese New Year palettes. The companion remains 0.12.0 (21) (`e7719a23b1375eecc31fafc832235f4d89fe6130525040afde8873a15b77c612`). All 12 companion compatibility tests passed.

Native source commit: `fae6e6b`.

Publication verification (29 October 2026): IIS and both Watch download channels serve 0.19.1 (32), and both HTTPS APK hashes match the checked artifact above (`6c3034b77377c638244cf395f96a1b3a6b6c70dea20726a9af20c69fb792504f`). The deployed web bundle includes seasonal themes and offline vector marks; production settings, configuration hashes, App_Data and listening state were preserved. No Google Play upload was made.

## Full-queue handoff: SignalWatch 0.19.0 (31)

Continue on watch in the web Listen later player, or Continue on phone during Watch queue playback, transfers every remaining queued story in its existing order and resumes the latest confirmed section. The receiving device explicitly accepts first. The source then pauses, flushes its actual position, and confirms a durable queue revision. Readiness rotates that revision atomically, preventing an old source outbox from reclaiming the queue. Only the claiming receiver can read the temporary handoff snapshot; it must also verify the current account and exact queue revision before playing. A concurrent edit or failed verification stops the handoff. The source stops its queue player after confirmation. Queue order and per-story section offsets remain intact as the receiving player advances.

Queue creation requires a server capability acknowledgement; acceptance requires an explicit queue-capable receiver. Older Watch apps do not discover queue offers and cannot accept them as a single story. Single-story handoffs remain compatible. Use Watch 0.19 or later and the updated Signal server/web app, keeping both apps open until acceptance. If the current story finishes before acceptance, start a new transfer for the next story. Cancellation, expiry, account changes and interruptions retain the existing fail-closed behaviour; playback never resumes automatically after failure. Offline text playback remains available, while handoff itself requires connectivity. Web controls stay inside the existing Listening panel.

Release validation passed 109 Watch JVM tests, release lint (zero errors, 38 warnings), signed APK/AAB and bundletool checks, unchanged upload certificate, 64-bit/16 KB alignment and private-file exclusion. Checked artifacts are in `../SignalWatch/outputs/play-release/0.19.0-31/`. APK SHA256: `f90e7d77c430f940053cf7fb294d34f77a4f59db3d7ef6e3fccb7c90c51d9a56`.

Web/server validation passed type checking, 230 client tests, the complete IIS check suite, queue transfer tests using browser and recorded audio, older-server refusal, single-story handoffs in both directions, queue conflict/offline/playback regression checks and phone/desktop preview images. The compact Listening panel passes at 360, 390 and 1280 pixels in both seasonal themes; a CSS specificity correction also prevents duplicate brand marks outside October. Physical paired-device, screen-off, interruptions and reconnect QA still require connected hardware. The companion remains 0.12.0 (21), and seasonal branding is preserved.

Native source commit: `659e12a`; web/server implementation: `a6c6518`. All 12 companion compatibility tests passed. The production IIS build and built-client network-offline reopening, saved section playback, local outbox and sign-in boundary checks passed.

Publication verification (29 October 2026): IIS and both Watch download channels serve 0.19.0 (31), and both HTTPS APK hashes match the checked artifact above. Live preview images, transfer, Resume and queue controls passed. The deployed web bundle includes both handoff flows and queue capabilities; anonymous listening APIs return 401. Deployment backed up the database and preserved all four production configuration hashes and all three saved listening data file hashes. No Google Play upload was made.



## Halloween edition: SignalWatch 0.18.1 (30)

[Seasonal branding](halloween-theme.md) adds a pumpkin mark, orange accents and
plum surfaces to the native app, briefing tile, web app and browser preview.
The device's local October calendar controls the theme; standard branding
returns in November. Signal Companion remains 0.12.0 (21).

Native source commit: `7f33f05`. All 106 release JVM tests passed; release lint
reported zero errors (38 warnings). Signed APK/AAB, bundletool, unchanged upload
certificate, 64-bit/16 KB alignment and private-file checks passed. Checked
outputs: `../SignalWatch/outputs/play-release/0.18.1-30/`. APK SHA256:
`5ba21932779fedc4c661e300c97513db0b189c8ca63e4c965b7b7d1315c1661e`.

Web validation passed client type checking, 228 client tests, the production IIS
build, phone/desktop light/dark layouts, local October/November date boundaries,
midnight/foreground branding reset, offline reopening, watch preview interactions,
images, queue, Resume, phone approvals and disaster warning colors. IIS storage,
watchdog and publication-script syntax checks passed. No ADB devices were
connected; physical watch QA remains outstanding. No Google Play upload was made.


Publication verification (28 October 2026): the existing IIS app and both Watch
download channels serve this release. Both HTTPS APK hashes match the checked
release above; deployed seasonal assets and the service worker match source.
Live phone/desktop app and preview checks passed. Publication backed up the
database and preserved recorded production configuration hashes.


## Listen later: SignalWatch 0.18.0 (29)

Save full stories with **Listen later +** on the phone feed or reader, or **Add to Listen later** on Watch. Phone controls reorder or remove stories; Watch offers Play Listen later, individual story playback and removal. Reordering preserves the selected story and its saved section. Selecting another story starts there and cycles through the remaining queue. Finished or skipped stories leave the queue, without changing read/bookmark status. Additions and reorders during Watch playback apply on the next queue start; the playing snapshot remains fixed.

Resume the shared queue with **Play Listen later** on either device. Existing **Continue on phone/watch** controls transfer a single story.

The account queue holds ten unique stories, at most 19,500 text characters per story and 100,000 total. Full text must be available and within those limits. Browser storage and the watch's encrypted cache retain exact speech sections for offline listening with a device voice. After opening Signal online once, the service worker keeps the public IIS app shell and its assets so the phone can reopen to **Offline Listen later** without a network connection. This local-only screen does not authenticate with cached identity or sync until the user reconnects and signs in; API and account responses are never cached. Images and generated server audio are not included in offline storage. Open SignalWatch when connected to download phone additions. Sync while open, and during watch playback, never starts audio on another device. Closing or stopping preserves the current section. A changed remote revision blocks the old player's writes; reopen the queue to continue. Conflicting offline edits keep the newer server queue and display a notice, so removed stories cannot return silently.

`GET/POST /api/listening-queue` is authenticated, CSRF-protected, account-scoped and no-store. Opaque revisions, idempotent operation IDs, atomic file replacement and per-account file locks protect concurrent edits. Empty queues retain their revision. Records live in preserved `App_Data/listening-queue/<account hash>.json`, separately from the 0.17 single-story progress API for older-client compatibility. There is no automatic expiry. To delete account data, revoke sessions and remove that account's queue JSON and lock file. Browser queue storage clears on sign-out; native queue storage clears with account data.

Native implementation: `1e64fec`. Validation passed: 105 Watch release unit tests, 12 companion compatibility tests, release lint (zero errors, 38 warnings), signed APK/AAB and Google bundletool verification, 64-bit and 16 KB alignment checks, unchanged upload certificate, full IIS suite, 228 final client tests, phone/desktop queue and preview checks, Resume and handoff regressions, and a built-client test with the network fully disabled. Checked outputs: `../SignalWatch/outputs/play-release/0.18.0-29/`. APK SHA256: `d7dc62255d374cd9f4d1fc693b31e4a67a860db0d5cd10a3657f5bfb3866e742`; AAB SHA256: `e797226bb2f8d3f9fc8448548021e4ea61cf89997d503fe29f69779b8c314235`. Physical Watch/phone and screen-off audio checks still require a connected device; this release does not upload to Google Play.

Published on 28 October 2026 from backend/phone commit `3ecf4bd` and native commit `1e64fec`. The existing IIS deployment, main Watch download and native-preview download were updated; both live APK downloads matched the checked SHA256 above. The HTTPS preview passed queue progression, images, incoming transfer and shared Resume checks. The new queue GET/POST APIs returned 401 anonymously, the deployed client contained the queue flow, and the deployed offline service worker matched the source. Production configuration hashes and the existing saved-listening record were preserved; deployment took a database backup. Signal Companion remains 0.12.0 (21). No Google Play upload or physical-device validation was performed.

## GPS weather: SignalWatch 0.14.1 (25)

Watch weather now requests a fresh high-accuracy location when precise foreground permission is granted. Android permission requests include precise and approximate access together, and approximate access remains usable. Existing approximate-location users can choose **Use precise location** in Local weather. The weather location label is **Current location**, not the forecast timezone. Install the updated watch APK from `/signalwatch/`; Signal Companion remains 0.12.0 (21). Checked watch outputs are under `../SignalWatch/outputs/play-release/0.14.1-25/`. Physical watch GPS reception and permission UX still require device testing.

Source commit: `d081c90`. Validation passed: 89 watch release unit tests, 12 phone compatibility tests, watch release lint (zero errors, 33 warnings), signed AAB/APK and bundle verification, ZIP/native alignment checks, unchanged upload certificate, packaged foreground location permissions, and desktop/mobile browser preview checks. GPS hardware remains optional; the app does not request background location.

## Replacement upload codes (26 October 2026)

Signal Companion 0.12.0 now uses version code 21 because code 19 has already been uploaded to Google Play. SignalWatch uses code 22, preserving the shared application's distinct phone/watch version ordering above the previous watch code 20. Upload `../SignalWatch/outputs/play-release/0.12.0-21/SignalCompanion-0.12.0-21.aab` for the phone companion and `../SignalWatch/outputs/play-release/0.12.0-22/SignalWatch-0.12.0-22.aab` for Wear OS. These builds retain the existing features and upload certificate.

SignalWatch lives in ../SignalWatch as a separate native Wear OS project. Version 0.5.0 (7) is a signed internal-testing candidate; it has not been released to Google Play production.

## Version and finding news

Version 0.4.0 (6) shows its version/build at the top of every native screen. News and saved lists display five stories per page with Previous/Next controls. Search & topics searches every loaded story by keyword, or filters by any topic attached to the story. The topic picker is searchable and paginated too. Refresh resets the page but preserves the selected keyword and topic; switching briefing/saved clears those filters. Listen to unread follows the filtered results. Search covers the loaded briefing or latest 30 saved stories.

## Open news on the phone

Version 0.5.0 (7) adds **Open on phone** to each story and **Open Signal on phone** to the briefing/saved list. The watch uses Wear OS RemoteActivityHelper to ask the paired phone to open Signal's existing article deep link, /?article=URL&title=...&source=... (parsed by app/article-link.ts), or the Signal home page. The installed Signal web app opens it when available (manifest launch_handler navigate-existing); otherwise the phone browser opens the site. No server change was needed. Demo mode shows a reminder instead of opening sample links.

## Audio voice for unread news

SignalWatch includes **Listen to unread**, which reads the headline, publisher, and short summary of unread stories in sequence with watch-optimized controls (play/pause, previous/next, stop). In live mode, it streams WAV clips rendered by Signal's existing `POST /api/headline-audio` endpoint (using Azure Speech in production), prefetching the next clip while the current story plays. In demo mode or if server speech is unavailable (503), it seamlessly falls back to the watch's on-device Android TextToSpeech engine. When playback completes, users can optionally mark heard stories as read in one tap.

## Phone-approved sign-in

Google's Wear OS quality requirements prohibit entering an account username/password directly on the watch. The watch now requests a short-lived challenge from POST /api/watch/pairing, shows a QR code and polls POST /api/watch/pairing/claim. The phone page at /signalwatch/connect.html requires an existing authenticated Signal session and explicit, CSRF-protected POST /api/watch/pairing/approve.

Watch secrets are cryptographically random and indexed only by a hash in a bounded in-memory service. Display codes expire after ten minutes. Approval binds the authenticated account once; claims consume the approval atomically before issuing the normal Identity cookie. A restart discards pending codes. Anonymous creation and secret claims do not use browser cookies or require browser CSRF; approval always does. Rate limits apply to creation/approval and polling separately.

## Release files

The signed AAB, release APK, upload certificate, checksums and verification result are under ../SignalWatch/outputs/play-release/0.5.0-7. Private signing material is in the ignored .signing directory, with restricted Windows permissions and DPAPI-encrypted credentials. Never copy .signing into a publication package or public directory.

Store copy, assets, the data-safety worksheet and upload instructions are in ../SignalWatch/play-store. Developer/contact: Leo the Lion, leolinnz@gmail.com. Genuine native screenshots, physical-device QA, a verified developer account, review access and Play submission are still required.

## Checks

```powershell
dotnet run --project Signal.Server.TopicMatcher.Tests -- --watch-pairing-only
$env:SIGNAL_PLAYWRIGHT_MODULE = 'path/to/playwright'
node tests/signalwatch-connect.test-browser.mjs
node tests/signalwatch-preview.test-browser.mjs
```

The full server regression suite and IIS type/build checks run before server publication. Native release checks are automated by SignalWatch/scripts/Build-Release.ps1.

## Publication

Server changes use the existing IIS build/deploy scripts, which preserve production settings and App_Data and back up the database. Then run scripts/Publish-SignalWatch.ps1 to publish only checked public watch artifacts to C:\sites\SignalHost\signalwatch. Its dedicated IIS configuration serves APK files with the correct MIME type; APIs continue through the root Signal application.

Publication verifies the APK against the checked local release manifest, backs up previous public files and verifies production server/settings hashes. It publishes the release/debug APKs, visual preview, phone approval page and support/privacy/deletion-request pages. It never publishes the AAB, private upload key or credentials. release.json records the current public release APK checksum and explicitly says Play Store publication has not occurred.

The release key differs from the initial debug key. Existing debug installations must be uninstalled before direct release installation; Play App Signing may introduce a distinct distribution key.

## Voice, tile and selective/disaster alerts (0.8.0)

The notification preview now uses watch build 13 and companion build 12. Voice search launches the system speech recognizer and filters the loaded briefing or latest 30 saved stories; cancellation preserves the existing query and unavailable recognition falls back to typing. Speech recognition is handled by the system provider under that provider's settings.

Add **Signal briefing** in the Wear OS tile picker. It displays an encrypted snapshot of the latest loaded briefing with an unread count and load time. Open and Listen launch SignalWatch; playback starts after sign-in/loading completes. Refresh the app to update the snapshot. Sign-out clears it; it is not a background news fetcher.

Under **Watch alerts**, enable notification permission, choose news on/off, up to 20 exact topics and 20 comma-separated keywords, optional quiet hours and a daily limit (5/10/20/50 notifications). Any topic OR keyword match qualifies; empty lists select all. Topics include secondary article topics; keywords search headline, publisher, summary and topics. **Save alert settings** saves topic/keyword rules per account through authenticated, CSRF-protected `/api/watch/alerts`. News on/off, local watch-time quiet hours and daily limits stay on that watch. The server filters the complete new-story batch before preparing a wrist preview; phone/browser news content remains independent. A deliberate wrist suppression is acknowledged separately from display so phone bridging does not bypass the filter. Normal unavailable-watch fallback remains active.

Disasters are a separate opt-in in the same screen. They bypass news filters, quiet hours and news quotas, while respecting Android notification settings. Enable background disaster notifications in Signal on the phone, choose hazard types/radius/severity, refresh the phone location at least daily, and link that browser to Signal Companion. Server disaster routing selects only the phone installation linked to the originating browser endpoint. Existing browser disaster delivery remains active. Earthquake and GDACS tags use a separate notification channel. Tapping a report opens its title, source/location details and receipt time on the watch; **Disaster alerts** keeps the last received report encrypted and account-bound. No received report is not an all-clear; follow local authorities. This feature does not request watch GPS or replace official warnings.

Both updated APKs are required for intentional-filter acknowledgements and native disaster handover. Publish checked watch/phone candidates with `scripts/Publish-SignalWatch.ps1 -NotificationPreview -WatchProject <checked-release-source>`. Physical watch/phone speech input, tile layout, notification delivery and vibration still require device QA; no Google Play release is claimed.


## Screen-off audio, offline briefing and complication (0.9.0 build 14)

The watch owns narration in a media-playback foreground service with a platform MediaSession, notification controls and an active-playback partial wake lock. Activity visibility no longer pauses playback or keeps the screen awake. Audio-focus loss and unplugging headphones pause; paused sessions stop after five minutes. Stop, completion and sign-out release resources; a killed process never restarts sound automatically.

Last-loaded briefing/saved headlines and summaries are encrypted and scoped to server/account. Download full stories keeps up to ten supported full articles; opening a story also caches its text within a 40,000-character article limit. Read/bookmark actions persist before sending, retain final bookmark values for idempotent retry, and sync on validated connectivity or manual refresh. A bounded queue refuses new changes rather than dropping unsent ones. Sign-out/account replacement clears the cache and queue. Offline speech uses the installed watch TTS voice.

Signal unread provides SHORT_TEXT and LONG_TEXT complication data from the last-refreshed, encrypted tile snapshot. A tap opens the briefing. Data updates on load/read/sign-out; it does not poll for news. Add it through a compatible watch face's complication picker.

Notification checks on 25 October 2026 passed the server routing, receipt, account ownership, fallback and pairing suites. The live /api/native/status still returned ready:false and ADB listed no devices. The owner confirmed Firebase files are not available. Real phone/watch delivery, screen-off battery behavior and complication rendering remain physical-device checks; no active native push or Play publication is claimed. The existing checked 0.8.0 (12) companion supports this watch-only update.

Release verification: SignalWatch source commit `c807757`; 44 release JVM tests passed, lint reported zero errors (26 warnings), and bundle/signature/ZIP/native-alignment/private-file checks passed. The packaged media service and complication declarations were inspected, and the deployed watch APKs and companion were downloaded again and matched their checked SHA-256 hashes. Watch and companion upload certificates match. Native push still reports `ready:false`; physical-device checks remain outstanding.

## Full-story audio, player reader link and synced reading voice (0.9.1 build 15)

The audio player panel now includes **Read full story**, opening the full extracted text of whichever story is currently playing without stopping playback, and **Listen to full story**, which splits the full extracted article into bounded passages and reads the entire article aloud (from cached offline text when downloaded, or extracted on demand when connected). **Listen to full story** is also available on the story detail and full-article reader screens.

Voice choices selected in Signal on the phone (`ReadingVoiceSelector`) are saved per account via `/api/headline-audio/preferences` (`App_Data/user-voices.json`) and automatically applied to watch narration requests on `/api/headline-audio`, so the watch always uses the exact same reading voice selected on the phone.

## Firebase server activation (25 October 2026)

Production native push is now configured for Firebase project `signal-73617`. Google authentication and an FCM validation-only request passed; local and public `/api/native/status` return `ready:true`. The key is stored outside the website and repository with restricted Windows permissions. This supersedes the missing-Firebase status recorded during the earlier release checks. Existing Android bundles load the Firebase options from the server, so this configuration does not require an AAB rebuild. Real paired phone/watch delivery remains to be tested; see [native notifications](native-notifications.md).

## Prominent disaster warnings (0.10.0 build 16)

A new, validated, opted-in disaster report immediately shows a red warning while SignalWatch is resumed. It displays the original title, details and receipt time, pauses narration, and offers Acknowledge. Acknowledging, Back or a dismiss swipe returns to the prior app screen without automatically restarting audio. Acknowledgement is encrypted with the report and retains its history. The foreground warning is limited to unacknowledged reports received within five minutes and bound to the active account/server; an old acknowledgement cannot replace a newer stored report.

Background alerts use a warning icon, View alert action and a distinctive three-pulse vibration on the watch's urgent disaster channel. Migration preserves the previous channel's importance, sound and vibration-disabled setting. Android notification permission, channel settings and Do Not Disturb remain in control. The app does not start an activity from the background or request unsupported full-screen intent access. The existing companion 0.8.0 (12) is compatible; only the watch needs updating. The public preview includes a clearly labelled sample warning and acknowledgement interaction. Physical watch layout, vibration and ambient-mode checks remain device tests.

## Wrist actions, AI takeaways, translation, markets & social (0.12.0 build 20)

Watch news notifications now include **Listen**, **Save**, and **Mark read** action buttons, and automatically update the encrypted briefing tile and watch-face complication snapshot (`BriefingCache.onNewsPush`) when a permitted news push arrives. Audio playback adds speaking speed control (`0.9x`, `1x`, `1.25x`, `1.5x`), section/15-second skipping during full-story playback, and **Shuffle unread** on the briefing screen.

Story detail and full-article reader views add **Key takeaways** (`POST /api/article-summary` with automatic extractive fallback when AI summary is unavailable or offline) and one-tap **中文翻译** / **Translate EN** (`POST /api/article-translation`). **Markets & clocks** displays live market quotes (`GET /api/market`) for followed topics alongside your synced Signal secondary world clock and saved weather place (`GET /api/preferences`). **Disaster alerts** retains up to 10 received watch alerts and checks the live nearby earthquakes and GDACS feed (`GET /api/earthquakes/map-feed`). **Friends & messages** and **Comments** let you share stories to Signal friends (`POST /api/social/shares`), read and reply to direct messages (`GET/POST /api/social/messages` with quick replies and voice input), and read or post article comments (`GET/POST /api/comments`) from your wrist.

## Catch me up (0.13.0 build 23)

**Catch me up** on the briefing and **Catch up** on the Signal briefing tile prepare up to five new or changed unread stories from the loaded personalised feed, in feed order. Overlapping headlines are grouped into one attributed extract. A budget of up to 220 speech units plus pauses targets roughly two minutes at 1x; duration varies by voice and language. It uses headline/summary extracts and makes no additional AI or full-article requests. Refresh for current news before starting.

Completed segments remember the versions of grouped stories independently of read status. Unchanged completed versions stay out of subsequent catch-ups; updated headlines/summaries become eligible again. Skipped or interrupted segments remain eligible. Save, Hear more (full-story audio), and Open on phone are in the player. Mark heard as read remains explicit.

The last prepared briefing and up to 200 completed version fingerprints are encrypted, server/account-bound and cleared with offline data on sign-out or account replacement. Replay last catch-up shows its preparation time and works offline using the installed watch voice. Narration recordings remain temporary. Foreground disaster warnings interrupt catch-up audio and cancel queued tile playback. Companion 0.12.0 (21) and the existing server remain compatible. Physical-watch timing, tile layout, offline TTS, interruption and screen-off QA remain necessary before Play rollout.

Release verification (26 October 2026): native source commit `d92af46`; all 74 watch release JVM tests and 12 companion debug JVM tests passed. Release lint reported zero errors (33 warnings). Bundle validation, signatures, ZIP/native alignment and private-file checks passed using the existing upload identity, which matches companion 0.12.0 (21). Browser preview checks passed at 1280px and 390px, including catch-up actions, cached replay and disaster-warning return; phone approval/privacy regression checks passed. Both published watch APKs were downloaded over public HTTPS and matched SHA-256 `912772adbc34c56436977259551b27f94d5da6e36f5f1cb1d0e459eab8c9bd8c`. Publication preserved production server/settings files and App_Data. ADB listed no connected devices, so physical-watch QA remains outstanding. No Google Play publication is claimed.

## Continue listening and media volume (0.14.0 build 24)

Resume listening restores the last unfinished queue, story and speech section after closing the app, the five-minute paused idle timeout or a watch restart. The Signal briefing tile offers Resume when a saved position exists, otherwise Catch up. Playback requires an explicit tap; no reboot receiver or automatic start is added. Stop retains progress; queue completion or Forget saved position clears it. Both cloud narration and watch TTS use actual section boundaries. One server clip is rendered per section and the next section is prefetched, replacing estimated seeking within a combined WAV. Existing paused server playback preserves its exact position; durable resume starts at the section boundary. Long paragraphs may span sections.

Queue text and progress are encrypted, server/account-bound and excluded from backups, with limits of 500 stories, 500,000 spoken characters and a 1,500,000-character serialized document. The snapshot contains the text needed to resume offline with an installed local watch voice. Changed loaded story/full-article text invalidates its old position. Account replacement/sign-out clears progress and invalidates old playback writers; demo progress stays in memory.

Volume down/up adjust the actual Android media stream in single device steps with an on-screen percentage and device range limits. They work while paused without starting playback, preserve the existing level on resume and respect fixed-volume outputs and Android restrictions. The normal MODIFY_AUDIO_SETTINGS permission needs no runtime prompt. Alarm/notification settings are unchanged. Companion 0.12.0 (21) and the existing server remain compatible. Physical speaker/Bluetooth volume, audio interruption, idle timeout, reboot and offline TTS QA remain required before Play rollout.

Release verification (26 October 2026): native source commit `d2967eb`; all 87 watch release JVM tests passed, including 13 new resume/volume tests and a 500-story queue round-trip. Release lint reported zero errors (33 warnings). Bundle validation, signatures, ZIP/native alignment and private-file checks passed with the existing upload certificate, matching companion 0.12.0 (21). Browser preview checks passed at 1280px and 390px, including saved-section resume after Stop, explicit Play, paused-state volume changes, minimum/maximum button limits, queue completion and Forget; phone approval/privacy regression checks passed. Both public watch APKs were downloaded over HTTPS and matched SHA-256 `c51ffcd80d3d0cb23507e1b4ad4fee38027b7782782a460998d06e14013b477e`. Publication preserved production server/settings files and App_Data. No ADB devices were connected; physical-watch reboot/idle recovery, interruption, offline TTS and speaker/Bluetooth volume QA remain outstanding. No Google Play publication is claimed.

## Watch-to-phone full-story handoff (0.15.0 build 26)

Choose Continue on phone in the full-story watch player. The watch creates an authenticated, CSRF-protected transfer and opens `/?watchHandoff=<opaque ID>` using the existing paired-phone link. The signed-in phone previews its title/section and requires Continue on phone. The source watch polls from its playback service, validates the account, playback session, URL and exact narration text, pauses, then acknowledges its latest section. Only then can the claiming browser retrieve playable text and prepare audio. The existing player consumes the exact remaining watch sections, with its previous phone cache position suppressed; recorded streaming, browser voice, speaking speed and manual Play fallback remain available.

The coordination endpoints are `/api/listening-handoffs` with account isolation, CSRF on mutations, per-account polling limits, high-entropy independent source/receiver proofs, atomic single-receiver acceptance, bounded text/capacity and short expiry. Pending offers last five minutes, acceptance requires watch acknowledgement within 45 seconds, and confirmed offers remain available five minutes. State is server-memory-only, pruned on requests/restart, and survives neither an IIS restart nor an expired acknowledgement. No database schema or production settings change is required. The phone stores only opaque tab-scoped ID/proof values for optional Google sign-in and retries; the source secret is never in the URL.

Cancellation, offline/unreachable phones, expired offers, changed source playback and account replacement do not automatically resume or start sound. The watch retains its local paused checkpoint. Foreground disaster warnings cancel pending handoffs. During the pause acknowledgement, watch resume/skip/replacement controls wait for completion or explicit cancellation. Existing companion 0.12.0 (21) remains compatible. This first phase transfers a full story from watch to phone, without reverse handoff, briefing queues or continuous cross-device progress sync. Paired-device/transport and real phone autoplay QA remain necessary before Play rollout.

Release checks (27 October 2026): native source commit `2966696`; 93 watch release JVM tests and 12 companion debug JVM tests passed. Release lint reported zero errors (34 warnings), and bundle/signature/64-bit/16 KB alignment/private-file checks passed with the existing upload identity. The full IIS checks passed, including 215 client tests, authenticated HTTP/CSRF handoff tests and server/storage/watchdog regressions. Phone handoff browser checks passed at 390px and 1280px for explicit acceptance, withheld audio until watch acknowledgement, exact remaining sections, blocked-autoplay fallback, browser voice, cancellation and suppression of an old cached phone position. Existing watch preview and phone approval/privacy browser checks passed at both widths.

Publication verification: the phone/server IIS package and both watch download channels are live. Public HTTPS downloads matched checked watch APK SHA-256 `f095e86af15b91e67ec4162c549402f171ca79b2de18adf4d8ac0f05706a526c`. The deployed client includes the handoff flow, and anonymous GET/POST calls to its new API returned 401. Companion 0.12.0 (21) was preserved using its verified release archive and matching upload certificate. Deployment created a database backup and preserved App_Data and production configuration hashes. ADB listed no connected devices, so physical paired-device transport, interruptions and real phone autoplay QA remain outstanding. No Google Play publication is claimed.


## Continue on watch and news images (0.16.0 build 27)

The full-story phone player offers Continue on watch for recorded and browser narration. Keep the phone player and SignalWatch open. Foreground-only inbox discovery shows Continue from phone on the watch; accepting pauses existing watch playback, then waits for the source phone to pause and confirm its latest section. Only the claiming receiver can obtain exact playable text. Source/receiver proofs, account isolation, CSRF, bounded memory and expiry rules apply in both directions. Existing 0.15 watch-to-phone clients remain compatible. Transfers preserve the source sections in saved listening progress, while watch speed and Android media volume remain under watch control. Leaving the receiver app, cancellation, account replacement and urgent disaster warnings prevent new watch audio. This release does not add continuous cross-device progress sync, queues or background wake-up for reverse handoff.

Feed image URLs now survive shared story parsing, encrypted offline snapshots and explicit handoffs. Detail and full-story screens load available HTTPS publisher images on demand using a credential-free client, public-DNS validation on redirects, at most four requests, a 1 MiB response limit, JPEG/PNG/WebP, a 16-million-pixel source limit and sampled decoding to at most 320 pixels. A 1.5 MB memory cache avoids repeat downloads during reading; image files are not added to offline downloads. Failed/missing images leave text readable. Privacy information and the interactive sample preview describe/show both features. Existing companion 0.12.0 (21) remains compatible.

Release checks (27 October 2026): native source commit `c7ac4fa`; all 97 watch release JVM tests passed. Release lint reported zero errors (34 warnings), and signed bundle validation, 64-bit/16 KB alignment and private-file checks passed with the existing upload certificate. Client type checking and all 215 client tests passed. The server suite passed in an isolated rerun after a speech-engine timeout during concurrent builds; IIS storage and watchdog checks passed. Browser checks at 390px and 1280px passed both listening directions, recorded and browser-speech source handoff, latest-section confirmation, control locking, cancellation, oversized-image fallback, optional image/text-only previews, existing watch interactions and phone approval/privacy regressions. No ADB devices were connected; actual paired-device and watch-image rendering QA remain outstanding.

Publication verification: both public HTTPS watch APK downloads matched checked release SHA-256 `2c388ece96767c841b9fcf38eaeebf2ccb3e506b03f0ac745d37283401646082`. The deployed phone bundle contains Continue on watch; anonymous inbox, transfer read and create requests returned 401. The live HTTPS preview rendered its sample image and completed its explicit incoming-transfer demo. All 12 companion debug JVM tests passed; companion 0.12.0 (21) and its matching upload identity were preserved. IIS deployment created a database backup, preserved App_Data and retained all recorded production configuration hashes. Source implementation commits are Signal `9dacf46` and SignalWatch `c7ac4fa`. No Google Play publication or physical-device verification is claimed.


## Shared full-story Resume (0.17.0 build 28)

One full-story snapshot per account now persists in `App_Data/listening-progress/<account-hash>.json`. Authenticated, CSRF-protected compare-and-swap mutations use opaque server revisions and idempotent operation IDs. Cross-process file locks and atomic durable replacement prevent lost writes; corrupt storage fails closed. Completion and Forget clear story text but retain a revision marker. Offline work retains its original base revision and cannot rebase over another device's update. Account fingerprints on writes/reads and browser email verification guard sign-in changes. Operators handling account deletion must remove this directory's corresponding account record after revoking the account's sessions.

The phone keeps an account-scoped local-storage snapshot/outbox, coalesces section updates, retries on connectivity/visibility and every 15 seconds while open, and clears device data on sign-out. The watch uses existing encrypted storage, no backups, and foreground/listening-service retry loops. Exact saved parts and indices resume on either device only after tapping Resume saved story. A shared resume does not need a live handoff or the other device to be open. Conflicts keep the server's accepted revision and block the old automatic writer; they do not pause current audio. Completion/Forget propagate on the next successful sync. Briefing queues remain local. Physical device, offline/reconnect and process-death tests remain required.

Release verification (28 October 2026): source commits Signal `3e12189` and SignalWatch `5b7a37e`. All 101 watch release JVM tests, 12 companion debug JVM tests and 221 client tests passed, along with client type checking, the full server suite, IIS storage and watchdog checks. Release lint reported zero errors (36 warnings). Bundle/signature, 64-bit/16 KB alignment and private-file checks passed with the existing upload identity. Browser checks at 390px and 1280px passed explicit exact-section resume without arrival autoplay, durable offline outbox/replay, remote Forget, stale-write rejection, completion, sign-out, existing handoff/image/approval flows and the shared-position preview. Companion signing-variable cleanup was required for its separate debug test invocation; its 0.12.0 (21) published artifact was preserved.

Both public watch APKs were downloaded over HTTPS and matched SHA-256 `e2764c15623b6fae21aba052cef5b95ad85cd8ef57b52d01da44a4ee686b5288`. The deployed bundle contains the shared-progress API and Resume flow; the live API requires sign-in. The HTTPS demo rendered images, incoming handoff and shared Resume. Publication created a database backup and preserved App_Data and production configuration hashes. No ADB devices were connected; physical paired-device, offline/reconnect and process-death QA remain outstanding. No Google Play publication is claimed.
