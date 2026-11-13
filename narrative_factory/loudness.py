"""Final-pass audio helpers: EBU R128 gain to -14 LUFS with a -1.5 dBFS limiter, and the tight-end cut."""

import json
import math
import re
import subprocess

from logs import get_logger

log = get_logger("loudness")

TARGET_LUFS = -14.0
TRUE_PEAK_DBFS = -1.5
TRUE_PEAK_LINEAR = 10 ** (TRUE_PEAK_DBFS / 20)
MEASURE_FILTER = "loudnorm=print_format=json"
# Oversample so the limiter sees inter-sample peaks, then return to the editor's 44.1 kHz output.
LIMITER = (f"aresample=192000,alimiter=limit={TRUE_PEAK_LINEAR:.4f}:level=false:latency=true:attack=5:release=50,"
           "aresample=44100")


def build_measure_cmd(ffmpeg_exe, path):
    return [ffmpeg_exe, "-hide_banner", "-nostats", "-i", str(path), "-vn",
            "-af", MEASURE_FILTER, "-f", "null", "-"]


def parse_loudnorm_json(stderr):
    blocks = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.S)
    if not blocks:
        raise ValueError("loudnorm measurement missing from ffmpeg output")
    data = json.loads(blocks[-1])
    return {key: float(data[key]) for key in
            ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}


def gain_db(measured):
    """Linear gain that moves the measured integrated loudness onto the target."""
    return TARGET_LUFS - measured["input_i"]


def build_filter(measured):
    if not all(math.isfinite(measured[k]) for k in ("input_i", "input_tp", "input_lra", "input_thresh")):
        return None
    if measured["input_i"] <= -70.0:
        return None
    return f"volume={gain_db(measured):.2f}dB,{LIMITER}"


def measure(ffmpeg_exe, path):
    res = subprocess.run(build_measure_cmd(ffmpeg_exe, path), capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"loudness measurement failed: {res.stderr.strip()[-500:]}")
    return parse_loudnorm_json(res.stderr)


def audio_filter(ffmpeg_exe, path):
    """The gain+limiter filter, or None when measurement fails (the render still succeeds)."""
    try:
        measured = measure(ffmpeg_exe, path)
    except Exception as e:
        log.warning(f"Loudness measurement failed for {path} ({e}); skipping normalisation.")
        return None
    filter_str = build_filter(measured)
    if filter_str:
        log.info(f"Loudness: {measured['input_i']:.1f} LUFS / {measured['input_tp']:.1f} dBFS true peak "
                 f"-> {gain_db(measured):+.1f} dB, peaks limited to {TRUE_PEAK_DBFS:g} dBFS.")
    return filter_str


def tight_end_cap(words, audio_duration, hold=0.3):
    """Output length for the tight-end cut: `hold` seconds past the last word, or None when nothing is trimmed."""
    if not words:
        return None
    cap = words[-1]["end"] + hold
    return cap if cap < audio_duration else None
