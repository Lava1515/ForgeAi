"""Code-made sound effects for 3D cutaway shorts, mixed under the voice-over. Everything is synthesized,
so there is nothing to license. Cue kinds: impact (hook), click (camera moves), riser (ends at the payoff), drone (bed).
New foley hits (KAN-197): clamp (metal clang), hiss (filtered noise decay), puff (low noise burst),
sizzle (crackle), crack (very short broadband), crumble (rubble/collapse).
Kids foley cues (KAN-229): pop (bubble/cork), boing (spring), sparkle (twinkle), chime (soft bell), squeak (rubber toy).
Kids CC0 foley & synthesized babble (KAN-262): steps (rhythm for clip length), touch (tap/impact), talk (babble)."""
import json
import os
from pathlib import Path
import numpy as np
import soundfile as sf

DRONE_GAIN = 10 ** (-18 / 20)  # about 12% amplitude
PEAK = 10 ** (-1 / 20)  # -1 dBFS ceiling for the mix

HIT_KINDS = {"impact", "clamp", "hiss", "puff", "sizzle", "crack", "crumble"}

KIDS_CUES = {"pop", "boing", "chime", "squeak", "sparkle", "steps", "step", "touch", "tap", "talk", "babble"}


def get_kids_sfx_dir(override=None) -> Path | None:
    """Resolve directory containing CC0 kids sound effects:
    1. override parameter if provided and exists
    2. FORGEAI_SFX_KIDS_DIR env var if set and exists
    3. Repo-root relative path data/sfx/kids if exists
    """
    if override is not None:
        p = Path(override)
        return p if p.exists() else None
    env_dir = os.environ.get("FORGEAI_SFX_KIDS_DIR")
    if env_dir:
        p = Path(env_dir)
        if p.exists():
            return p
    local_dir = Path(__file__).resolve().parent.parent / "data" / "sfx" / "kids"
    if local_dir.exists():
        return local_dir
    return None


_AUDIO_CACHE_MAX_ENTRIES = 64
_AUDIO_CACHE = {}


def _load_audio_file(path: Path, target_sr: int) -> np.ndarray:
    key = (str(path.resolve()), target_sr)
    if key in _AUDIO_CACHE:
        return _AUDIO_CACHE[key].copy()
    data, orig_sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1).astype("float64")
    if orig_sr != target_sr:
        # Note: np.interp linear interpolation has no anti-aliasing low-pass filter when downsampling.
        num_samples = int(round(len(mono) * target_sr / orig_sr))
        mono = np.interp(np.linspace(0, len(mono), num_samples, endpoint=False), np.arange(len(mono)), mono)
    peak = np.max(np.abs(mono))
    if peak > 0:
        mono = 0.75 * mono / peak
    if len(_AUDIO_CACHE) >= _AUDIO_CACHE_MAX_ENTRIES:
        _AUDIO_CACHE.pop(next(iter(_AUDIO_CACHE)))
    _AUDIO_CACHE[key] = mono
    return mono.copy()


def _get_sound_files(category: str, sfx_dir=None):
    directory = get_kids_sfx_dir(sfx_dir)
    if not directory:
        return []
    sub = directory / category
    if not sub.exists():
        return []
    files = []
    files.extend([p for p in sub.glob("*.ogg") if p.is_file()])
    files.extend([p for p in sub.glob("*.wav") if p.is_file()])
    return sorted(files)


def _fft_band(x, sr, lo=0.0, hi=None):
    """KAN-608: zero-phase band-pass by FFT mask (no scipy). Keeps lo <= f < hi."""
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1.0 / sr)
    outside = f < lo
    if hi is not None:
        outside |= f >= hi
    spec[outside] = 0
    return np.fft.irfft(spec, len(x))


def impact(sr, rng=None, sfx_v2=False):
    t = np.arange(int(0.8 * sr)) / sr
    freq = 35 + 25 * np.exp(-t * 6)  # 60 Hz falling to 35 Hz
    sound = 0.9 * np.sin(2 * np.pi * np.cumsum(freq) / sr) * np.exp(-t * 4.5)
    if not sfx_v2:
        return sound
    # KAN-608 sfx_v2: mid-band partials (900, 1500, 2400 Hz) so a phone speaker can carry the hit
    for f in (900.0, 1500.0, 2400.0):
        sound = sound + 0.8 * np.sin(2 * np.pi * f * t) * np.exp(-t * 8.0)  # ponytail: fixed partial set, add more when a phone test asks
    return 0.9 * sound / np.max(np.abs(sound))


def whoosh(sr, rng=None, variant=0):
    """KAN-608 sfx_v2: band-passed noise swell (250-4000 Hz). Variant 0 is 0.25 s, variant 1 is 0.4 s with an earlier peak."""
    if rng is None:
        rng = np.random.default_rng()
    dur, shape = (0.25, 1.0) if variant == 0 else (0.4, 0.6)
    n = int(dur * sr)
    u = np.arange(n) / n
    noise = _fft_band(rng.standard_normal(n), sr, 250.0, 4000.0)
    sound = noise / (np.max(np.abs(noise)) + 1e-12) * np.sin(np.pi * u ** shape) ** 2
    return 0.5 * sound / (np.max(np.abs(sound)) + 1e-12)


def rumble(sr, rng=None):
    """KAN-608 sfx_v2: low-passed noise under 120 Hz, a soft attack and a slow fade (distant low roll)."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(1.2 * sr)
    t = np.arange(n) / sr
    low = _fft_band(rng.standard_normal(n), sr, 0.0, 120.0)
    sound = low / (np.max(np.abs(low)) + 1e-12) * (1.0 - np.exp(-t / 0.05)) * np.exp(-t * 2.5)
    return 0.6 * sound / (np.max(np.abs(sound)) + 1e-12)


def tock(sr, rng=None):
    """KAN-608 sfx_v2: soft tock, rounder and lower than click: a 260 Hz body with a short 1040 Hz top."""
    n = int(0.06 * sr)
    t = np.arange(n) / sr
    body = np.sin(2 * np.pi * 260.0 * t) * np.exp(-t * 45.0)
    top = 0.25 * np.sin(2 * np.pi * 1040.0 * t) * np.exp(-t * 120.0)
    sound = body + top
    return 0.5 * sound / np.max(np.abs(sound))


def click(sr, rng=None):
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.04 * sr)
    hp = np.diff(rng.standard_normal(n), prepend=0.0)  # first difference = cheap high-pass: a tick, not a thud
    return 0.35 * hp / np.max(np.abs(hp)) * np.exp(-np.arange(n) / (0.008 * sr))


def riser(sr, rng=None):
    if rng is None:
        rng = np.random.default_rng()
    n = int(2.0 * sr)
    t = np.arange(n) / sr
    sweep = np.sin(2 * np.pi * np.cumsum(200 + 1400 * (t / 2.0) ** 2) / sr)
    noise = np.convolve(rng.standard_normal(n), np.ones(8) / 8, mode="same")
    return 0.35 * (t / 2.0) ** 2 * (0.6 * sweep + 0.4 * noise / np.max(np.abs(noise)))


def clamp(sr, rng=None):
    """Metal clang: decaying inharmonic partials plus a noise transient."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.35 * sr)
    t = np.arange(n) / sr
    partials = [540.0, 1190.0, 1960.0, 3120.0, 4480.0]
    weights = [0.45, 0.30, 0.20, 0.15, 0.10]
    decays = [14.0, 20.0, 28.0, 38.0, 48.0]
    tones = np.zeros(n, dtype="float64")
    for freq, w, d in zip(partials, weights, decays):
        tones += w * np.sin(2 * np.pi * freq * t) * np.exp(-t * d)
    transient = np.diff(rng.standard_normal(n), prepend=0.0)
    transient = 0.35 * (transient / np.max(np.abs(transient))) * np.exp(-t / 0.012)
    sound = tones + transient
    return 0.75 * sound / np.max(np.abs(sound))


def hiss(sr, rng=None):
    """Filtered noise decay (steam, vent, valve, pipe)."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.4 * sr)
    t = np.arange(n) / sr
    raw = rng.standard_normal(n)
    hp = np.diff(raw, prepend=0.0)
    env = (1.0 - np.exp(-t / 0.005)) * np.exp(-t * 8.0)
    sound = (hp / np.max(np.abs(hp))) * env
    return 0.5 * sound / np.max(np.abs(sound))


def puff(sr, rng=None):
    """Low noise burst (piston, engine, fire)."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.25 * sr)
    t = np.arange(n) / sr
    k = max(1, int(sr / 200))
    low_noise = np.convolve(rng.standard_normal(n), np.ones(k) / k, mode="same")
    env = (1.0 - np.exp(-t / 0.008)) * np.exp(-t * 14.0)
    thump = np.sin(2 * np.pi * (75.0 + 35.0 * np.exp(-t * 25.0)) * t) * np.exp(-t * 18.0)
    sound = 0.6 * (low_noise / np.max(np.abs(low_noise))) * env + 0.4 * thump
    return 0.6 * sound / np.max(np.abs(sound))


def sizzle(sr, rng=None):
    """Crackle (hot, weld, heat)."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.5 * sr)
    t = np.arange(n) / sr
    u = rng.uniform(0.0, 1.0, n)
    spikes = np.where(u > 0.985, rng.standard_normal(n), 0.0)
    noise = np.diff(rng.standard_normal(n), prepend=0.0)
    crackle = spikes + 0.15 * noise / np.max(np.abs(noise))
    sound = crackle * np.exp(-t * 4.0)
    return 0.55 * sound / np.max(np.abs(sound))


def crack(sr, rng=None):
    """Very short broadband (glass, snap, break)."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.05 * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    env = np.exp(-t / 0.008)
    sound = noise * env
    return 0.7 * sound / np.max(np.abs(sound))


def crumble(sr, rng=None):
    """Collapse, rubble."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.75 * sr)
    t = np.arange(n) / sr
    k = max(1, int(sr / 150))
    rumble = np.convolve(rng.standard_normal(n), np.ones(k) / k, mode="same")
    rumble = rumble / np.max(np.abs(rumble))
    scatter = np.where(rng.uniform(0.0, 1.0, n) > 0.992, rng.standard_normal(n), 0.0)
    grain = np.convolve(scatter, np.exp(-np.arange(int(0.02 * sr)) / (0.004 * sr)), mode="same")
    grain = grain / (np.max(np.abs(grain)) + 1e-6)
    sound = (0.6 * rumble + 0.4 * grain) * np.exp(-t * 3.0)
    return 0.65 * sound / np.max(np.abs(sound))


def pop(sr, rng=None):
    """Bubble/cork pop: a bright blip that glides fast from very high down."""
    n = int(0.09 * sr)
    t = np.arange(n) / sr
    freq = 1750.0 * np.exp(-t * 55.0) + 260.0
    body = np.sin(2 * np.pi * np.cumsum(freq) / sr) * np.exp(-t * 50.0)
    tick = np.sin(2 * np.pi * 3200.0 * t) * np.exp(-t * 300.0)
    sound = body + 0.35 * tick
    return 0.8 * sound / np.max(np.abs(sound))


def boing(sr, rng=None):
    """Spring: pitch wobbles downward with a decaying bounce, plus a twang on attack."""
    n = int(0.6 * sr)
    t = np.arange(n) / sr
    bounce = np.exp(-t * 5.0)
    freq = 130.0 + 470.0 * bounce * (0.55 + 0.45 * np.sin(2 * np.pi * 13.0 * t))
    sound = np.sin(2 * np.pi * np.cumsum(freq) / sr) * bounce
    twang = 0.25 * np.sin(2 * np.pi * 2400.0 * t) * np.exp(-t * 90.0)
    sound = sound + twang * bounce
    return 0.8 * sound / np.max(np.abs(sound))


def sparkle(sr, rng=None):
    """Magical twinkle: a burst of bright bell partials with a fading shimmer."""
    n = int(0.8 * sr)
    t = np.arange(n) / sr
    partials = [
        (1046.5, 0.50, 6.0),
        (1568.0, 0.42, 7.5),
        (2093.0, 0.34, 9.0),
        (2637.0, 0.26, 11.0),
        (3520.0, 0.20, 13.5),
        (4409.0, 0.15, 16.0),
    ]
    tones = np.zeros(n)
    for i, (f, w, d) in enumerate(partials):
        tones += w * np.sin(2 * np.pi * f * t + 0.9 * i) * np.exp(-t * d)
    shimmer = 1.0 + 0.25 * np.sin(2 * np.pi * 9.0 * t) * np.exp(-t * 6.0)
    sound = tones * shimmer
    return 0.78 * sound / np.max(np.abs(sound))


def chime(sr, rng=None):
    """Soft bell: two gentle notes a fifth apart, one right after the other."""
    n = int(1.0 * sr)
    out = np.zeros(n)
    for f, t0 in ((880.0, 0.0), (1320.0, 0.22)):
        i = np.arange(n - int(t0 * sr)) / sr
        fundamental = np.sin(2 * np.pi * f * i)
        overtone = 0.3 * np.sin(2 * np.pi * 2.76 * f * i) * np.exp(-i * 4.0)
        out[int(t0 * sr) :] += 0.55 * (fundamental + overtone) * np.exp(-i * 4.5)
    return 0.8 * out / np.max(np.abs(out))


def squeak(sr, rng=None):
    """Rubber-toy squeak: a high tone gliding up with a fast squeeze wobble."""
    n = int(0.35 * sr)
    t = np.arange(n) / sr
    freq = 1350.0 + 750.0 * t / t[-1] + 180.0 * np.sin(2 * np.pi * 21.0 * t)
    squeeze = np.sin(np.pi * t / t[-1]) ** 0.6
    sound = np.sin(2 * np.pi * np.cumsum(freq) / sr) * squeeze
    return 0.8 * sound / np.max(np.abs(sound))


def _synth_step(sr, rng=None):
    """Synthesized footstep fallback: soft footstrike transient + low thump + filtered friction."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.12 * sr)
    t = np.arange(n) / sr
    freq = 120.0 * np.exp(-t * 35.0) + 40.0
    thump = np.sin(2 * np.pi * np.cumsum(freq) / sr) * np.exp(-t * 32.0)
    k = max(1, int(sr / 400))
    noise = np.convolve(rng.standard_normal(n), np.ones(k) / k, mode="same")
    noise = (noise / (np.max(np.abs(noise)) + 1e-6)) * np.exp(-t * 40.0)
    sound = 0.65 * thump + 0.35 * noise
    return 0.75 * sound / (np.max(np.abs(sound)) + 1e-6)


def _synth_touch(sr, rng=None):
    """Synthesized touch/tap fallback: gentle contact transient."""
    if rng is None:
        rng = np.random.default_rng()
    n = int(0.08 * sr)
    t = np.arange(n) / sr
    freq = 320.0 * np.exp(-t * 40.0) + 160.0
    body = np.sin(2 * np.pi * np.cumsum(freq) / sr) * np.exp(-t * 45.0)
    tick = np.diff(rng.standard_normal(n), prepend=0.0)
    tick = tick / (np.max(np.abs(tick)) + 1e-6) * np.exp(-t * 120.0)
    sound = 0.70 * body + 0.30 * tick
    return 0.75 * sound / (np.max(np.abs(sound)) + 1e-6)


def step(sr, rng=None, sfx_dir=None):
    """Single step sound: CC0 file pick if available, otherwise synthesized fallback."""
    if rng is None:
        rng = np.random.default_rng()
    files = _get_sound_files("steps", sfx_dir)
    if files:
        choice = rng.choice(files)
        return _load_audio_file(choice, sr)
    return _synth_step(sr, rng)


def steps(sr, rng=None, duration=2.0, sfx_dir=None):
    """Footsteps rhythm across clip length (random pick among step files with synth fallback)."""
    if rng is None:
        rng = np.random.default_rng()
    duration = max(0.2, float(duration))
    n = int(round(duration * sr))
    out = np.zeros(n, dtype="float64")
    # Natural preschool walking cadence: step interval ~0.42 s
    step_interval = 0.42
    files = _get_sound_files("steps", sfx_dir)
    t_curr = 0.05
    while t_curr < duration - 0.08:
        if files:
            step_snd = _load_audio_file(rng.choice(files), sr)
        else:
            step_snd = _synth_step(sr, rng)
        start = int(round(t_curr * sr))
        end = min(n, start + len(step_snd))
        if end > start:
            out[start:end] += step_snd[: end - start]
        # Slight natural rhythm variation
        jitter = float(rng.uniform(-0.02, 0.02))
        t_curr += step_interval + jitter
    peak = np.max(np.abs(out))
    if peak > 0.8:
        out = 0.8 * out / peak
    return out


def touch(sr, rng=None, sfx_dir=None):
    """Touch/tap sound: CC0 file pick if available, otherwise synthesized fallback."""
    if rng is None:
        rng = np.random.default_rng()
    files = _get_sound_files("touch", sfx_dir)
    if files:
        choice = rng.choice(files)
        return _load_audio_file(choice, sr)
    return _synth_touch(sr, rng)


tap = touch  # alias


def talk(sr, rng=None, duration=1.0):
    """Synthesized toddler talk/babble cue (no real speech, no lyrics)."""
    if rng is None:
        rng = np.random.default_rng()
    duration = max(0.6, float(duration))
    n = int(round(duration * sr))
    t = np.arange(n) / sr

    # Syllable envelopes: cute 3-4 syllable gibberish phrasing
    env = np.zeros(n, dtype="float64")
    syllables = [
        (0.06 * duration, 0.22 * duration),
        (0.35 * duration, 0.22 * duration),
        (0.65 * duration, 0.25 * duration),
    ]
    for t0, slen in syllables:
        s_idx = np.where((t >= t0) & (t < t0 + slen))[0]
        if len(s_idx) > 0:
            st = (t[s_idx] - t0) / slen
            env[s_idx] = np.sin(np.pi * st) ** 1.6

    # Infant/toddler pitch contour (F0 ~ 270 - 330 Hz with questioning inflection)
    pitch_jitter = 15.0 * np.sin(2 * np.pi * 5.0 * t)
    f0 = 280.0 + 45.0 * np.sin(np.pi * t / duration) + pitch_jitter
    phase = 2 * np.pi * np.cumsum(f0) / sr

    # Vowel formant harmonics
    vocal = np.sin(phase) + 0.55 * np.sin(2 * phase) + 0.30 * np.sin(3 * phase) + 0.18 * np.sin(4 * phase)
    sound = vocal * env
    peak = np.max(np.abs(sound))
    if peak > 0:
        sound = 0.75 * sound / peak
    return sound


babble = talk  # alias


def drone(sr, seconds, fade=True, sfx_v2=False):
    t = np.arange(int(seconds * sr)) / sr

    def saw(f):
        return 2 * ((t * f) % 1.0) - 1

    x = saw(55.0) + saw(55.4) + 0.5 * saw(110.3)
    k = max(1, int(sr / 400))  # moving average: a soft low-pass
    if not fade:
        padded = np.pad(x, (k // 2, k - 1 - k // 2), mode="edge")
        x = np.convolve(padded, np.ones(k) / k, mode="valid")
        if sfx_v2:  # KAN-608: added after the low-pass, which would otherwise swallow partials above 400 Hz
            x = x / np.max(np.abs(x)) + 0.15 * sum(np.sin(2 * np.pi * f * t) for f in (900.0, 1500.0, 2400.0)) / 3
        return x / np.max(np.abs(x))
    x = np.convolve(x, np.ones(k) / k, mode="same")
    if sfx_v2:  # KAN-608: mid-band partials above the low-pass
        x = x / np.max(np.abs(x)) + 0.15 * sum(np.sin(2 * np.pi * f * t) for f in (900.0, 1500.0, 2400.0)) / 3
    curve = np.clip(np.minimum(t / 1.5, (seconds - t) / 1.5), 0, 1)
    return x / np.max(np.abs(x)) * curve


def duck_envelope(n, sr, hit_times, attack=0.010, release=0.200, depth_db=6.0):
    """Envelope that lowers gain by depth_db around each hit time (attack before, release after)."""
    env = np.ones(n, dtype="float64")
    if not hit_times:
        return env
    n_attack = max(1, int(round(attack * sr)))
    n_release = max(1, int(round(release * sr)))
    duck_factor = 10 ** (-abs(depth_db) / 20.0)
    depth = 1.0 - duck_factor
    for t_hit in hit_times:
        s = int(round(float(t_hit) * sr))
        a0 = max(0, s - n_attack)
        a1 = min(n, max(0, s))
        a_len = a1 - a0
        if a_len > 0 and s > a0:
            ramp_down = 1.0 - depth * ((np.arange(a_len) + (n_attack - (s - a0))) / n_attack)
            env[a0:a1] = np.minimum(env[a0:a1], ramp_down)
        r0 = max(0, s)
        r1 = min(n, s + n_release)
        r_len = r1 - r0
        if r_len > 0:
            offset = r0 - s
            ramp_up = duck_factor + depth * ((np.arange(r_len) + offset) / n_release)
            env[r0:r1] = np.minimum(env[r0:r1], ramp_up)
    return env


# --- KAN-376: shot-closing phrase (riser -> impact -> sparkle), behind flag sfx_phrase_v1 (default off) ---
PHRASE_FPS = 30.0
PHRASE_RISER_LEAD = 35 / PHRASE_FPS  # the build runs this long and ends on the hit
PHRASE_SPARKLE_TAIL = 25 / PHRASE_FPS  # the afterglow starts this long after the hit
SERIES_WINDOW = PHRASE_RISER_LEAD + PHRASE_SPARKLE_TAIL  # one whole phrase (2.0 s): the same effect twice inside it is a series
SERIES_GAIN_STEP = 0.92  # each repeat in a series is a little quieter (ladder 0.40 -> 0.25 over six hits)
SERIES_PITCH = 0.92  # every second repeat is played this much lower, so neighbours differ


def phrase(hit_time):
    """Timed events for one big camera hit: riser ending at the hit, impact on it, sparkle tail after it.
    The riser event's `t` is where it ends (mix places risers by their end) and `lead` is how long the build is."""
    hit = float(hit_time)
    return [
        {"t": hit, "kind": "riser", "lead": PHRASE_RISER_LEAD},
        {"t": hit, "kind": "impact"},
        {"t": hit + PHRASE_SPARKLE_TAIL, "kind": "sparkle"},
    ]


def series_guard(events, window=SERIES_WINDOW):
    """Repeats get a quieter gain and alternating pitch; dense tick and separation runs collapse to one cue."""
    last, run, out = {}, {}, []
    for ev in sorted(events, key=lambda e: float(e["t"])):
        ev = dict(ev)
        kind, t = ev["kind"], float(ev["t"])
        if kind in {"tick", "separation"} and out and out[-1]["kind"] == kind and t - float(out[-1]["t"]) < 0.12:
            continue
        run[kind] = run[kind] + 1 if kind in last and t - last[kind] < window else 0
        last[kind] = t
        if run[kind]:
            ev["gain"] = float(ev.get("gain", 1.0)) * SERIES_GAIN_STEP ** run[kind]
            if kind != "riser" and run[kind] % 2:
                ev["pitch"] = float(ev.get("pitch", 1.0)) * SERIES_PITCH
        out.append(ev)
    return out


def expand_phrases(cues):
    """Flag-on cue pass: every impact cue gets its riser and sparkle (skipped if the caller already has one
    of that kind within half a second), then the series guard runs over the result."""
    out = list(cues)
    for cue in cues:
        if cue.get("kind") != "impact":
            continue
        for ev in phrase(cue["t"]):
            if ev["kind"] != "impact" and not any(c.get("kind") == ev["kind"] and abs(float(c["t"]) - ev["t"]) < 0.5 for c in cues):
                out.append(ev)
    return series_guard(out)


SFX_V2_TARGET_DB = 6.0  # KAN-608: a leveled cue sits this far above the voice under it (the test window is 4-9 dB)
SFX_V2_BED_FLOOR_DB = -60.0  # the local voice never counts as quieter than this (silence keeps the gain finite)
SFX_V2_MIN_GAIN_DB = -24.0
SFX_V2_MAX_GAIN_DB = 12.0
SFX_V2_CUE_PEAK = 0.9  # a leveled cue is never louder than this peak before the mix


def _level_cue(sound, start, bed_hp, sr):
    """KAN-608 sfx_v2: scale one cue so its 150 Hz-and-up RMS sits SFX_V2_TARGET_DB over the voice's over the same span.
    The gain is clamped, and the cue is peak-capped. Returns (sound, report entry)."""
    lo, hi = max(0, start), min(len(bed_hp), start + len(sound))
    bed_rms = float(np.sqrt(np.mean(bed_hp[lo:hi] ** 2))) if hi > lo else 0.0
    bed_db = 20 * np.log10(max(bed_rms, 10 ** (SFX_V2_BED_FLOOR_DB / 20)))
    cue_rms = float(np.sqrt(np.mean(_fft_band(sound, sr, 150.0) ** 2)))
    cue_db = 20 * np.log10(max(cue_rms, 1e-9))
    gain_db = float(np.clip(bed_db + SFX_V2_TARGET_DB - cue_db, SFX_V2_MIN_GAIN_DB, SFX_V2_MAX_GAIN_DB))
    out = sound * 10 ** (gain_db / 20)
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    capped = peak > SFX_V2_CUE_PEAK
    if capped:
        out = out * (SFX_V2_CUE_PEAK / peak)
    assert np.all(np.isfinite(out)), "sfx_v2: a leveled cue must be finite"
    return out, {"bed_db": round(float(bed_db), 2), "cue_db": round(float(cue_db), 2), "gain_db": round(gain_db, 2), "capped": capped}


def mix(voice_path, cues, out_path, seed=7, drone_fade=True, ducking=None, sfx_dir=None, sfx_phrase_v1=False, sfx_v2=False):
    """Voice + cues -> out_path at the voice's rate and length. Only scaled down if the sum would pass -1 dBFS.
    sfx_phrase_v1 (default off): impact cues grow a riser and sparkle, and repeated effects are varied.
    sfx_v2 (KAN-608, default off): impact and drone carry mid-band partials, whoosh/rumble/tock are placed, each cue is
    leveled against the voice under it (150 Hz and up), and a cue report lands beside out_path as <stem>.cue_report.json."""
    if ducking is None:
        ducking = not drone_fade
    if sfx_phrase_v1:
        cues = expand_phrases(cues)
    voice, sr = sf.read(str(voice_path), dtype="float32", always_2d=True)
    n = len(voice)
    fx = np.zeros(n, dtype="float64")
    rng = np.random.default_rng(seed)
    bed_hp = _fft_band(voice.mean(axis=1).astype("float64"), sr, 150.0) if sfx_v2 else None
    report = []

    hit_times = [float(c["t"]) for c in cues if c.get("kind") in HIT_KINDS]
    duck_env = duck_envelope(n, sr, hit_times) if (ducking and hit_times) else None

    for cue in cues:
        kind = cue["kind"]
        if kind == "drone":
            sound = DRONE_GAIN * drone(sr, n / sr, fade=drone_fade, sfx_v2=sfx_v2)
            if duck_env is not None:
                sound = sound * duck_env
            start = 0
        elif kind == "whoosh" and sfx_v2:
            sound, start = whoosh(sr, rng, variant=int(cue.get("variant", 0))), int(round(float(cue["t"]) * sr))
        elif kind == "rumble" and sfx_v2:
            sound, start = rumble(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "tock" and sfx_v2:
            sound, start = tock(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "riser":
            sound = riser(sr, rng)
            if cue.get("lead"):  # phrase riser: keep only the last `lead` seconds, the loud end of the build
                sound = sound[-int(float(cue["lead"]) * sr):]
            start = int(float(cue["t"]) * sr) - len(sound)  # ends on the cue (legacy truncation: flag-off output unchanged)
        elif kind == "click":
            sound, start = click(sr, rng), int(float(cue["t"]) * sr)
        elif kind == "impact":
            sound, start = impact(sr, sfx_v2=sfx_v2), int(float(cue["t"]) * sr)
        elif kind == "clamp":
            sound, start = clamp(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "hiss":
            sound, start = hiss(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "puff":
            sound, start = puff(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "sizzle":
            sound, start = sizzle(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "crack":
            sound, start = crack(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "crumble":
            sound, start = crumble(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "pop":
            sound, start = pop(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "boing":
            sound, start = boing(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "sparkle":
            sound, start = sparkle(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "chime":
            sound, start = chime(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "squeak":
            sound, start = squeak(sr, rng), int(round(float(cue["t"]) * sr))
        elif kind == "steps":
            dur = float(cue.get("duration", cue.get("length", 2.0)))
            sound, start = steps(sr, rng, duration=dur, sfx_dir=sfx_dir), int(round(float(cue["t"]) * sr))
        elif kind == "step":
            sound, start = step(sr, rng, sfx_dir=sfx_dir), int(round(float(cue["t"]) * sr))
        elif kind in ("touch", "tap"):
            sound, start = touch(sr, rng, sfx_dir=sfx_dir), int(round(float(cue["t"]) * sr))
        elif kind in ("talk", "babble"):
            dur = float(cue.get("duration", cue.get("length", 1.0)))
            sound, start = talk(sr, rng, duration=dur), int(round(float(cue["t"]) * sr))
        else:
            continue
        pitch = float(cue.get("pitch", 1.0))
        if pitch != 1.0:  # series variation: resample the sample faster/slower
            sound = np.interp(np.arange(0, len(sound) - 1, pitch), np.arange(len(sound)), sound)
        if sfx_v2 and kind != "drone":  # KAN-608: level against the voice under the cue, before the series gain
            sound, entry = _level_cue(sound, start, bed_hp, sr)
            report.append({"kind": kind, "t": round(float(cue["t"]), 4), **entry})
        if cue.get("gain", 1.0) != 1.0:
            sound = sound * float(cue["gain"])
        if start < 0:
            sound, start = sound[-start:], 0
        end = min(n, start + len(sound))
        if end > start:
            fx[start:end] += sound[: end - start]
    out = voice + fx[:, None]
    peak = float(np.max(np.abs(out))) if n else 0.0
    if peak > PEAK:
        out *= PEAK / peak
    if sfx_v2:
        assert np.all(np.isfinite(out)), "sfx_v2: the mix must be finite"
        Path(out_path).with_suffix(".cue_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    sf.write(str(out_path), out.astype("float32"), sr)
    return str(out_path)


def build_kids_bed(music_path, cues, total_seconds, out_path, sr=44100, seed=7, sfx_dir=None):
    """Kids audio bed: loop a music file to total_seconds (like ffmpeg -stream_loop), place kid cues
    {kind, t} at gain 1.0 (clamped so they end inside the bed), fade the last 1.0 s out, and
    peak-limit to PEAK the same linear way mix() does. Deterministic for a given seed.

    Loudness architecture note: build_kids_bed peak-limits to PEAK (-1 dBFS) and mixes the bed
    from the base music loop at 0.70 gain (~ -18 dBFS RMS). The -14 LUFS broadcast target is enforced
    downstream: standard narrative edits apply ffmpeg loudnorm via loudness.py:audio_filter, while
    studio.js / edit_preschool mux the ready leveled bed directly, and downstream quality checks
    (e.g. scripts/verify_preschool_draft.js) verify mean volume (-35 to -5 dB) and peak (<= -1 dBFS).
    """
    music, music_sr = sf.read(str(music_path), dtype="float32", always_2d=True)
    if music_sr != sr:
        raise ValueError(f"music file is {music_sr} Hz, expected {sr} Hz")
    frames = music.mean(axis=1)
    n = int(round(total_seconds * sr))
    bed = np.tile(frames, int(np.ceil(n / max(1, len(frames)))))[:n].astype("float64") * 0.70
    rng = np.random.default_rng(seed)
    for cue in cues:
        kind = cue["kind"]
        if kind not in KIDS_CUES:
            continue
        if kind == "steps":
            dur = float(cue.get("duration", cue.get("length", cue.get("clip_seconds", 2.0))))
            sound = steps(sr, rng, duration=dur, sfx_dir=sfx_dir)
        elif kind == "step":
            sound = step(sr, rng, sfx_dir=sfx_dir)
        elif kind in ("touch", "tap"):
            sound = touch(sr, rng, sfx_dir=sfx_dir)
        elif kind in ("talk", "babble"):
            dur = float(cue.get("duration", cue.get("length", 1.0)))
            sound = talk(sr, rng, duration=dur)
        else:
            sound = {"pop": pop, "boing": boing, "chime": chime, "squeak": squeak, "sparkle": sparkle}[kind](sr, rng)
        start = int(round(float(cue["t"]) * sr))
        if start < 0:
            sound, start = sound[-start:], 0
        if start >= n:
            continue
        end = min(n, start + len(sound))  # clamp so the cue ends inside the bed

        raw_intensity = cue.get("intensity")
        if raw_intensity is None or isinstance(raw_intensity, bool):
            intensity = 1.0
        elif isinstance(raw_intensity, int):
            intensity = 0.0 if raw_intensity <= 0 else 1.0
        else:
            try:
                val = float(raw_intensity)
                intensity = max(0.0, min(1.0, val)) if np.isfinite(val) else 1.0
            except (TypeError, ValueError, OverflowError):
                intensity = 1.0

        if intensity == 0.0:
            continue
        if intensity == 1.0:
            bed[start:end] += sound[: end - start]
        else:
            bed[start:end] += sound[: end - start] * intensity
    fade_n = min(n, int(1.0 * sr))
    bed[-fade_n:] *= 0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, fade_n)))
    peak = float(np.max(np.abs(bed))) if n else 0.0
    if peak > PEAK:
        bed *= PEAK / peak
    sf.write(str(out_path), bed.astype("float32"), sr)
    return str(out_path)
