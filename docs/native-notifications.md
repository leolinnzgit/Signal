# Native Signal notifications

The Android phone companion receives Firebase Cloud Messaging data messages and keeps a native notification on the phone. It requests a native SignalWatch notification through the signed Wear OS data layer. Only a watch display acknowledgement makes that phone alert local-only. Without SignalWatch, or when it cannot acknowledge, normal phone forwarding remains available under the user's Wear OS notification settings.

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

Publish the additive server schema before distributing the new apps. Phone and Wear OS bundles share the package/signing certificate, use distinct version codes, and go to their respective Play form-factor tracks. A sideload signed with the upload key cannot communicate over the data layer with a Play-signed installation. Never upload the phone bundle to the Wear OS track.

## Delivery and fallback

Browser approval links only the current browser's existing push endpoint after checking account ownership. Linking a watch code cannot bind a browser endpoint. The companion registers after approval and notification permission. Native registrations expire after seven days and renew when enabled, when permitted messages arrive, or through daily WorkManager lease maintenance. Maintenance does not poll for news or deliver notifications. Android may delay it; the browser remains the fallback if a lease expires.

Each news refresh sends one native briefing. The server waits at most twelve seconds for the phone's display receipt before retaining the linked browser delivery. FCM acceptance by itself never suppresses a browser notification. Invalid/uninstalled tokens are removed. Receipt checks bind the unpredictable delivery ID to both account and installation; late messages are rejected after fallback. Other browsers, phones and earthquake/disaster subscriptions retain existing paths.

Watch handover requires a nearby connected matching app, matching account and HTTPS server, a non-expired locally verified sign-in, opt-in and notification permission. The watch acknowledges only after posting. A timeout leaves the phone alert eligible for forwarding. Android/network delivery is best effort and acknowledgement races can produce duplicates; the fallback favors retaining alerts. There is no global browser-notification suppression, watch notification cancellation or unconditional no-bridging manifest flag.

Uninstalling the phone companion restores browser delivery on the next attempted message, including when FCM has not yet invalidated the token. Disabling/signing out unregisters immediately when connected. Browser notifications must remain subscribed for browser fallback. This change adds native **news** notifications; it does not move the existing location-based disaster delivery to the watch.

## Checks before activation

Server checks cover endpoint/account ownership, missing configuration, receipts, invalid token removal, registration expiry and fallback. Android checks cover message/account/origin validation, compilation, unit tests and lint; release scripts verify signatures, bundle structure and private-file exclusion. Physical-device checks still require the paired phone/watch: permit/deny notifications, matching/different accounts, watch absent/uninstalled, disconnect/reconnect, phone companion uninstall and a real test push. These checks require live Firebase configuration and both signed apps; a successful build alone does not prove background delivery.
