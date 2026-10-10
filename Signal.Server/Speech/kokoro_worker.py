"""Private, offline CPU worker. JSON lines in; framed PCM clips out."""
import argparse
import contextlib
import json
import itertools
import logging
import re
import struct
import sys
from pathlib import Path


def set_priority(clips):
    # The venv executable launches another Python process on Windows. Set priority
    # inside inference itself, using its own process handle rather than the launcher.
    if sys.platform != "win32": return
    import ctypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    kernel.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    background = isinstance(clips, list) and clips and clips[0].get("Background", False) is True
    if not kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000 if background else 0x20):
        raise ctypes.WinError(ctypes.get_last_error())


def load_model(root, threads):
    import numpy as np
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    from misaki import zh
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    model = Kokoro.from_session(ort.InferenceSession(str(root / "kokoro-v1.0.onnx"), sess_options=options, providers=["CPUExecutionProvider"]), str(root / "voices-v1.0.bin"))
    # Mandarin v1.0 phonemes match this model. Handle embedded English explicitly.
    return model, zh.ZHG2P(), np


def phonemes_for_chinese(text, model, chinese):
    parts = re.split(r"([A-Za-z][A-Za-z '\-]*)", text)
    return " ".join(model.tokenizer.phonemize(part, lang="en-us") if re.search(r"[A-Za-z]", part) else chinese(part)[0] for part in parts if part.strip())


def render(clips, model, chinese, np):
    from scipy.signal import resample_poly
    if not isinstance(clips, list) or not 1 <= len(clips) <= 50:
        raise ValueError("Invalid clip batch")
    if sum(len(clip.get("Text", "")) for clip in clips) > 4000:
        raise ValueError("Clip batch is too long")
    audio_clips = []
    for clip in clips:
        voice, text = clip["Voice"], clip["Text"]
        if voice not in model.get_voices() or voice[0] not in "abz" or not isinstance(text, str) or not 1 <= len(text) <= 1001:
            raise ValueError("Invalid voice or narration text")
        is_chinese = voice.startswith("z")
        value = phonemes_for_chinese(text, model, chinese) if is_chinese else text
        if not value.strip(): raise ValueError("No readable phonemes")
        audio, rate = model.create(value, voice=voice, speed=1.0, lang="en-gb" if voice.startswith("b") else "en-us", is_phonemes=is_chinese)
        if rate != 24000 or not np.isfinite(audio).all(): raise ValueError("Invalid model output")
        samples = np.rint(np.clip(resample_poly(audio, 2, 3), -1, 1) * 32767).astype("<i2")
        if not samples.size or not np.any(samples) or samples.nbytes > 8 * 1024 * 1024: raise ValueError("Missing or oversized narration")
        audio_clips.append(samples.tobytes())
    return audio_clips


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4, choices=range(1, 5))
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    output = sys.stdout.buffer
    first_line = sys.stdin.readline()
    if not first_line: return
    if len(first_line) > 150000: raise ValueError("Request too large")
    set_priority(json.loads(first_line))
    # Library diagnostics must never corrupt the binary stdout protocol.
    with contextlib.redirect_stdout(sys.stderr):
        logging.getLogger("jieba").setLevel(logging.ERROR)
        model, chinese, np = load_model(args.root, args.threads)
    for line in itertools.chain((first_line,), sys.stdin):
        if len(line) > 150000: raise ValueError("Request too large")
        clips = json.loads(line)
        set_priority(clips)
        with contextlib.redirect_stdout(sys.stderr):
            audio = render(clips, model, chinese, np)
        lengths = json.dumps([len(clip) for clip in audio]).encode("utf-8")
        output.write(struct.pack("<I", len(lengths)))
        output.write(lengths)
        for clip in audio: output.write(clip)
        output.flush()


if __name__ == "__main__":
    main()
