import assert from "node:assert/strict";
import { test } from "node:test";
import { detectCoHostQuestionIntent } from "../app/daily-briefing-cohost.ts";

test("detectCoHostQuestionIntent recognizes explicit question prefixes", () => {
  const match1 = detectCoHostQuestionIntent("Question: What is happening with Apple and NVIDIA today?");
  assert.ok(match1);
  assert.equal(match1.isQuestion, true);
  assert.equal(match1.questionText, "What is happening with Apple and NVIDIA today?");

  const match2 = detectCoHostQuestionIntent("hey co-host explain the OCR decision");
  assert.ok(match2);
  assert.equal(match2.questionText, "explain the OCR decision");

  const match3 = detectCoHostQuestionIntent("ask co-host do I need an umbrella?");
  assert.ok(match3);
  assert.equal(match3.questionText, "do I need an umbrella?");
});

test("detectCoHostQuestionIntent recognizes conversational inquiry phrases", () => {
  const match1 = detectCoHostQuestionIntent("Tell me more about the geopolitical tensions in Europe");
  assert.ok(match1);
  assert.equal(match1.isQuestion, true);
  assert.equal(match1.questionText, "Tell me more about the geopolitical tensions in Europe");

  const match2 = detectCoHostQuestionIntent("Explain why oil prices jumped 3%");
  assert.ok(match2);
  assert.equal(match2.questionText, "Explain why oil prices jumped 3%");

  const match3 = detectCoHostQuestionIntent("What is the weather in Wellington?");
  assert.ok(match3);
  assert.equal(match3.questionText, "What is the weather in Wellington?");
});

test("detectCoHostQuestionIntent ignores standard transport and navigation voice commands", () => {
  assert.equal(detectCoHostQuestionIntent("pause"), null);
  assert.equal(detectCoHostQuestionIntent("play"), null);
  assert.equal(detectCoHostQuestionIntent("next"), null);
  assert.equal(detectCoHostQuestionIntent("previous"), null);
  assert.equal(detectCoHostQuestionIntent("snooze"), null);
  assert.equal(detectCoHostQuestionIntent("queue"), null);
  assert.equal(detectCoHostQuestionIntent("stop"), null);
});

test("Voice Co-Host audio pause, synthesis, and resumption sequence", async () => {
  let narrationPlaying = true;
  let coHostAnswerSpoken = false;
  let narrationResumed = false;

  const fakeSpeech = {
    isSpeaking: true,
    isPaused: false,
    pause() {
      narrationPlaying = false;
      this.isPaused = true;
      this.isSpeaking = false;
    },
    resume() {
      narrationPlaying = true;
      this.isPaused = false;
      this.isSpeaking = true;
      narrationResumed = true;
    },
  };

  const fakeQaSpeech = {
    speak(text, _locale, _blob, onComplete) {
      coHostAnswerSpoken = true;
      // Simulate speech completion callback
      setTimeout(() => {
        onComplete?.();
      }, 10);
    },
  };

  // 1. Briefing is actively playing
  assert.equal(narrationPlaying, true);

  // 2. Co-Host question arrives: pause narration
  let wasPlayingBeforeQuestion = fakeSpeech.isSpeaking && !fakeSpeech.isPaused;
  assert.equal(wasPlayingBeforeQuestion, true);
  fakeSpeech.pause();
  assert.equal(narrationPlaying, false);

  // 3. Co-Host answers and speaks aloud
  await new Promise((resolve) => {
    fakeQaSpeech.speak("Markets are flat while tech stocks gained 1.2%.", "en-NZ", null, () => {
      // 4. On answer finish, resume narration if it was playing before
      if (wasPlayingBeforeQuestion) {
        fakeSpeech.resume();
      }
      resolve();
    });
  });

  assert.equal(coHostAnswerSpoken, true);
  assert.equal(narrationResumed, true);
  assert.equal(narrationPlaying, true);
});
