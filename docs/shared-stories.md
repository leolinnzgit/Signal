# Hosted story sharing

Open a story in Signal Reader, translate it if desired, then select **Share**.
Signal saves the title and paragraphs currently displayed. The share dialog provides
an inline **Copy link** button right next to the generated story link with copy status feedback,
and a **Preview shared page** link to open the saved version. The news feed's Share button
creates a page in the article's original language.

Anyone with the link can read the page without a Signal account. Shared pages
use random URLs and ask search engines not to index them. The page includes the
publisher's name and a link to the original reporting.

## Audio playback

Select **Play audio** to hear the saved title and full text with Azure narration.
Recipients do not need to sign in. Audio uses a voice matching the translation
language, streams into the native audio player, and supports pause and replay.
Listeners can select another available voice in the saved story's language.
The title or paragraph currently being read is highlighted using Azure narration
bookmarks, including when seeking or replaying. Changing voices during playback
restarts the story in the selected voice; paused listeners press Play audio to start.
Completed MP3 recordings are cached in `App_Data/SharedArticleAudio` and support
seeking on subsequent plays. Audio starts only when the listener presses Play.
The MP3 cache is limited to 128 MiB and 30 days. Evicted audio can be regenerated;
saved shared stories and translations remain available. See [disk storage](storage.md).
Each voice has its own recording and a small timing file that survives restarts
and is removed with its recording.
The server must have Azure Speech configured through the existing Speech settings.

## Comments and story discussions

Shared stories include an interactive discussion thread directly below the article:

- **Anonymous and guest comments**: Anyone reading the shared story can participate in
  the discussion without needing an account. Commenters can post anonymously or provide an
  optional guest display name.
- **Threaded replies**: Readers can reply directly to existing comments to maintain clear,
  threaded conversations.
- **Signal integration**: For signed-in users on the main Signal site, discussions on shared
  stories are linked directly to the corresponding story in Signal Reader, keeping commentary
  synchronized between private feed reading and public sharing.

## Preserving URLs and in-place upgrades

The saved translation remains in the language chosen when sharing. Sharing a
different language creates another page. Re-sharing a story in the same language
reuses its existing link and preserves a previously saved full reading view.

If the publisher initially blocked or restricted extraction, Signal saves a clearly labelled
headline and feed summary with a link to the full article. When the story is re-shared or opened
again after full article text becomes available, Signal automatically upgrades that shared page
in place to the complete article view. The original URL, creation date, and entire discussion
history are preserved during the upgrade. Failed retries safely leave the existing summary available.

Shared pages remain in the Signal database independently of feed history retention and survive
normal IIS publication, which preserves `App_Data`.

The authenticated, CSRF-protected `POST /api/article-shares` endpoint saves
bounded text snapshots. `GET /shared/{id}` renders the saved page anonymously,
with escaped text, a restrictive content security policy, and link-preview
metadata. Signal friends and offline notification emails receive this hosted
page link through the existing sharing flow.
