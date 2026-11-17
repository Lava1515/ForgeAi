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
    assert [(event[0], round(event[1], 2)) for event in cues if event[0] != "tone"] == [
        ("whoosh", 0.0), ("ping", 7.1 - .35), ("boom", 22.5 - .35)
    ]
    tones = [event for event in cues if event[0] == "tone"]
    assert tones and round(tones[0][1], 2) == 0.0
    assert round(tones[-1][1] + tones[-1][3]["d"], 2) == 26.95
    assert tones[0][3]["f0"] < tones[4][3]["f1"]
    assert tones[5][3]["f1"] < tones[4][3]["f1"]


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
