import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

let recognizer: GestureRecognizer | null = null;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === "init") {
      const vision = await FilesetResolver.forVisionTasks(data.wasmRoot);
      recognizer = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: data.modelPath, delegate: "CPU" },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.65, minHandPresenceConfidence: 0.65, minTrackingConfidence: 0.65,
      });
      self.postMessage({ type: "ready" });
    } else if (data.type === "frame" && recognizer) {
      const bitmap = data.bitmap as ImageBitmap;
      try {
        const result = recognizer.recognizeForVideo(bitmap, data.timestamp);
        self.postMessage({ type: "result", landmarks: result.landmarks, gestures: result.gestures });
      } finally { bitmap.close(); }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Hand recognition failed." });
  }
};
