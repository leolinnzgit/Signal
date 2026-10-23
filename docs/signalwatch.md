# SignalWatch companion

SignalWatch is a separate native Wear OS project at `../SignalWatch`, designed for Samsung Galaxy Watch7. Its first version provides a headline briefing, story summaries, saved stories, bookmark/read actions and a labelled demo mode. It reuses Signal's existing authenticated APIs without server changes.

## Preview and install

Open `/signalwatch/` on the Signal deployment for an interactive browser approximation and the checked development APK. The preview uses sample content and never signs in. The native app supports the existing Signal email/password login, encrypted session persistence and manual refresh. Google-only users can set an account password through Signal's password-reset flow.

See the separate project's README for ADB pairing and installation instructions. This first build still needs testing on a physical watch. Background push/emergency alerts, fitness/GPS tracking and phone remote control are not implemented.

## Checks

Run `./gradlew.bat testDebugUnitTest lintDebug assembleDebug` in SignalWatch. The browser approximation has a separate check:

```powershell
$env:SIGNAL_PLAYWRIGHT_MODULE = 'path/to/playwright'
node tests/signalwatch-preview.test-browser.mjs
```

## Publication

After a successful native build, run `scripts/Publish-SignalWatch.ps1` from Signal, or pass `-WatchProject` with the native project path. This publishes only the preview, development APK, its SHA-256 manifest and a directory-scoped IIS download configuration to `C:\sites\SignalHost\signalwatch`. It backs up any previous watch artifacts and verifies production settings and server binaries remain unchanged. It does not perform a full Signal deployment or touch App_Data. IIS serves this public directory directly so APK downloads have the correct MIME type. Run this publication step again after any full Signal deployment that replaces the site directory.

The generated APK is excluded from Git. `release.json` records the published artifact's checksum. Preserve the debug signing key outside Git if future development APKs should update existing installations; production releases need a separately managed release key.
