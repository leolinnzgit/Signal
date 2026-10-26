# SignalWatch release preparation

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
