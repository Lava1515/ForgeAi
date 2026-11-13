"""Original synthesized music loops for the kids engine. All files are written entirely by this
file (fresh pentatonic phrases over a fixed seed), so no known song, melody or recording is used."""
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
SECONDS = 30.0  # default loop length; a song may set its own "seconds"
BPM = 120.0
SLOTS_PER_SECOND = 4  # eighth notes at 120 bpm
SEED = 7
LOUDNESS_DBFS = -18.0
CEILING = 10 ** (-3 / 20)
BASE = Path(__file__).resolve().parent.parent / "data" / "music" / "kids"

# clang-free pentatonic degrees from C4: C D E G A across two+ octaves
PENTA = np.array([0.0, 2.0, 4.0, 7.0, 9.0, 12.0, 14.0, 16.0, 19.0, 21.0, 24.0, 26.0, 28.0, 31.0])

TONES = {
    "marimba": {"gain": 0.8, "ring": 0.9, "partials": ((1.0, 1.0, 22.0), (4.0, 0.30, 34.0))},
    "glock": {"gain": 0.7, "ring": 1.6, "partials": ((1.0, 1.0, 5.5), (2.76, 0.40, 7.0), (5.40, 0.22, 9.0))},
    "kalimba": {"gain": 0.8, "ring": 1.3, "partials": ((1.0, 1.0, 8.0), (5.4, 0.22, 20.0), (2.0, 0.12, 12.0))},
    "bass": {"gain": 0.5, "ring": 1.5, "partials": ((1.0, 1.0, 3.0), (2.0, 0.15, 4.5))},
}

SONGS = {
    "nursery_bounce": {
        "tone": "marimba",
        "octave": 0,
        "riff": [4, 3, 2, None, 3, None, 4, None, 0, 0, 2, 3, 4, None, 2, None],
        "turn": [3, 2, 0, None, 4, 3, 0, None],
        "bass_bar": [0, 2],
        "bass_octave": -1,
    },
    "playful_glockenspiel": {
        "tone": "glock",
        "octave": 1,
        "riff": [7, None, 5, 5, None, 4, None, 2, 4, None, 2, None, 0, None, 2, None],
        "turn": [0, 2, 4, None, 5, 4, 2, None],
        "bass_bar": [0, 4],
        "bass_octave": -1,
    },
}


# [KAN-241] A 1-minute loop in another key (+5 semitones) built from five different 2-bar phrases,
# so a long video does not sound like the 30 s loops played twice.
_A = [0, None, 2, 4, None, 2, None, 4, 5, None, 4, 2, 0, None, None, None]
_A2 = [0, None, 2, 4, None, 2, None, 4, 7, None, 5, 4, 2, None, 4, None]
_B = [5, None, 5, 7, None, 5, 4, None, 2, None, 4, None, 5, 4, 2, None]
_C = [7, 5, 4, None, 7, 5, 4, None, 2, 4, 5, None, 4, None, 2, None]
_D = [4, None, 2, None, 0, None, 2, 4, 2, None, 0, None, 0, None, None, None]

SONGS_LONG = {
    "sunny_stroll_long": {
        "tone": "kalimba",
        "octave": 0,
        "key": 5,
        "seconds": 60.0,
        "melody": _A + _A2 + _B + _A + _A2 + _C + _B + _C + _A2 + _A + _B + _C + _A + _B + _D,
        "bass_bar": [0, 4],
        "bass_octave": -1,
    },
}


def _freq(degree, octave=0, key=0):
    midi = 60.0 + PENTA[degree] + 12.0 * octave + key
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


def _note(freq, tone, velocity):
    n = int(round(tone["ring"] * SR))
    t = np.arange(n) / SR
    pitch_scale = (440.0 / freq) ** 0.35  # higher notes ring shorter
    sound = np.zeros(n)
    for ratio, weight, base_decay in tone["partials"]:
        sound += weight * np.sin(2 * np.pi * ratio * freq * t) * np.exp(-t * base_decay * pitch_scale)
    return tone["gain"] * velocity * sound


def _add(circle, start, signal):
    n = len(circle)
    end = start + len(signal)
    if end <= n:
        circle[start:end] += signal
    else:
        first = n - start
        circle[start:] += signal[:first]
        circle[: end - n] += signal[first:]  # tails wrap around: the loop stays seamless


def _render(song):
    seconds = song.get("seconds", SECONDS)
    slots = int(round(seconds * SLOTS_PER_SECOND))
    n = int(round(seconds * SR))
    circle = np.zeros(n)
    slot_n = n // slots
    rng = np.random.default_rng(SEED)
    melody = song.get("melody") or song["riff"] * 7 + song["turn"]
    assert len(melody) == slots, "melody must fill the loop exactly"
    key = song.get("key", 0)
    tone = TONES[song["tone"]]
    for slot_i, degree in enumerate(melody):
        if degree is None:
            continue
        velocity = 0.75 + 0.25 * rng.random()
        _add(circle, slot_i * slot_n, _note(_freq(degree, song["octave"], key), tone, velocity))
    for bar_i in range(slots // 8):
        for i, degree in enumerate(song["bass_bar"]):
            start = (bar_i * 8 + i * 4) * slot_n
            _add(circle, start, _note(_freq(degree, song["bass_octave"], key), TONES["bass"], 0.9))
    return circle


def _master(x):
    rms_db = 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)
    x = x * 10 ** ((LOUDNESS_DBFS - rms_db) / 20)
    peak = float(np.max(np.abs(x)))
    if peak > CEILING:
        x = x * (CEILING / peak)
    return x


def generate(out_dir=None):
    out_dir = Path(out_dir) if out_dir is not None else BASE
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, song in {**SONGS, **SONGS_LONG}.items():
        path = out_dir / f"{name}.wav"
        sf.write(path, _master(_render(song)).astype("float32"), SR, subtype="PCM_16")
        paths.append(path)
    return paths


if __name__ == "__main__":
    for path in generate():
        print(f"wrote {path}")
