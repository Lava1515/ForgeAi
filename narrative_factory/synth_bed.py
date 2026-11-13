"""KAN-610: sparse music bed made by code (numpy only; no samples, no third-party audio). Optional: music_bed_v1, only with sfx_v2.
The bed keeps the 300-3400 Hz voice band empty, so the narration is not masked; music_sync ducks it under the voice."""
import numpy as np

BPM_RANGE = (60.0, 80.0)
VOICE_BAND = (300.0, 3400.0)  # Hz: notched out of the bed so the narration sits in a clear band
SWELL_PEAK = 1.5  # gain at the top of the swell (about +3.5 dB over the base)
SWELL_RISE, SWELL_HOLD, SWELL_FALL = 6.0, 2.0, 3.0  # s: rise, hold (ends at the payoff), fall


def bed(duration, sr=44100, bpm=72.0):
    """Mono float64 bed of `duration` seconds: a slow low pad plus a soft kick on each beat, voice band notched out."""
    if not BPM_RANGE[0] <= bpm <= BPM_RANGE[1]:
        raise ValueError(f"bed tempo must be 60-80 BPM, got {bpm}")
    n = int(round(duration * sr))
    t = np.arange(n) / sr
    pad = sum(np.sin(2 * np.pi * f * t) for f in (110.0, 164.81, 220.0)) * (0.5 + 0.5 * np.sin(2 * np.pi * t / 16.0))
    x = 0.2 * pad / 3.0
    beat = 60.0 / bpm
    kt = np.arange(int(0.3 * sr)) / sr
    kick = np.sin(2 * np.pi * 80.0 * kt) * np.exp(-kt * 18.0)
    for b in np.arange(0.0, duration, beat):
        i = int(round(b * sr))
        j = min(n, i + len(kick))
        x[i:j] += 0.35 * kick[: j - i]
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / sr)
    spec[(f >= VOICE_BAND[0]) & (f <= VOICE_BAND[1])] = 0.0  # the voice band stays empty
    x = np.fft.irfft(spec, n)
    peak = float(np.max(np.abs(x))) if n else 0.0
    return x * (0.5 / peak) if peak > 0 else x


def rms_table(x, sr, step=4.0):
    """(window start s, RMS dBFS) per step-second window: the per-4 s table the review pack reads."""
    x = np.asarray(x, dtype="float64")
    w = int(round(step * sr))
    rows = []
    for i in range(0, len(x), w):
        seg = x[i:i + w]
        rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
        rows.append((i / sr, 20.0 * np.log10(max(rms, 1e-12))))
    return rows


def swell_gain(n, sr, payoff_s):
    """Gain per sample (1.0 at base): rises to SWELL_PEAK, holds so the hold ends at payoff_s, falls 3 s back to 1.0.
    A payoff under rise + hold (8 s) shortens both proportionally, so the rise never starts before 0 s."""
    t = np.arange(n) / sr
    k = min(1.0, max(payoff_s, 0.0) / (SWELL_RISE + SWELL_HOLD))  # 1.0 for a payoff at 8 s or later
    rise, hold = SWELL_RISE * k, SWELL_HOLD * k
    start = max(0.0, payoff_s - hold - rise)
    up = np.clip((t - start) / rise, 0.0, 1.0) if rise > 0 else (t >= start).astype(float)
    down = np.clip((payoff_s + SWELL_FALL - t) / SWELL_FALL, 0.0, 1.0)
    return 1.0 + (SWELL_PEAK - 1.0) * np.minimum(up, down)
