import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVoiceQuery,
  parseVoiceCommand,
  downsampleFloat32Buffer,
  encodePcm16Wav,
  transcribeWavAudio,
} from "../app/voice-input.ts";

test("normalizeVoiceQuery trims trailing dictation punctuation and collapses whitespace", () => {
  assert.equal(normalizeVoiceQuery('  "Renewable   energy."  '), "Renewable energy");
  assert.equal(normalizeVoiceQuery("Wellington earthquake?!"), "Wellington earthquake");
  assert.equal(normalizeVoiceQuery("   "), "");
});

test("parseVoiceCommand detects all-topics, follow, filter, search, and plain query intents", () => {
  assert.deepEqual(parseVoiceCommand("Show all topics."), {
    intent: "all-topics",
    query: "",
    raw: "Show all topics",
  });

  assert.deepEqual(parseVoiceCommand("Follow Rocket Lab."), {
    intent: "follow",
    query: "Rocket Lab",
    raw: "Follow Rocket Lab",
  });

  assert.deepEqual(parseVoiceCommand("Filter by Christopher Luxon!"), {
    intent: "filter",
    query: "Christopher Luxon",
    raw: "Filter by Christopher Luxon",
  });

  assert.deepEqual(parseVoiceCommand("Search for geothermal power?"), {
    intent: "search",
    query: "geothermal power",
    raw: "Search for geothermal power",
  });

  assert.deepEqual(parseVoiceCommand("Auckland transport"), {
    intent: "query",
    query: "Auckland transport",
    raw: "Auckland transport",
  });
});

test("downsampleFloat32Buffer downsamples 48 kHz mono PCM to 16 kHz accurately", () => {
  const input = new Float32Array(480);
  for (let i = 0; i < input.length; i++) {
    input[i] = i < 240 ? 0.6 : -0.3;
  }

  const downsampled = downsampleFloat32Buffer(input, 48000, 16000);
  assert.equal(downsampled.length, 160);
  assert.ok(Math.abs(downsampled[0] - 0.6) < 0.001);
  assert.ok(Math.abs(downsampled[159] + 0.3) < 0.001);

  assert.equal(downsampleFloat32Buffer(new Float32Array(0), 48000, 16000).length, 0);
});

test("encodePcm16Wav produces a valid 44-byte RIFF/WAVE PCM16 header with clamped samples", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1.8, -1.8]);
  const wav = encodePcm16Wav(samples, 16000);

  assert.equal(wav.byteLength, 44 + samples.length * 2);

  const ascii = (start, len) =>
    String.fromCharCode(...Array.from(wav.subarray(start, start + len)));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(ascii(36, 4), "data");

  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // Mono
  assert.equal(view.getUint32(24, true), 16000); // Sample rate
  assert.equal(view.getUint16(34, true), 16); // 16-bit
  assert.equal(view.getUint32(40, true), samples.length * 2);

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), Math.round(0.5 * 0x7fff));
  assert.equal(view.getInt16(48, true), Math.round(-0.5 * 0x8000));
  assert.equal(view.getInt16(50, true), 0x7fff);
  assert.equal(view.getInt16(52, true), -0x8000);
});

test("transcribeWavAudio rejects undersized buffers and posts WAV audio with CSRF token", async () => {
  const shortRes = await transcribeWavAudio(new Uint8Array(12));
  assert.equal(shortRes.available, false);

  const validWav = encodePcm16Wav(new Float32Array(320), 16000);
  let postedUrl = "";
  let postedHeaders = {};
  let postedBytes = 0;

  const mockFetcher = async (url, init) => {
    if (url.includes("/api/auth/csrf")) {
      return { ok: true, json: async () => ({ token: "voice-csrf-123" }) };
    }
    postedUrl = url;
    postedHeaders = init.headers;
    postedBytes = init.body.byteLength;
    return {
      ok: true,
      json: async () => ({
        available: true,
        text: "Search for renewable energy.",
        status: "Success",
        reason: "",
      }),
    };
  };

  const res = await transcribeWavAudio(validWav, "en-NZ", mockFetcher);
  assert.equal(res.available, true);
  assert.equal(res.text, "Search for renewable energy.");
  assert.equal(postedUrl, "/api/voice-search/transcribe?language=en-NZ");
  assert.equal(postedHeaders["X-XSRF-TOKEN"], "voice-csrf-123");
  assert.ok(postedHeaders["Content-Type"].includes("audio/wav"));
  assert.equal(postedBytes, validWav.byteLength);
});
