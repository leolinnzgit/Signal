# SignalWatch release preparation

SignalWatch lives in ../SignalWatch as a separate native Wear OS project. Version 0.2.0 (2) is a signed internal-testing candidate; it has not been submitted to Google Play.

## Phone-approved sign-in

Google's Wear OS quality requirements prohibit entering an account username/password directly on the watch. The watch now requests a short-lived challenge from POST /api/watch/pairing, shows a QR code and polls POST /api/watch/pairing/claim. The phone page at /signalwatch/connect.html requires an existing authenticated Signal session and explicit, CSRF-protected POST /api/watch/pairing/approve.

Watch secrets are cryptographically random and indexed only by a hash in a bounded in-memory service. Display codes expire after ten minutes. Approval binds the authenticated account once; claims consume the approval atomically before issuing the normal Identity cookie. A restart discards pending codes. Anonymous creation and secret claims do not use browser cookies or require browser CSRF; approval always does. Rate limits apply to creation/approval and polling separately.

## Release files

The signed AAB, release APK, upload certificate, checksums and verification result are under ../SignalWatch/outputs/play-release/0.2.0-2. Private signing material is in the ignored .signing directory, with restricted Windows permissions and DPAPI-encrypted credentials. Never copy .signing into a publication package or public directory.

Store copy, assets, the data-safety worksheet and upload instructions are in ../SignalWatch/play-store. Developer/contact: Leo, leolinnz@gmail.com. Genuine native screenshots, physical-device QA, a verified developer account, review access and Play submission are still required.

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
