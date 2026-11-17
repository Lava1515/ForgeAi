import json
from pathlib import Path

import numpy as np
import pytest

from blender_worker.codebuilt import audio
from narrative_factory.codebuilt.post import anchors_file, cb5, overlay

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "overlay" / "valid" / "plan-example.json"


def make_anchors():
    raw = {"version": 1, "width": 1080, "height": 1920, "frames": {}}
    for frame, value in enumerate((0, 25, 50, 75, 100, 75, 50, 25)):
        raw["frames"][str(frame)] = {"v": {"depth": value}}
    return anchors_file.parse(json.dumps(raw).encode(), 8)


def test_overlay_cues_follow_fixture_events_and_convert_video_clock_once():
    spec = overlay.parse_spec(FIXTURE.read_bytes())
    cues = cb5.overlay_cues(spec, make_anchors(), duration=27.3, fps=10, lead=.35)
    assert [(e[0], e[1]) for e in cues if e[0] != "tone"] == [
        ("whoosh", 0.0), ("ping", 7.1), ("boom", 22.5)]
    tones = [e for e in cues if e[0] == "tone"]
    assert len(tones) == 1
    assert tones[0][1] == 0
    assert tones[0][3]["d"] == 27.3
    freqs = tones[0][3]["freqs"]
    assert freqs[0][1] < freqs[4][1]
    assert freqs[5][1] < freqs[4][1]


def test_jobs_without_overlay_keep_the_legacy_word_cue_list():
    word_data = {"words": [{"w": "12", "s": .4}, {"w": "Stop.", "s": .9}]}
    assert cb5._word_cues(word_data, 2.0) == [("pop", .4, .45), ("whoosh", .9, .16)]


@pytest.mark.parametrize("duration,fps,lead", [(0, 30, .35), (2, 0, .35), (2, 30, -0.1), (float("nan"), 30, .35)])
def test_overlay_cues_reject_nonfinite_or_out_of_bounds_clock_inputs(duration, fps, lead):
    with pytest.raises(ValueError):
        cb5.overlay_cues({"labels": [], "big": [], "tag": None, "counter": None}, None,
                         duration, fps, lead)


def test_effect_stem_measures_inside_the_existing_level_rule():
    sr = 12000
    duration = 2.0
    voice = np.sin(2 * np.pi * 180 * np.arange(sr * 2) / sr) * .2
    music = audio.synth_music(duration, sr=sr)
    effects = audio.synth_effects([("ping", .3, 1), ("boom", 1, .3)], duration, sr=sr)
    mixed = audio.mix_stems((voice, sr), (music, sr), (effects, sr), sr=sr, voice_peak=None)
    rel = mixed.report["relative_to_voice_db"]
    assert abs(rel["music"] + 18) <= 1
    assert -13 <= rel["effects"] <= -10


@pytest.mark.parametrize("fps", [True, 241, 1e7, float("inf")])
def test_fps_cap(fps):
    with pytest.raises(ValueError, match="fps"):
        cb5.overlay_cues(overlay.parse_spec(FIXTURE.read_bytes()), make_anchors(), 2, fps, .35)


@pytest.mark.parametrize("start,end", [(0, .2), (.03, .04), (2.1, 2.3)])
def test_window_preserved_before_lead_and_after_voice(start, end):
    spec = overlay.parse_spec(json.dumps({"version": 1, "counter": {
        "value": "depth", "format": "int", "from": start, "to": end}}).encode())
    cue, = cb5.overlay_cues(spec, make_anchors(), 2, 30, .35)
    assert cue[1] == start
    assert cue[3]["d"] == pytest.approx(end-start)


@pytest.mark.parametrize("marks", [None, anchors_file.Anchors.empty()])
def test_missing_counter_anchors_fail(marks):
    with pytest.raises(ValueError, match="anchors.json"):
        cb5.overlay_cues(overlay.parse_spec(FIXTURE.read_bytes()), marks, 28, 30, .35)


def test_frame_budget_cap():
    with pytest.raises(ValueError, match="frame"):
        cb5.overlay_cues(overlay.parse_spec(FIXTURE.read_bytes()), make_anchors(), 10000, 240, .35)


def test_produce_legacy_mix_is_byte_identical(tmp_path, monkeypatch):
    import soundfile as sf
    from test_post_overlay_run import _fake_cb5_job
    job, seen = _fake_cb5_job(tmp_path, monkeypatch)
    voice, sr = sf.read(job / "mix.wav", dtype="float32")
    words = json.loads((job / "words.json").read_text())
    duration = len(voice)/sr
    choice = audio.music_choice(" ".join(w["w"] for w in words["words"]))
    music = audio.synth_music(duration, sr=cb5.MIX_SR, seed=choice["seed"], bpm=choice["bpm"],
        progression=audio.PROGRESSIONS[choice["progression"]], fade_out_s=min(1.2, duration/2))
    effects = audio.synth_effects(cb5._word_cues(words, duration), duration, sr=cb5.MIX_SR, seed=3)
    expected = audio.mix_stems((voice,sr), (music,cb5.MIX_SR), (effects,cb5.MIX_SR), sr=cb5.MIX_SR, voice_peak=None)
    audio.write_outputs(expected, job / "expected", name="cb5", print_levels=False)
    cb5.produce(job)
    assert "audio_lead" not in seen
    for stem in ("mix", "voice", "music", "effects"):
        assert (job / "out/audio" / f"cb5-{stem}.wav").read_bytes() == (job / "expected" / f"cb5-{stem}.wav").read_bytes()


def test_overlay_produce_pads_voice_once_and_preserves_early_cues(tmp_path, monkeypatch):
    import soundfile as sf
    from test_post_overlay_run import _fake_cb5_job, write
    job, seen = _fake_cb5_job(tmp_path, monkeypatch)
    (job / "inputs").mkdir()
    (job / "work").mkdir()
    write(job / "inputs/overlay.json", {"version":1, "tag":{"text":"HERE","from":0,"to":.2},
        "counter":{"value":"n","format":"int","from":0,"to":.2}})
    write(job / "work/anchors.json", {"version":1,"width":216,"height":384,
        "frames":{"0":{"v":{"n":0}},"5":{"v":{"n":1}}}})
    report = cb5.produce(job)
    assert seen["audio_lead"] == 0 and seen["lead"] == .35
    voice, sr = sf.read(job / "out/audio/cb5-voice.wav")
    tone, _ = sf.read(job / "out/audio/cb5-tone.wav")
    effects, _ = sf.read(job / "out/audio/cb5-effects.wav")
    assert not np.any(voice[:round(.35*sr)])
    assert np.any(voice[round(.35*sr):round(.36*sr)])
    assert np.any(tone[:round(.1*sr)]) and not np.any(tone[round(.2*sr):])
    assert np.any(effects[:round(.1*sr)])
    assert report["audio"]["relative_to_voice_db"]["tone"] == -11.5


def test_encoded_mux_offset_independent_of_caption_lead(tmp_path):
    import subprocess
    from narrative_factory.codebuilt.post import run, media
    from test_post_overlay_run import job_inputs, HAVE_FFMPEG
    if not HAVE_FFMPEG:
        pytest.skip("no ffmpeg")
    frames, words, wav = job_inputs(tmp_path)
    def encode(name, **args):
        return run.finish(frames, words, wav, tmp_path/name, "short", lead=.35, **args)
    old = encode("legacy")
    explicit = encode("explicit", audio_lead=.35)
    early = encode("premix", audio_lead=0)
    assert Path(old["video"]).read_bytes() == Path(explicit["video"]).read_bytes()
    assert Path(old["subtitles"]).read_bytes() == Path(early["subtitles"]).read_bytes()
    def decode(rep):
        data = subprocess.check_output([media.resolve_ffmpeg(), "-v","error","-i",rep["video"],
            "-vn","-f","f32le","-ac","1","-ar","24000","-"])
        return np.frombuffer(data, dtype="<f4")
    assert np.max(np.abs(decode(old)[:2400])) < .001
    assert np.sqrt(np.mean(decode(early)[:2400]**2)) > .1
