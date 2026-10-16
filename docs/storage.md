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

Routine publication creates compressed, SQLite-consistent backups and retains
the latest seven. Production settings, saved articles, and application data are
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
