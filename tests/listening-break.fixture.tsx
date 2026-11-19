import { createRoot } from "react-dom/client";
import ListeningBreak from "../app/ListeningBreak";
import { cancelListeningSpeech, createListeningAudio, speakListeningSpeech } from "../app/listening-break";

let interrupted = 0;
const engine = {
  speak(utterance: SpeechSynthesisUtterance) { utterance.dispatchEvent(new Event("start")); },
  cancel() {},
} as unknown as SpeechSynthesis;

Object.assign(window, {
  testListening: {
    createAudio: createListeningAudio,
    speak: () => speakListeningSpeech(new SpeechSynthesisUtterance("Test"), () => { interrupted++; }, engine),
    cancelSpeech: () => cancelListeningSpeech(engine),
    interruptions: () => interrupted,
  },
});

createRoot(document.querySelector("#root")!).render(<ListeningBreak />);
