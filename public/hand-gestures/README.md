# Hand and eye recognition assets

These files are served by Signal, so camera frames never need to leave the device.
The camera and worker are started only by the Hand gestures controls.

- `v1/gesture-recognizer.bin`: Google's MediaPipe Gesture Recognizer float16 model,
  model version 1, downloaded from
  https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
  (`.bin` allows the existing ASP.NET static file middleware to serve it).
- `v1/face-landmarker.bin`: Google's MediaPipe Face Landmarker float16 model,
  version 1, downloaded without modification from
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
  SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
  The `.bin` extension permits serving through the existing static file middleware.
- `v1/vision_wasm*.js` and `v1/vision_wasm*.wasm`: copied without modification
  from the Apache-2.0 `@mediapipe/tasks-vision` npm package, version 0.10.32.
  Both SIMD and non-SIMD variants are needed for browser feature detection.

When upgrading, use a new asset directory and update the URL in
`app/HandGestureControls.tsx`. Keep the package and WASM versions identical.
See https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer
and the included Apache license.

## Supported gestures and actions

Camera processing runs entirely on-device inside a web worker using WebAssembly and WebGL. Video frames never leave the device.

### Eye and head gestures (Face Landmarker)

- **Head nod (up/down)**: Toggles play or pause during audio playback.
- **Head turn (left/right)**: Moves to the previous (left) or next (right) topic, headline, or story.
- **Eye wink (left/right)**: Right wink navigates next; left wink navigates previous. Adapts to individual baseline eye geometry.
- **Deliberate long blink**: Advances to the next topic in the feed, or pauses/resumes playback when a player or reader is active. Involuntary blinks are filtered out.

### Hand gestures (Gesture Recognizer)

- **Swipe left/right**: Next or previous topic, headline, or story.
- **Move up/down**: Scroll reading views smoothly.
- **Steady palm hold**: Pauses audio playback or reading.
- **Fist hold**: Resumes playback.
- **Thumbs-up hold**: Bookmarks the current story.
- **Point and pinch**: Outlines buttons or stories with an on-screen tracking cursor; pinch thumb and index finger together to click.

### Controls

- **Floating button**: Tapping the floating camera button directly toggles gesture detection on or off.
- **Guide and practice mode**: Open the guide to view live landmark tracking and test gestures in practice mode without affecting the app.
- **Hide preview**: The camera preview monitor can be hidden to save screen space while keeping hands-free recognition active.
