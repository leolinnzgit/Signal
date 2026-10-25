# Native Signal notifications

The Android phone companion receives Firebase Cloud Messaging data messages and keeps a native notification on the phone. It requests a native SignalWatch notification through the signed Wear OS data layer. A displayed watch notification or an intentional wrist-filter acknowledgement makes that phone alert local-only; the phone keeps its own alert. Without SignalWatch, or when it cannot acknowledge, normal phone forwarding remains available under the user's Wear OS notification settings.

## Server setup

Native delivery stays disabled until all `NativePush` settings are configured. Existing browser notifications continue while configuration is missing. The server uses the official Firebase Admin SDK and never sends the service-account credential to clients.

Create/register a Firebase Android app with package `nz.signal.watch` in the chosen project and enable the FCM HTTP v1 API. Download its `google-services.json` for the public Android options. Create a dedicated service account with the Firebase Cloud Messaging API Admin role (`roles/firebasecloudmessaging.admin`), and put its JSON credential in a protected server directory outside the website, repository and publication package. The IIS application identity needs read access only to that file. Do not commit or publish the credential.

Add these entries to the existing production configuration, preserving all other settings:

```json
{
  "NativePush": {
    "ProjectId": "Firebase project ID",
    "ApplicationId": "mobilesdk_app_id from the nz.signal.watch Android client",
    "SenderId": "project_info.project_number",
    "ApiKey": "current_key from that Android client",
    "ServiceAccountFile": "absolute path to the protected service-account JSON"
  }
}
```

The service-account project must match `ProjectId`. Restart the IIS application after configuring or rotating its Firebase project/credential. Native clients obtain only public Firebase Android options through authenticated `/api/native/config`. Restrict the Android API key to the required Firebase installation/messaging APIs and, where supported, the app package and Play signing certificate. No Firebase Authentication account or topic subscription is used; authenticated Signal device registrations route messages to individual tokens.

For the existing Windows IIS deployment, run the PowerShell 7 setup helper with the two downloaded files:

```powershell
./scripts/Configure-SignalNativePush.ps1 -GoogleServicesFile 'path/to/google-services.json' -ServiceAccountFile 'path/to/service-account.json'
```

The helper checks the Android package and matching projects, authenticates the key with Google, and validates an FCM request with `validate_only: true` before changing production settings. No notification is sent. `-ValidateOnly` runs these checks without installing files or changing configuration. Installation places the key and a production-settings backup in `C:\ProgramData\SignalNativePush`, outside the website and repository. Access is restricted to the current Windows user, Administrators, SYSTEM, and read/execute access for `IIS APPPOOL\SignalAppPool`. The helper preserves settings outside `NativePush` and restarts the application by touching `web.config`. It requires permission to manage that protected directory and the existing production settings.

The companion initializes Firebase from the authenticated server configuration, so supplying these options does not require rebuilding the existing Android bundles.

Publish the additive server schema before distributing the new apps. Phone and Wear OS bundles share the package/signing certificate, use distinct version codes, and go to their respective Play form-factor tracks. A sideload signed with the upload key cannot communicate over the data layer with a Play-signed installation. Never upload the phone bundle to the Wear OS track.

## Delivery and fallback

Browser approval links only the current browser's existing push endpoint after checking account ownership. Linking a watch code cannot bind a browser endpoint. The companion registers after approval and notification permission. Native registrations expire after seven days and renew when enabled, when permitted messages arrive, or through daily WorkManager lease maintenance. Maintenance does not poll for news or deliver notifications. Android may delay it; the browser remains the fallback if a lease expires.

Each news refresh sends one native briefing. The server waits at most twelve seconds for the phone's display receipt before retaining the linked browser delivery. FCM acceptance by itself never suppresses a browser notification. Invalid/uninstalled tokens are removed. Receipt checks bind the unpredictable delivery ID to both account and installation; late messages are rejected after fallback. Other browsers and phones retain existing paths. Disaster reports additionally reach only the native companion linked to the originating browser endpoint; browser disaster delivery remains active.

Watch handover requires a nearby connected matching app, matching account and HTTPS server, a non-expired locally verified sign-in, opt-in and notification permission. The watch returns a display acknowledgement only after posting. An intentional filter has a separate acknowledgement so phone forwarding cannot bypass wrist news preferences. A timeout leaves the phone alert eligible for forwarding. Android/network delivery is best effort and acknowledgement races can produce duplicates; the fallback favors retaining alerts. There is no global browser-notification suppression, watch notification cancellation or unconditional no-bridging manifest flag.

Watch 0.10.0 (16) adds a red disaster warning when the app is resumed, with an encrypted local acknowledgement and automatic narration pause. Background watch disaster notifications use a warning icon, View alert action and a three-pulse vibration when allowed. A migrated channel preserves existing importance, sound and disabled-vibration choices. Foreground warnings require a recent unacknowledged report, the active account/server and the existing notification/disaster opt-ins. They do not launch the app in the background, bypass Do Not Disturb or guarantee screen wake-up. The existing companion 0.8.0 (12) supports this watch-only update.

Uninstalling the phone companion restores browser delivery on the next attempted message, including when FCM has not yet invalidated the token. Disabling/signing out unregisters immediately when connected. Browser notifications must remain subscribed for browser fallback. Version 0.8.0 adds selective wrist news and opt-in disaster handover. Configure news topics/keywords in Watch alerts; quiet hours and daily quotas stay on that watch. Disasters bypass news limits and use the hazard types, radius, severity and last location already configured in the originating phone browser. That location must be refreshed at least daily. Neither native app requests GPS. Keep the browser disaster subscription enabled, and explicitly opt in on the watch. Reports can be delayed or incomplete; follow local authorities.

## Checks before activation

Server checks cover endpoint/account ownership, missing configuration, receipts, invalid token removal, registration expiry and fallback. Android checks cover message/account/origin validation, compilation, unit tests and lint; release scripts verify signatures, bundle structure and private-file exclusion. Physical-device checks still require the paired phone/watch: permit/deny notifications, matching/different accounts, watch absent/uninstalled, disconnect/reconnect, phone companion uninstall and a real test push. These checks require live Firebase configuration and both signed apps; a successful build alone does not prove background delivery.

## Live activation status for this release

At publication preparation on 24 October 2026, the default server reports `/api/native/status` as `{ "ready": false }` and has no production `NativePush` configuration. The checked apps and server implementation can be published, but native news/disaster delivery cannot be claimed active until the Firebase configuration above is supplied and a real paired-device test succeeds. Voice search and the briefing tile do not require Firebase.

On 25 October 2026, production was configured for Firebase project `signal-73617` using the registered `nz.signal.watch` Android app and the supplied service-account key. Google authentication and the FCM dry-run passed without sending a notification. Local and public `/api/native/status` returned `{ "ready": true }`, the public home page returned HTTP 200, key permissions were verified, and all unrelated production settings were preserved. This verifies server configuration and FCM access; actual phone/watch delivery still requires enabling notifications in the companion and watch and completing a real paired-device test. Existing browser fallback remains enabled.
