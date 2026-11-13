"""Code-built audio kit (CB3 / KAN-912): synthesized music and effects stems, mixed to measured levels.

Ported from the chat shorts' audio scripts; every sound is synthesized here, no
sample clips, and nothing is imported from outside this repository.

Why: the owner found music too loud in three shorts that were mixed by guessed gains. Here the mixer measures each
stem and sets the gain so the levels land on stated targets.

Measurement basis (also written into every report): RMS in dBFS over the "active" samples of each stem, where
active means |x| >= GATE_REL * (that stem's peak). The gate keeps silence and padding out of the average, so a
sparse effects track or a voice with pauses is compared by how loud it is when it sounds. The gate is relative to
the peak, so it does not change when a stem is scaled.

Targets, relative to the voice: music 18 dB below; effects 10 to 13 dB below (default 11.5, the band's middle).

Policy for awkward input:
  * NaN/inf anywhere, an unusable sample rate or shape, or a silent/empty voice -> AudioKitError (nothing to
    measure against, and silently zeroing would hide a broken upstream step).
  * silent music or effects -> left silent, status "silent-skipped" and a warning (never amplified from nothing).
  * different sample rates -> resampled to the mix rate; different channel counts -> averaged to mono. The mix is
    mono; write_outputs fans it out to the requested output channels.
  * clipping -> one uniform master gain on all stems so the mix peak stays at or under the ceiling. Uniform, so
    the measured differences between stems are unchanged (no tanh squashing, which would break them).
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import numpy as np
from scipy.signal import butter, lfilter, resample_poly

DEFAULT_SR = 44100
GATE_REL = 0.035            # active-sample gate, fraction of the stem's peak (about -29 dB re peak)
SILENCE_PEAK = 1e-6         # a stem whose peak is below this (-120 dBFS) counts as silent
MUSIC_BELOW_VOICE_DB = 18.0
EFFECTS_BELOW_VOICE_DB = 11.5
EFFECTS_BAND_DB = (10.0, 13.0)
TOLERANCE_DB = 1.0
BASIS = ("RMS in dBFS over active samples (|x| >= %.3f x the stem's own peak), measured on mono stems at the mix "
         "sample rate, on the final stems (the uniform master gain moves all levels together, so differences are unchanged)" % GATE_REL)


class AudioKitError(ValueError):
    """Input the kit cannot mix coherently."""


# ---------------------------------------------------------------- measuring
def rms_dbfs(x, gate_rel: float = GATE_REL) -> float:
    """RMS level of the active samples of a mono array, in dBFS. -inf when the array is silent."""
    x = np.asarray(x, dtype=float)
    if x.size == 0:
        return float("-inf")
    peak = float(np.abs(x).max())
    if peak < SILENCE_PEAK:
        return float("-inf")
    active = x[np.abs(x) >= gate_rel * peak]
    return float(20 * np.log10(np.sqrt(np.mean(active ** 2))))


# ---------------------------------------------------------------- synthesis
class _Synth:
    """The chat scripts' sound primitives, bound to one sample rate and one seeded noise source."""

    def __init__(self, sr: int, seed: int):
        self.sr = sr
        self.rng = np.random.default_rng(seed)

    def tt(self, d):
        return np.arange(int(d * self.sr)) / self.sr

    def env(self, d, a=0.005, k=6.0):
        t = self.tt(d)
        return np.minimum(t / a, 1) * np.exp(-k * t / d)

    def sweep(self, f0, f1, d, curve=1.0):
        t = self.tt(d)
        f = f0 + (f1 - f0) * (t / d) ** curve
        return np.sin(2 * np.pi * np.cumsum(f) / self.sr)

    def noise(self, d, lo=None, hi=None):
        x = self.rng.standard_normal(int(d * self.sr))
        nyq = self.sr / 2
        hi = min(hi, nyq * 0.98) if hi else hi
        if lo and hi:
            b, a = butter(2, [lo / nyq, hi / nyq], "band")
        elif lo:
            b, a = butter(2, min(lo, nyq * 0.98) / nyq, "high")
        elif hi:
            b, a = butter(2, hi / nyq, "low")
        else:
            return x
        return lfilter(b, a, x)

    # effects (each returns a mono array)
    def whoosh(self, d=0.34, lo=400, hi=3000):
        return self.noise(d, lo, hi) * np.sin(np.pi * self.tt(d) / d) ** 2

    def pop(self):
        n = int(0.06 * self.sr)
        tail = self.noise(0.05, 1500) * self.env(0.05, 0.001, 7) * 0.8
        return self.sweep(1100, 180, 0.06) * self.env(0.06, 0.001, 5) + np.pad(tail, (0, max(0, n - tail.size)))[:n]

    def gulp(self):
        return np.concatenate([self.sweep(330, 110, 0.13) * self.env(0.13, 0.01, 2),
                               self.sweep(120, 300, 0.12) * self.env(0.12, 0.01, 3) * 0.8])

    def plop(self):
        return self.sweep(520, 140, 0.16, 0.6) * self.env(0.16, 0.003, 3)

    def splash(self, d=0.5):
        return self.noise(d, 1200, 7000) * self.env(d, 0.01, 5)

    def squelch(self, d=0.3):
        t = self.tt(d)
        return (self.noise(d, 150, 900) * np.sin(np.pi * t / d) * (0.6 + 0.4 * np.sin(2 * np.pi * 28 * t))
                + 0.5 * self.sweep(260, 90, d) * self.env(d, 0.02, 3))

    def boing(self, d=0.7):
        t = self.tt(d)
        f = 170 * (1 + 0.55 * np.exp(-5 * t) * np.sin(2 * np.pi * 11 * t))
        return np.sin(2 * np.pi * np.cumsum(f) / self.sr) * self.env(d, 0.004, 4)

    def blip(self, f=1200):
        return self.sweep(f, f * 1.9, 0.05) * self.env(0.05, 0.004, 3)

    def ping(self, f=880, d=0.5):
        t = self.tt(d)
        return (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.01 * t)) * self.env(d, 0.002, 6)

    def thud(self):
        a = self.sweep(140, 45, 0.35) * self.env(0.35, 0.002, 5) * 1.4
        b = self.noise(0.06, 300, 4000) * self.env(0.06, 0.001, 6)
        a[: b.size] += b
        return a

    def screech(self, d=0.4):
        t = self.tt(d)
        return (self.sweep(1900, 350, d, 0.6) * 0.6 + self.noise(d, 1500, 5000) * 0.5) * np.sin(np.pi * t / d) ** 0.5

    def rumble(self, d=1.0, f=46):
        t = self.tt(d)
        return np.sin(2 * np.pi * f * t) * (1 + 0.5 * np.sin(2 * np.pi * 7 * t)) * np.sin(np.pi * t / d)

    def wind(self, d=1.0, g0=0.1, g1=0.2, lo=150, hi=1800):
        t = self.tt(d)
        return self.noise(d, lo, hi) * (g0 + (g1 - g0) * t / d) * np.minimum(1, np.minimum(t, d - t) / 0.15)

    # music voices
    def pluck(self, f, d=0.32):
        t = self.tt(d)
        return ((np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t))
                * np.exp(-t * 11) * np.minimum(t / 0.003, 1))

    def bass(self, f, d=0.5):
        t = self.tt(d)
        return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 5) * np.minimum(t / 0.005, 1)


EFFECT_NAMES = ("whoosh", "pop", "gulp", "plop", "splash", "squelch", "boing", "blip", "ping", "thud", "screech",
                "rumble", "wind")

# Sneaky pizzicato progression from the gum short: (bass root note, eight plucked notes per bar), MIDI numbers.
DEFAULT_PROGRESSION = (
    (45, (57, 60, 64, 60, 57, 64, 60, 67)),
    (41, (53, 57, 60, 57, 53, 60, 57, 65)),
    (43, (55, 59, 62, 59, 55, 62, 59, 67)),
    (40, (52, 56, 59, 56, 64, 59, 56, 52)),
)


def _add(buf: np.ndarray, sig, start: int, gain: float) -> None:
    if start < 0 or start >= buf.size:
        return
    sig = np.asarray(sig, dtype=float)[: buf.size - start]
    buf[start:start + sig.size] += sig * gain


def synth_music(duration: float, sr: int = DEFAULT_SR, bpm: float = 104, seed: int = 3,
                progression=DEFAULT_PROGRESSION, fade_out_s: float = 1.2) -> np.ndarray:
    """Plucked loop with a bass line and a soft tick, as a mono stem of exactly int(duration * sr) samples."""
    _require_duration(duration)
    s = _Synth(sr, seed)
    out = np.zeros(int(duration * sr))
    beat = 60.0 / bpm
    nf = lambda n: 440 * 2 ** ((n - 69) / 12)  # noqa: E731
    t, bar = 0.0, 0
    while t < duration:
        root, notes = progression[bar % len(progression)]
        for i, n in enumerate(notes):
            _add(out, s.pluck(nf(n + 12)), int((t + i * beat / 2) * sr), 0.055 if i % 2 else 0.075)
        for b in (0, 1.5, 2, 3):
            _add(out, s.bass(nf(root)), int((t + b * beat) * sr), 0.16)
        for b in (1, 3):
            _add(out, s.noise(0.05, 5000) * s.env(0.05, 0.001, 6), int((t + b * beat) * sr), 0.02)
        t += 4 * beat
        bar += 1
    if fade_out_s > 0:
        left = (duration - np.arange(out.size) / sr) / fade_out_s
        out *= np.clip(left, 0, 1)
    return out


def synth_effects(events, duration: float, sr: int = DEFAULT_SR, seed: int = 3) -> np.ndarray:
    """Effects stem from events: (name, time_s, gain) or (name, time_s, gain, params_dict).

    name is one of EFFECT_NAMES; params go to that effect (for example {"f": 880} for ping, or
    {"d": 2.0, "g0": .05, "g1": .2} for wind). Gains are relative inside the stem only; the mixer sets the level."""
    _require_duration(duration)
    s = _Synth(sr, seed)
    out = np.zeros(int(duration * sr))
    for ev in events:
        name, t, gain = ev[0], float(ev[1]), float(ev[2])
        params = dict(ev[3]) if len(ev) > 3 else {}
        if name not in EFFECT_NAMES:
            raise AudioKitError("unknown effect %r; choose from %s" % (name, ", ".join(EFFECT_NAMES)))
        _add(out, getattr(s, name)(**params), int(t * sr), gain)
    return out


def _require_duration(duration) -> None:
    if not (isinstance(duration, (int, float)) and math.isfinite(duration) and duration > 0):
        raise AudioKitError("duration must be a positive finite number of seconds, got %r" % (duration,))


# ---------------------------------------------------------------- mixing
@dataclass
class MixResult:
    mix: np.ndarray            # mono mix, master gain applied
    stems: dict                # "voice", "music", "effects": mono, gained, aligned, same length as mix
    sr: int
    report: dict


def _prepare(name: str, stem, sr: int) -> tuple:
    """Validate one (samples, sample_rate) stem; return (mono at sr, info)."""
    try:
        samples, in_sr = stem
    except (TypeError, ValueError):
        raise AudioKitError("%s: expected (samples, sample_rate)" % name) from None
    if not (isinstance(in_sr, (int, np.integer)) and in_sr > 0):
        raise AudioKitError("%s: sample rate must be a positive integer, got %r" % (name, in_sr))
    x = np.asarray(samples, dtype=float)
    if x.ndim not in (1, 2):
        raise AudioKitError("%s: samples must be 1-D or 2-D (frames, channels), got %d-D" % (name, x.ndim))
    channels = 1 if x.ndim == 1 else x.shape[1]
    if channels < 1:
        raise AudioKitError("%s: needs at least 1 channel (channels=0)" % name)
    if not np.isfinite(x).all():
        raise AudioKitError("%s: contains NaN or infinite samples; fix the source instead of mixing it" % name)
    mono = x if x.ndim == 1 else x.mean(axis=1)
    if in_sr != sr:
        ratio = Fraction(sr, int(in_sr))
        mono = resample_poly(mono, ratio.numerator, ratio.denominator)
    info = {"sr": int(in_sr), "channels": int(channels), "seconds": round(len(x) / in_sr, 3)}
    return mono, info


def mix_stems(voice, music, effects, *, sr: int = DEFAULT_SR,
              music_below_voice_db: float = MUSIC_BELOW_VOICE_DB,
              effects_below_voice_db: float = EFFECTS_BELOW_VOICE_DB,
              voice_peak: float | None = 0.85, voice_offset_s: float = 0.0,
              peak_ceiling: float = 0.92) -> MixResult:
    """Scale music and effects so they sit the stated number of dB under the voice, then sum.

    voice, music, effects: (samples, sample_rate); samples 1-D, or 2-D (frames, channels).
    music_below_voice_db / effects_below_voice_db: positive dB under the voice (effects must be 10 to 13).
    voice_peak: peak-normalise the voice to this first (None leaves its level). The voice keeps this level in the
    mix; only the master gain below can lower it.
    peak_ceiling: the mix peak is held at or under this by one uniform master gain."""
    for label, v in (("music_below_voice_db", music_below_voice_db), ("effects_below_voice_db", effects_below_voice_db)):
        if not (isinstance(v, (int, float)) and math.isfinite(v) and v > 0):
            raise AudioKitError("%s must be a positive finite number of dB, got %r" % (label, v))
    lo, hi = EFFECTS_BAND_DB
    if not lo <= effects_below_voice_db <= hi:
        raise AudioKitError("effects_below_voice_db must be within %g to %g dB, got %g" % (lo, hi, effects_below_voice_db))
    if not (isinstance(sr, int) and sr > 0):
        raise AudioKitError("sr must be a positive integer")
    if not (math.isfinite(voice_offset_s) and voice_offset_s >= 0):
        raise AudioKitError("voice_offset_s must be finite and >= 0")
    if not (math.isfinite(peak_ceiling) and 0 < peak_ceiling <= 1):
        raise AudioKitError("peak_ceiling must be in (0, 1]")
    if voice_peak is not None and not (type(voice_peak) in (int, float) and math.isfinite(voice_peak) and voice_peak > 0):
        raise AudioKitError("voice_peak must be None or a positive finite number")

    mono, info = {}, {}
    for name, stem in (("voice", voice), ("music", music), ("effects", effects)):
        mono[name], info[name] = _prepare(name, stem, sr)

    v_peak = float(np.abs(mono["voice"]).max()) if mono["voice"].size else 0.0
    if v_peak < SILENCE_PEAK:
        raise AudioKitError("voice is silent or empty: there is no reference level to mix the other stems against")
    if voice_peak is not None:
        mono["voice"] = mono["voice"] * (voice_peak / v_peak)
    voice_db = rms_dbfs(mono["voice"])

    warnings, status, gains = [], {"voice": "reference"}, {"voice": 0.0}
    targets = {"music": -music_below_voice_db, "effects": -effects_below_voice_db}
    for name in ("music", "effects"):
        level = rms_dbfs(mono[name])
        if not math.isfinite(level):
            status[name] = "silent-skipped"
            gains[name] = None
            warnings.append("%s is silent or empty: left silent, nothing to scale" % name)
            continue
        gains[name] = voice_db + targets[name] - level
        mono[name] = mono[name] * 10 ** (gains[name] / 20)
        status[name] = "mixed"

    offset = int(round(voice_offset_s * sr))
    placed = {"voice": np.concatenate([np.zeros(offset), mono["voice"]]), "music": mono["music"], "effects": mono["effects"]}
    n = max(len(a) for a in placed.values())
    stems = {k: np.pad(a, (0, n - len(a))) for k, a in placed.items()}
    mix = sum(stems.values())

    peak = float(np.abs(mix).max())
    master_db = 0.0
    if peak > peak_ceiling:
        master = peak_ceiling / peak
        master_db = 20 * math.log10(master)
        stems = {k: a * master for k, a in stems.items()}
        mix = mix * master
        warnings.append("mix peak %.3f exceeded the ceiling %.2f: all stems lowered together by %.2f dB "
                        "(relative levels unchanged)" % (peak, peak_ceiling, -master_db))

    final = {k: rms_dbfs(a) for k, a in stems.items()}
    timeline = {k: rms_dbfs(a, gate_rel=0) for k, a in stems.items()}
    timeline_rel = {k: timeline[k] - timeline["voice"] if math.isfinite(timeline[k]) else None for k in ("music", "effects")}
    rel = {k: (final[k] - final["voice"]) if math.isfinite(final[k]) else None for k in ("music", "effects")}
    within = all(abs(rel[k] - targets[k]) <= TOLERANCE_DB for k in ("music", "effects") if rel[k] is not None)
    report = {
        "basis": BASIS,
        "whole_timeline": {
            "basis": "RMS in dBFS over all samples of each padded final stem, including silence; targets use the active-sample basis above",
            "final_dbfs": {k: round(v, 2) if math.isfinite(v) else None for k, v in timeline.items()},
            "relative_to_voice_db": {k: round(v, 2) if v is not None else None for k, v in timeline_rel.items()},
        },
        "gate_rel": GATE_REL,
        "sr": sr,
        "output": "mono mix; write_outputs writes it as the requested channel count",
        "targets": {"music_below_voice_db": float(music_below_voice_db),
                    "effects_below_voice_db": float(effects_below_voice_db),
                    "effects_band_db": list(EFFECTS_BAND_DB), "tolerance_db": TOLERANCE_DB},
        "inputs": info,
        "voice_offset_s": voice_offset_s,
        "voice_peak_normalised_to": voice_peak,
        "status": status,
        "gains_db": {**{k: (None if v is None else round(v, 3)) for k, v in gains.items()}, "master": round(master_db, 3)},
        "master_gain_db": round(master_db, 3),
        "mix_peak": round(float(np.abs(mix).max()), 4),
        "peak_ceiling": peak_ceiling,
        "final_dbfs": {k: (round(v, 2) if math.isfinite(v) else None) for k, v in final.items()},
        "relative_to_voice_db": {k: (None if v is None else round(v, 2)) for k, v in rel.items()},
        "within_tolerance": bool(within),
        "warnings": warnings,
    }
    return MixResult(mix=mix, stems=stems, sr=sr, report=report)


def format_levels(report: dict) -> str:
    f, r, t = report["final_dbfs"], report["relative_to_voice_db"], report["targets"]
    show = lambda v: "silent" if v is None else "%.1f dB" % v  # noqa: E731
    lines = ["LEVELS (%s)" % report["basis"],
             "voice   %s dBFS (reference)" % f["voice"],
             "music   %s dBFS | vs voice %s | target -%g dB" % (f["music"], show(r["music"]), t["music_below_voice_db"]),
             "effects %s dBFS | vs voice %s | target -%g dB" % (f["effects"], show(r["effects"]), t["effects_below_voice_db"]),
             "master gain %.2f dB | mix peak %.3f | within +/-%g dB: %s" % (
                 report["master_gain_db"], report["mix_peak"], t["tolerance_db"], report["within_tolerance"])]
    if "whole_timeline" in report:
        whole = report["whole_timeline"]["relative_to_voice_db"]
        lines.append("Whole timeline (including silence), vs voice: music %s; effects %s" % (show(whole["music"]), show(whole["effects"])))
    lines += ["WARNING: " + w for w in report["warnings"]]
    return "\n".join(lines)


def write_outputs(result: MixResult, out_dir, *, name: str = "audio", channels: int = 2, print_levels: bool = True) -> dict:
    """Write <name>-mix/-voice/-music/-effects.wav and <name>-levels.json into out_dir; print the levels."""
    import soundfile as sf  # local import: the mixing and synthesis above need only numpy and scipy
    if not (isinstance(channels, int) and channels >= 1):
        raise AudioKitError("channels must be a positive integer")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    for key, arr in (("mix", result.mix), *result.stems.items()):
        p = out / ("%s-%s.wav" % (name, key))
        sf.write(str(p), np.repeat(arr[:, None], channels, axis=1), result.sr)
        paths[key] = p
    paths["levels"] = out / ("%s-levels.json" % name)
    paths["levels"].write_text(json.dumps(result.report, indent=2) + "\n", encoding="utf-8")
    if print_levels:
        print(format_levels(result.report))
    return paths
