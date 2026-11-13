"""Music follows the narration (KAN-380): beat grid of the music track, a duck that keeps the voice clear,
and cuts that snap to the beat without ever touching the narration. Times are float seconds everywhere;
frames are computed once, by the caller. librosa (ISC) is imported lazily, only for tracks of unknown tempo."""
from pathlib import Path

import numpy as np
import soundfile as sf

import kids_music
import sfx
import synth_bed

FIT_TOLERANCE = 0.03  # s: a least-squares grid further than this from the detected beats means a tempo change
MUSIC_GAIN = 0.30  # the bed sits around 0.25-0.34 under a voice (sound-design.md 4.4)
BRIDGE = 0.35  # s: pauses between words shorter than this keep the music ducked (no pumping between words)
STRIDE = 0.01  # s: spacing of the stand-in "hits" fed to sfx.duck_envelope while the voice is active


def beat_grid(audio_path, until=None):
    """Beat times (float seconds) of a music file. The fixed-tempo kids loops return their known grid;
    any other track gets a grid fitted by least squares to librosa's beats (beat-sync.md, section 1)."""
    path = Path(audio_path)
    duration = sf.info(str(path)).duration
    end = max(duration, float(until or 0.0))
    if path.stem in {**kids_music.SONGS, **kids_music.SONGS_LONG}:
        return [float(t) for t in np.arange(0.0, end, 60.0 / kids_music.BPM)]
    import librosa

    y, sr = librosa.load(str(path), sr=None, mono=True)
    # beat_track gets the onset envelope (the y= form returned no beats on sparse click tracks in librosa 1.0) and the
    # default tightness: 400 locked onto a wrong tempo on a 128 BPM click track. The period comes from the beat
    # sequence by least squares; the phase from a fine-hop onset envelope, because the coarse beats lag the attack.
    _, beats = librosa.beat.beat_track(onset_envelope=librosa.onset.onset_strength(y=y, sr=sr), sr=sr, units="time", trim=True)
    if len(beats) < 4:
        raise ValueError("too few beats found to fit a grid")
    i = np.arange(len(beats))
    (period, t0), *_ = np.linalg.lstsq(np.vstack([i, np.ones_like(i)]).T, beats, rcond=None)
    if np.abs(beats - (t0 + i * period)).max() > FIT_TOLERANCE:
        return [float(t) for t in beats]  # tempo changes: keep the detected beats, a straight grid would lie
    fine = librosa.onset.onset_strength(y=y, sr=sr, n_fft=512, hop_length=64)
    fine_t = librosa.times_like(fine, sr=sr, hop_length=64)
    shifts = np.arange(-period / 2, period / 2, 0.001)
    ks = np.arange(0, int(len(y) / sr / period) - 1)
    t0 += shifts[int(np.argmax([np.interp(t0 + s + ks * period, fine_t, fine).sum() for s in shifts]))]
    first = int(np.ceil(-t0 / period))
    return [float(t0 + k * period) for k in range(first, int(np.floor((end - t0) / period)) + 1)]


def voice_activity(words, n, sr):
    """0/1 array of length n: 1 while a word is spoken, short pauses between words bridged."""
    active = np.zeros(n)
    spans = sorted((float(w["start"]), float(w["end"])) for w in words)
    merged = []
    for s, e in spans:
        if merged and s - merged[-1][1] < BRIDGE:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    for s, e in merged:
        active[max(0, int(round(s * sr))):min(n, int(round(e * sr)))] = 1.0
    return active


def voice_duck(music, voice_envelope, depth_db=9, attack=0.05, release=0.30, sr=44100):
    """Music (n,) or (n, ch) lowered by depth_db while voice_envelope (0/1 per sample, same rate as music) is on.
    Reuses sfx.duck_envelope: stand-in hits every STRIDE s across each spoken stretch."""
    music = np.asarray(music, dtype="float64")
    active = np.asarray(voice_envelope) > 0.5
    idx = np.flatnonzero(active)
    if len(idx):
        edges = np.flatnonzero(np.diff(active.astype(np.int8)) == -1)  # last sample of each spoken stretch
        idx = np.union1d(idx[:: max(1, int(STRIDE * sr))], edges)
    env = sfx.duck_envelope(len(music), sr, list(idx / sr), attack=attack, release=release, depth_db=depth_db)
    return music * (env if music.ndim == 1 else env[:, None])


def snap_cuts(cuts, beats, tol=0.15, words=()):
    """Each cut moves to its nearest beat only if that beat is within tol seconds, falls inside no spoken word
    (words: aligner spans {start, end}) and keeps the cuts in order. Otherwise the cut stays. Returns a new list."""
    beats = np.asarray(sorted(beats), dtype="float64")
    out = []
    for k, cut in enumerate(cuts):
        cut = float(cut)
        out.append(cut)
        if not len(beats):
            continue
        beat = float(beats[np.argmin(np.abs(beats - cut))])
        if abs(beat - cut) > tol or any(float(w["start"]) < beat < float(w["end"]) for w in words):
            continue
        if (k and beat <= out[k - 1]) or (k + 1 < len(cuts) and beat >= float(cuts[k + 1])):
            continue
        out[k] = beat
    return out


def cut_snapper(music_path, words, scenes, duration):
    """The function the editor hands to scene_frames: float cut seconds in, snapped float cut seconds out.
    Without aligned words, the scenes' own line spans protect the voice."""
    beats = beat_grid(music_path, until=duration)
    spans = list(words) or [{"start": s["start"], "end": s["end"]} for s in scenes]
    return lambda cuts: snap_cuts(cuts, beats, words=spans)


def mix_music_under_voice(voice_path, music_path, out_path, words):
    """Voice + looped music bed ducked under the narration -> out_path at the voice's rate and length.
    The voice samples are added untouched; without word timings the music is ducked the whole way."""
    voice, sr = sf.read(str(voice_path), dtype="float32", always_2d=True)
    n = len(voice)
    music = sfx._load_audio_file(Path(music_path), sr)
    music = np.tile(music, int(np.ceil(n / max(1, len(music)))))[:n]
    active = voice_activity(words, n, sr) if words else np.ones(n)
    bed = MUSIC_GAIN * voice_duck(music, active, sr=sr)
    out = voice + bed[:, None]
    peak = float(np.max(np.abs(out))) if n else 0.0
    if peak > sfx.PEAK:
        out *= sfx.PEAK / peak
    sf.write(str(out_path), out.astype("float32"), sr)
    return str(out_path)

def bed_under_voice(bed, n, sr, words, gain=None):
    """KAN-610: a generated bed (synth_bed.bed) looped to n samples and ducked under the narration exactly as
    mix_music_under_voice ducks its file; an optional gain curve (the swell) multiplies it last."""
    tiled = np.tile(np.asarray(bed, dtype="float64"), int(np.ceil(n / max(1, len(bed)))))[:n]
    active = voice_activity(words, n, sr) if words else np.ones(n)
    out = MUSIC_GAIN * voice_duck(tiled, active, sr=sr)
    return out if gain is None else out * gain

def mix_bed_under_voice(voice_path, out_path, words, payoff_s):
    """KAN-610 (music_bed_v1 under sfx_v2): the voice plus the generated bed, ducked under the narration with a swell that
    ends at payoff_s -> out_path at the voice's rate and length. Voice samples are added untouched; peak capped at sfx.PEAK."""
    voice, sr = sf.read(str(voice_path), dtype="float32", always_2d=True)
    n = len(voice)
    bed = bed_under_voice(synth_bed.bed(n / sr, sr=sr), n, sr, words, gain=synth_bed.swell_gain(n, sr, payoff_s))
    out = voice + bed[:, None]
    peak = float(np.max(np.abs(out))) if n else 0.0
    if peak > sfx.PEAK:
        out *= sfx.PEAK / peak
    sf.write(str(out_path), out.astype("float32"), sr)
    return str(out_path)
