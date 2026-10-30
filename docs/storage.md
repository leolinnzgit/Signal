# Disk storage

Azure is the primary speech source. Recorded audio is deduplicated by text and
voice, so repeated headlines, article sections and listeners reuse the same clips.
The clip cache in `App_Data/HeadlineAudioClips` has a 256 MiB limit and seven-day
lifetime. Clips use lossless Brotli compression when it makes the file smaller;
playback restores the exact PCM samples and timestamps. Existing raw clips are
compacted automatically at startup without extending their expiry. Atomic writes
and PCM length/checksum validation protect playback during migration.

Shared-story audio already uses MP3. Its separate `App_Data/SharedArticleAudio`
cache is limited to 128 MiB and 30 days. Eviction removes recordings, while saved
stories and translations stay in the database; listening again regenerates the
MP3. Hourly maintenance enforces both caches' limits even when no one plays audio
and removes abandoned audio temporary files older than a day.

Routine publication creates compressed, SQLite-consistent backups in
`C:\sites\SignalHost\App_Data\backups` as `.db.zip` archives and retains
the latest seven (recognizing both ZIP and legacy uncompressed snapshots).
Each ZIP contains a transactionally consistent SQLite database snapshot whose
compression is verified against the original using SHA-256 before the uncompressed
snapshot is removed. To restore a backup, extract the `.db` file to a staging directory,
validate it with SQLite `PRAGMA quick_check`, and restore it as `signal.db` while IIS
is offline. For full-system disaster recovery, `New-SignalDisasterRecoveryBackup.ps1`
creates AES-256 encrypted 7-Zip archives of the entire `App_Data` folder.
Production settings, saved articles, and application data are
preserved. The IIS build stages a fresh Windows x64 package to exclude native
libraries for other operating systems. Deployment removes only known obsolete
runtime folders that the current package and dependency manifest do not use.
Obsolete generated frontend bundles are removed after a seven-day grace period;
the current package's assets are always retained.

## Development checkout

The development folder can accumulate several GiB of old release copies, probe
builds and .NET output. Preview the cleanup with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Clear-SignalBuildArtifacts.ps1 -IncludeReleaseCopies -WhatIf
```

Remove `-WhatIf` to delete those generated files after builds and deployments
have finished. Release copies and source archives are removed only when their
commit is already in the current Git history. Junctions to the shared
`node_modules` are removed without following them. Unexpected links, tracked
files, databases, patches and Git backups block cleanup.

The script preserves installed dependencies, the current `iis-publish` package,
local `App_Data`, operational scripts and work in progress. The next build
recreates the deleted output. The deployed IIS application is outside the
checkout and is unaffected by this cleanup.

Add `-IncludeStagingBuildArtifacts` to include .NET `bin`/`obj` output in known
reader probe and release staging folders, plus old Vite caches. Source files and
deployment snapshots in those folders remain intact, even when the folder name
does not identify a recoverable Git commit.

### SignalWatch build staging

After Android builds and Gradle daemons have stopped, add
`-IncludeWatchBuildArtifacts` to preview or remove the Signal checkout's temporary
SignalWatch staging build, project caches, Gradle 8.11.1 transform/build caches,
and downloaded SDK/Gradle installer ZIPs. Use `-WhatIf` first. The next build
recreates these caches; it may take longer.

The installed Android SDK, Gradle distribution, bundletool, and downloaded Gradle
dependencies remain available. The sibling `SignalWatch` project, its checked
APK/AAB releases, signing keys and credentials are preserved. Signing files and
`App_Data` directories also block cleanup if found inside a deletion candidate.

## Weekly automatic cleanup

Install or update the Windows task on the IIS host:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Install-SignalWeeklyCleanup.ps1
```

`Signal Weekly Cleanup` runs every Sunday at 03:00 in the host's local time
(New Zealand time on this installation). It runs as SYSTEM without requiring a
login, catches up after a missed schedule, and prevents overlapping runs. Failed
runs retry twice at 30-minute intervals. The installed runner is an
administrator-owned copy under `C:\ProgramData\SignalWeeklyCleanup`; reinstall
after changing its source.

It discovers .NET and Android build output in Signal, staging source copies and
the sibling SignalWatch/Companion project, and clears Vite and Gradle version
caches. Only generated files untouched for at least 48 hours are eligible;
both creation and modification times are checked so freshly copied files stay.
Active .NET/Java/Node builds, publication scripts and IIS maintenance cause it to
skip cleanup. Unavailable process or Git inspection stops cleanup. It rechecks
activity, file age and protected content before each deletion.

Tracked files, configuration, databases, patches, signing material, links,
`App_Data`, installed dependencies/tools, releases, backups and the current
`iis-publish` package are retained. Compiled siblings of protected data may still
be cleaned. Source checkouts with their own Git repository are not traversed.
The running IIS application is outside the cleanup scope.

Preview without deleting files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Invoke-SignalWeeklyCleanup.ps1 -WhatIf -StateDirectory work/weekly-cleanup-preview
```

`C:\ProgramData\SignalWeeklyCleanup\latest.json` records the latest result,
removed bytes/paths, skipped paths and errors. The latest 12 run logs are kept.
To disable or remove scheduling, use `Disable-ScheduledTask` or
`Unregister-ScheduledTask` with `-TaskName 'Signal Weekly Cleanup'`.

Run its isolated safety tests with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/weekly-cleanup.test.ps1
```
