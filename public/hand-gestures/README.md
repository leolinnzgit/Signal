# Hand recognition assets

These files are served by Signal, so camera frames never need to leave the device.
The camera and worker are started only by the Hand gestures controls.

- `v1/gesture-recognizer.bin`: Google's MediaPipe Gesture Recognizer float16 model,
  model version 1, downloaded from
  https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task
  (`.bin` allows the existing ASP.NET static file middleware to serve it).
- `v1/vision_wasm*.js` and `v1/vision_wasm*.wasm`: copied without modification
  from the Apache-2.0 `@mediapipe/tasks-vision` npm package, version 0.10.32.
  Both SIMD and non-SIMD variants are needed for browser feature detection.

When upgrading, use a new asset directory and update the URL in
`app/HandGestureControls.tsx`. Keep the package and WASM versions identical.
See https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer
and the included Apache license.
