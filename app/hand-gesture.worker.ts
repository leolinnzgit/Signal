import { FaceLandmarker, FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";

const EYE_LANDMARKS = [33, 133, 159, 145, 263, 362, 386, 374, 1];
let recognizer: GestureRecognizer | null = null;
let face: FaceLandmarker | null = null;
self.onmessage = async ({ data }: MessageEvent) => {
  try {
    if (data.type === "init") {
      recognizer = null;
      face = null;
      const vision = await FilesetResolver.forVisionTasks(data.wasmRoot);
      if (data.mode === "eyes") face = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: data.modelPath, delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 2, outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.4, minFacePresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      });
      else recognizer = await GestureRecognizer.createFromOptions(vision, {
        baseOptions: { modelAssetPath: data.modelPath, delegate: "CPU" },
        runningMode: "VIDEO", numHands: 2,
        minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4,
      });
      self.postMessage({ type: "ready" });
    } else if (data.type === "frame" && (recognizer || face)) {
      const bitmap = data.bitmap as ImageBitmap;
      try {
        if (face) {
          const result = face.detectForVideo(bitmap, data.timestamp);
          const scores = result.faceBlendshapes[0]?.categories;
          const landmarks = result.faceLandmarks[0];
          const points = landmarks
            ? EYE_LANDMARKS.map((index) => landmarks[index]).filter(Boolean).map(({ x, y }) => ({ x, y }))
            : undefined;
          const rightCheek = landmarks?.[234];
          const leftCheek = landmarks?.[454];
          const nose = landmarks?.[1];
          const faceWidth = rightCheek && leftCheek ? leftCheek.x - rightCheek.x : 0;
          const yaw = rightCheek && leftCheek && nose && faceWidth > 0.05
            ? ((rightCheek.x + leftCheek.x) / 2 - nose.x) / faceWidth
            : undefined;
          self.postMessage({ type: "result", timestamp: data.timestamp, eye: {
            faceCount: result.faceLandmarks.length,
            left: scores?.find((score) => score.categoryName === "eyeBlinkLeft")?.score,
            right: scores?.find((score) => score.categoryName === "eyeBlinkRight")?.score,
            yaw,
            points,
          } });
        } else if (recognizer) {
          const result = recognizer.recognizeForVideo(bitmap, data.timestamp);
          self.postMessage({ type: "result", landmarks: result.landmarks, gestures: result.gestures, timestamp: data.timestamp });
        }
      } finally { bitmap.close(); }
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Hand recognition failed." });
  }
};
