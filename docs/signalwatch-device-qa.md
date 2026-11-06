# SignalWatch physical-device QA

Every SignalWatch release so far (up to 0.23.0 (36)) has been checked only with JVM tests, lint, bundle/signature checks and the browser preview. No release has been run on a real watch through ADB. This checklist covers the behaviour those checks cannot show. Record results in the table at the end and keep the evidence folder from the script.

## Setup

1. Enable developer options on both devices. On the watch: Settings › System › About › tap **Build number** seven times, then turn on **ADB debugging** and **Wireless debugging**. The phone can use USB.
2. From `../SignalWatch`, pair and connect, then collect a baseline:

   ```powershell
   ./scripts/Invoke-DeviceQa.ps1 -Pair <watch-ip:pair-port> -PairingCode <code> -Connect <watch-ip:port> -Screenshot
   ```

3. To install the checked builds (SHA-256 verified against `release-manifest.json`), add `-InstallWatch` and/or `-InstallPhone`. A copy signed with a different key (debug or Play) must be uninstalled first. Uninstalling removes its sign-in and downloads.
4. For each section below, start a capture window, then do the steps: `./scripts/Invoke-DeviceQa.ps1 -LogSeconds 300 -Screenshot`. Evidence goes to `outputs/device-qa/<time>/`, which Git ignores. Check logs for personal data before sharing them.

## 1. Notifications and phone-to-watch handover (highest priority)

A report from the owner suggests the watch may still be showing the phone's own notification. The intended behaviour is: the companion hands the alert to SignalWatch, the watch posts its native alert with **Listen / Save / Mark read**, and the phone posts its copy with `localOnly=true` so Wear OS does not mirror it.

- [ ] Companion: notifications enabled and linked to the browser. Watch: same account, **Watch alerts** on, notification permission granted.
- [ ] Trigger a news refresh with new stories. Watch shows **one** Signal alert with Listen / Save / Mark read. No second "phone" copy appears.
- [ ] In the script output, the phone's Signal notification shows `localOnly=True`. If it shows `False`, the handover failed or timed out (see below).
- [ ] Check for a mirrored **browser** (Chrome) notification for the same story. The server is supposed to drop browser delivery for the linked browser when the companion confirms display within 12 seconds.
- [ ] Wrist filter: add a keyword that excludes the story. The watch shows nothing, and the phone copy is still `localOnly=True`.
- [ ] Watch out of Bluetooth range or app signed out: the phone alert is mirrored (expected fallback).
- [ ] Note how many Wear OS nodes the phone has (`*-wearable.txt`). The companion currently hands over only when **exactly one** nearby node is connected.
- [ ] Disaster alert: three-pulse vibration, **View alert**, red foreground warning while the app is open, Acknowledge/Back/swipe return to the previous screen without restarting audio.

## 2. Playback with the screen off

- [ ] Briefing, Catch me up, full story and Listen later each continue with the screen off and after switching apps. The media notification controls work.
- [ ] Bluetooth headphones: disconnecting pauses playback. Audio focus loss (alarm or call) pauses. Volume buttons change the media level while paused without starting audio.
- [ ] Pausing for five minutes stops the service and keeps the saved section. Process kill and reboot never restart sound on their own.
- [ ] Sleep timer: 15 minutes with the screen off pauses at expiry. Finish current story stops at the story boundary.

## 3. Resume, queues and handoff

- [ ] Resume saved story after closing the app, after the idle timeout and after a reboot starts at the saved section only after a tap.
- [ ] Listen later: add on phone, open the watch, the queue matches. Reorder or remove on the phone while the watch is playing; changes apply on the next start.
- [ ] Continue on phone (watch → phone) and Continue on watch (phone → watch), for both a single story and the full queue. Keep both apps open. Cancel and expiry never start audio.
- [ ] Shared Resume: stop on one device, resume on the other at the same section.

## 4. Offline and downloads

- [ ] Download the queue on Wi-Fi, enable airplane mode, restart the app: recorded audio plays from the saved section. Removing a story removes its audio.
- [ ] Automatic downloads: on the charger and Wi-Fi, a queue addition downloads without opening the app (Android may delay this by 15 minutes or more). The progress notification has Cancel.
- [ ] Read, bookmark and unbookmark offline, then reconnect: the phone shows the final states. Process death after a queued change loses nothing.

## 5. Tiles, complication and layout

- [ ] Signal briefing and Signal Listen later tiles: add them, check the round-screen layout, Resume/Catch up/Play queue taps, offline counts.
- [ ] Signal unread complication in short and long slots: tap opens, count updates after reading, cleared on sign-out.
- [ ] Rotary scrolling, swipe-back, text clipping on the smallest available watch size, ambient mode.
- [ ] Seasonal theme matches the date (standard in November until 1 December).

## 6. Accounts

- [ ] Sign out, then pair a different account: old downloads, queue, catch-up, tiles and complication content disappear and audio stops.
- [ ] Phone-approved sign-in rejects expired and unknown codes.

## 7. Google Play internal testing

This needs the owner's Play Console account; agents can't upload. Follow `../SignalWatch/play-store/upload-checklist.md`. Upload the newest checked AAB from `../SignalWatch/outputs/play-release/` to the Wear OS internal track, add the watch's Google account as a tester, install from the watch Play Store and repeat section 1. A Play-signed install can't exchange data-layer messages with a directly installed, upload-key-signed companion. Install both from Play or both directly.

## Results

| Date | Watch model / build | Phone / companion build | Section | Result | Evidence folder / notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
