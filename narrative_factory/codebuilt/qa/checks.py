"""Non-frame checks for the QA gate (CB12 / KAN-921): file probe, subtitles, subject in frame, stem loudness.

Every check returns a list of findings, each {"code": named reason, "detail": short text}; an empty list is a pass. Reused, not rewritten:
the probe and path guards are the post kit's (post/media.py), the subtitle checker is post/subtitles.check_srt, the loudness measure and
the targets are the audio kit's (blender_worker/codebuilt/audio.py, CB3) and the zone rule is CB1's framing.in_zone.
"""
import json
import math
import subprocess
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

from blender_worker.codebuilt import audio, framing

from narrative_factory.codebuilt.post import media, subtitles

EXPECTED = {"width": 1080, "height": 1920, "fps": 30.0, "duration": None}
SUBJECT_MIN_WIDTH = 0.15      # subject narrower than this share of the frame width is too small to read
SUBJECT_MAX_WIDTH = 1.0       # wider than the frame means it is cropped
MUSIC_TOLERANCE_DB = 2.0      # QA band around the 18 dB target (wider than the mixer's own +/-1: the two level bases differ by up to 3 dB)
EFFECTS_TOLERANCE_DB = audio.TOLERANCE_DB
SILENT_PEAK = 1e-3


def finding(code, detail):
    return {"code": code, "detail": detail}


# ---------- file probe ----------
def probe_findings(info, expected=None):
    want = {**EXPECTED, **(expected or {})}
    out = []
    if not info["has_video"]:
        out.append(finding("probe_no_video", "no video stream"))
    if not info["has_audio"]:
        out.append(finding("probe_no_audio", "no audio stream"))
    if (info["width"], info["height"]) != (want["width"], want["height"]):
        out.append(finding("probe_size", f"{info['width']}x{info['height']} is not {want['width']}x{want['height']}"))
    if info["fps"] is None or abs(info["fps"] - want["fps"]) > media.TARGETS["fps_tolerance"]:
        out.append(finding("probe_fps", f"fps {info['fps']} is not {want['fps']} within {media.TARGETS['fps_tolerance']}"))
    if want["duration"] is None:
        if not info["duration"] > 0:
            out.append(finding("probe_duration", "duration is zero"))
    elif abs(info["duration"] - want["duration"]) > media.TARGETS["duration_tolerance"]:
        out.append(finding("probe_duration", f"{info['duration']} s is not {want['duration']} s within {media.TARGETS['duration_tolerance']}"))
    return out


def audio_silent_findings(video, ffmpeg=None):
    """The muxed audio track must not be silent (peak over SILENT_PEAK)."""
    cmd = [ffmpeg or media.resolve_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(media.input_file(video)), "-vn", "-ac", "1",
           "-ar", "8000", "-f", "s16le", "-"]
    done = subprocess.run(cmd, capture_output=True, timeout=300, shell=False)
    if done.returncode != 0:
        return [finding("probe_no_audio", "audio could not be decoded: " + done.stderr.decode("utf-8", "replace")[-200:])]
    pcm = np.frombuffer(done.stdout[: len(done.stdout) // 2 * 2], dtype="<i2").astype(np.float32) / 32768
    peak = float(np.abs(pcm).max()) if pcm.size else 0.0
    return [] if peak >= SILENT_PEAK else [finding("audio_silent", f"audio peak {peak:.5f} is below {SILENT_PEAK}")]


# ---------- subtitles ----------
def subtitle_findings(srt_path, duration):
    path = Path(srt_path)
    if not path.is_file():
        return [finding("subtitle_missing", f"{path} does not exist")]
    result = subtitles.check_srt(path.read_text(encoding="utf-8-sig"), duration=duration)
    if result["errors"]:
        codes = sorted({e["code"] for e in result["errors"]})
        return [finding("subtitle_errors", f"{len(result['errors'])} errors ({', '.join(codes)}) in {result['cues']} usable cues")]
    return []


# ---------- subject in frame ----------
def load_subject_report(path_or_data):
    if isinstance(path_or_data, (str, Path)):
        return json.loads(Path(path_or_data).read_text(encoding="utf-8-sig"))
    return path_or_data


def subject_findings(report):
    """report = {"shots": [{"shot", "subject_width_fraction", optional "centre": [x, y] in 0..1}]}, written by the build from its own
    camera data. A shot with a missing or non-numeric width is an error, not a skip: the build must supply it."""
    shots = report.get("shots") if isinstance(report, dict) else None
    if not isinstance(shots, list) or not shots:
        return [finding("subject_data_invalid", "report has no shots list")]
    out = []
    for n, shot in enumerate(shots):
        name = shot.get("shot", n) if isinstance(shot, dict) else n
        frac = shot.get("subject_width_fraction") if isinstance(shot, dict) else None
        if isinstance(frac, bool) or not isinstance(frac, (int, float)) or not math.isfinite(frac) or frac < 0:
            out.append(finding("subject_data_invalid", f"shot {name}: subject_width_fraction is {frac!r}"))
            continue
        if frac < SUBJECT_MIN_WIDTH:
            out.append(finding("subject_too_small", f"shot {name}: subject is {frac:.2f} of the frame width (minimum {SUBJECT_MIN_WIDTH})"))
        elif frac > SUBJECT_MAX_WIDTH:
            out.append(finding("subject_cropped", f"shot {name}: subject is {frac:.2f} of the frame width (maximum {SUBJECT_MAX_WIDTH})"))
        centre = shot.get("centre")
        if centre is not None:
            ok = isinstance(centre, (list, tuple)) and len(centre) == 2 and all(
                isinstance(c, (int, float)) and math.isfinite(c) for c in centre)
            if not ok:
                out.append(finding("subject_data_invalid", f"shot {name}: centre is {centre!r}"))
            elif not framing.in_zone(centre[0], centre[1], 1.0):
                out.append(finding("subject_off_centre", f"shot {name}: centre {tuple(centre)} is outside the zone {framing.DEFAULT_ZONE}"))
    return out


# ---------- stem loudness ----------
def _stem(name, source):
    """(mono float array, sample rate) from a wav path or a (samples, rate) pair; raises ValueError naming the stem."""
    try:
        if isinstance(source, (str, Path)):
            import soundfile as sf
            samples, rate = sf.read(str(source), dtype="float64", always_2d=False)
        else:
            samples, rate = source
        x = np.asarray(samples, dtype=float)
        if x.ndim == 2:
            x = x.mean(axis=1)
        if x.ndim != 1 or not (isinstance(rate, (int, np.integer)) and rate > 0):
            raise ValueError("expected samples and a positive integer sample rate")
        if not np.isfinite(x).all():
            raise ValueError("contains NaN or infinite samples")
        return x, int(rate)
    except Exception as err:   # noqa: BLE001 - one named finding, whatever the reader raised
        raise ValueError(f"{name}: {err}") from err


def loudness_levels(stems):
    """Music and effects level relative to the voice, in dB, on both bases: the audio kit's active-sample basis and whole-timeline RMS.
    Raises ValueError for an unreadable or silent stem set."""
    loaded = {k: _stem(k, stems[k]) for k in ("voice", "music", "effects") if k in stems}
    if "voice" not in loaded:
        raise ValueError("voice: stem is required (it is the reference level)")
    sr = loaded["voice"][1]
    mono = {}
    for k, (x, rate) in loaded.items():
        if rate != sr:
            ratio = Fraction(sr, rate)
            x = resample_poly(x, ratio.numerator, ratio.denominator)
        mono[k] = x
    n = max(len(x) for x in mono.values())
    mono = {k: np.pad(x, (0, n - len(x))) for k, x in mono.items()}
    voice_active, voice_all = audio.rms_dbfs(mono["voice"]), audio.rms_dbfs(mono["voice"], gate_rel=0)
    if not math.isfinite(voice_active):
        raise ValueError("voice: stem is silent, so there is no reference level")
    out = {}
    for k in ("music", "effects"):
        if k not in mono:
            continue
        active, whole = audio.rms_dbfs(mono[k]), audio.rms_dbfs(mono[k], gate_rel=0)
        out[k] = {"active_db": round(active - voice_active, 2) if math.isfinite(active) else None,
                  "whole_db": round(whole - voice_all, 2) if math.isfinite(whole) else None}
    return out


def loudness_findings(stems):
    """Music about 18 dB under the voice (+/-2) and effects 10 to 13 dB under (+/-1), music is accepted when either level basis is in range, effects on the active-sample basis only.
    A silent music or effects stem passes (the audio kit leaves it silent); a stem out of range on both bases fails."""
    try:
        levels = loudness_levels(stems)
    except ValueError as err:
        return [finding("stems_unreadable", str(err))]
    out = []
    lo, hi = audio.EFFECTS_BAND_DB
    bands = {"music": (audio.MUSIC_BELOW_VOICE_DB - MUSIC_TOLERANCE_DB, audio.MUSIC_BELOW_VOICE_DB + MUSIC_TOLERANCE_DB, "music_level"),
             "effects": (lo - EFFECTS_TOLERANCE_DB, hi + EFFECTS_TOLERANCE_DB, "effects_level")}
    for k, (band_lo, band_hi, code) in bands.items():
        if k not in levels:
            continue
        # music is steady, so either basis may be in range; effects are sparse (the whole-timeline average is mostly silence), so only
        # the audio kit's active-sample basis counts for them
        bases = ("active_db", "whole_db") if k == "music" else ("active_db",)
        under = [-levels[k][b] for b in bases if levels[k][b] is not None]
        if not under:
            continue            # silent stem: nothing to be too loud
        if not any(band_lo <= u <= band_hi for u in under):
            shown = ", ".join(f"{u:.1f}" for u in under)
            out.append(finding(code, f"{k} is {shown} dB under the voice ({'active samples, whole timeline' if k == 'music' else 'active samples'}); "
                                     f"target {band_lo:g} to {band_hi:g} dB"))
    return out
