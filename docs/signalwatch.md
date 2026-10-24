# SignalWatch release preparation

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
