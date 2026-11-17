import numpy as np
import pytest

from blender_worker.codebuilt import audio


def dominant_frequency(samples, sr):
    window = np.hanning(len(samples))
    spectrum = np.abs(np.fft.rfft(samples * window))
    return np.fft.rfftfreq(len(samples), 1 / sr)[int(np.argmax(spectrum))]


def test_tone_pitch_rises_with_its_frequency_sweep():
    sr = 12000
    tone = audio._Synth(sr, 2).tone(300, 900, d=0.6)
    low = dominant_frequency(tone[: len(tone) // 3], sr)
    high = dominant_frequency(tone[-len(tone) // 3 :], sr)
    assert high > low * 1.7


@pytest.mark.parametrize("f0,f1,d", [(0, 400, .2), (400, float("nan"), .2), (400, 7000, .2), (400, 800, 0)])
def test_tone_rejects_invalid_frequency_or_duration(f0, f1, d):
    with pytest.raises(audio.AudioKitError):
        audio._Synth(12000, 1).tone(f0, f1, d)
