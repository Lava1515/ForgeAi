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


def test_tone_curve_has_one_phase_and_no_frame_envelope_resets():
    sr = 12000
    points = [(i/30, 443 + i*7) for i in range(31)]
    x = audio._Synth(sr, 1).tone(443, 653, 1, freqs=points)
    t = np.arange(sr)/sr
    f = np.interp(t, *np.array(points).T)
    phase = 2*np.pi*np.cumsum(f)/sr
    # Inside the window only the phase changes; no 30 Hz attacks/decays.
    assert np.max(np.abs(x[100:-100] - .25*np.sin(phase[100:-100]))) < 1e-10


def test_tone_measured_independently_of_loud_impacts():
    sr=12000
    voice=.2*np.sin(2*np.pi*180*np.arange(sr*2)/sr)
    tone=audio.synth_effects([("tone", 0, 1, {"f0":440,"f1":880,"d":2})], 2, sr)
    effects=audio.synth_effects([("boom", .5, 10), ("ping", 1, 10)], 2, sr)
    mixed=audio.mix_stems((voice,sr), (audio.synth_music(2,sr),sr), (effects,sr),
                          tone=(tone,sr), sr=sr, voice_peak=None)
    for name in ("tone", "effects"):
        assert -13 <= audio.rms_dbfs(mixed.stems[name])-audio.rms_dbfs(mixed.stems["voice"]) <= -10
    assert mixed.report["relative_to_voice_db"]["music"] == -18


@pytest.mark.parametrize("points", [[(0,440),(.5,500),(.4,600),(1,880)],
    [(0,440),(1,float("nan"))], [(0,440),(1,6000)], [(0,440)], [(0,440),(.9,880)]])
def test_bad_tone_curves_fail(points):
    with pytest.raises(audio.AudioKitError):
        audio._Synth(12000,1).tone(440,880,1,freqs=points)


def test_falling_curve_frequency_is_measured_in_samples():
    sr=12000
    x=audio._Synth(sr,1).tone(880,440,1,freqs=[(0,880),(.5,660),(1,440)])
    assert dominant_frequency(x[1200:3600],sr) > dominant_frequency(x[8400:10800],sr) + 200
