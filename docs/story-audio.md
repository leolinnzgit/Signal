# Listening to individual stories

Each news item has a speaker button labelled **Listen to this news**. It opens
Signal Reader and starts reading the extracted article. If the full text is
unavailable, Signal offers the headline and feed summary, or just the headline
when no summary was provided.

On PCs with browser speech support, article narration defaults to **Browser
voice**, using the same saved voice and speed preferences as headline playback.
The player supports Play/Pause, Stop, Previous/Next section, voice choice and
speaking speed. Closing the reader or changing the audio mode stops that player.
Long text is read in short chunks, with automatic English/Chinese voice selection.

Phones retain recorded audio as their default. Users can choose **Browser voice**
or **Recorded audio** in the reader. Recorded audio supports the existing
screen-off playback and device media controls.

Validate the client with `npm run iis:typecheck` and `npm run test:client`.
