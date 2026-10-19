# Hosted story sharing

Open a story in Signal Reader, translate it if desired, then select **Share**.
Signal saves the title and paragraphs currently displayed. **Copy link** copies
the hosted page URL; **Preview shared page** opens the saved version. The news
feed's Share button creates a page in the article's original language.

Anyone with the link can read the page without a Signal account. Shared pages
use random URLs and ask search engines not to index them. The page includes the
publisher's name and a link to the original reporting.

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

The saved translation remains in the language chosen when sharing. Sharing a
different language creates another page. Re-sharing a story in the same language
reuses its existing link and preserves a previously saved full reading view.
If the existing page contains only a feed summary, sharing again retries extraction
or uses the current reader snapshot. When full text is available, Signal upgrades
that page in place, retaining its URL, creation date and discussion. Failed retries
leave the summary available.

If the publisher does not expose full text, Signal saves a clearly labelled
headline and feed summary, with a link to the full article. Shared pages remain
in the Signal database independently of feed history retention and survive
normal IIS publication, which preserves `App_Data`.

The authenticated, CSRF-protected `POST /api/article-shares` endpoint saves
bounded text snapshots. `GET /shared/{id}` renders the saved page anonymously,
with escaped text, a restrictive content security policy, and link-preview
metadata. Signal friends and offline notification emails receive this hosted
page link through the existing sharing flow.
