"""E1b: the ending of a video is voiced with its own lift (owner order 2026-11-15, plan E1-endings-that-land).

Observed damage these tests guard: the last line of every draft was read in the same plain narrator as the rest (the code-built voice call sent no
deliveries) and the one-tone-change rule could never give the hook AND the ending their own tone. Each test drives the real tts_engine code path
with only the GPU synthesis stubbed, so what is asserted is what the factory would really tell the voice and report back per sentence.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import story_tone  # noqa: E402
import tts_engine  # noqa: E402

SCENES = [
    "Two crews started digging from opposite sides.",
    "One crew started near the north. The other started near the south.",
    "Giant machines chewed through the rock for years.",
    "They met in the middle with centimeters to spare. Nobody could believe it.",
]
FEELS = ["curious", "building", "building", "amazed"]
CALM_CLOSE = "calm, thoughtful close"


def voiced_sentences(tmp_path, scenes, deliveries):
    """What /api/tts-timed reports per sentence: the real _generate_segments, only the GPU synthesis replaced by silence-free noise."""
    engine = tts_engine.Qwen3Engine()
    engine._synthesize = lambda flat, instructs, temps, speaker, **kw: ([np.full(2400, 0.1, dtype=np.float32) for _ in flat], 24000)
    _path, _total, spans, sentences = engine._generate_segments(scenes, tmp_path / "voice.wav", voice="ryan", dynamic_tone=True, deliveries=deliveries)
    assert len(spans) == len(scenes)
    return sentences


def test_hook_and_last_sentence_get_their_own_tone_and_the_middle_stays_plain(tmp_path):
    sentences = voiced_sentences(tmp_path, SCENES, FEELS)
    tones = [s.tone for s in sentences]
    assert len(tones) == 6
    assert "curious" in tones[0] and tones[0].startswith(story_tone.NARRATOR)
    assert "bright, impressed, a smile in the voice" in tones[-1]
    assert all(t == story_tone.NARRATOR for t in tones[1:-1]), tones  # the last scene's first sentence shares the scene's feel but is not the ending
    assert not any(CALM_CLOSE in t for t in tones)


def test_a_caller_that_sends_no_deliveries_is_voiced_exactly_as_before(tmp_path):
    tones = [s.tone for s in voiced_sentences(tmp_path, SCENES, None)]
    assert tones == [story_tone.NARRATOR] * 6


def test_the_default_arc_closes_bright_and_not_calm():
    sentences = [f"Sentence number {i}." for i in range(12)]
    specs = story_tone.compute_story_arc_tones(sentences, directions=None)
    assert "bright, confident payoff, a smile in the voice" in specs[-1][1]
    assert not any(CALM_CLOSE in spec[1] for spec in specs)


def test_older_planner_directions_still_keep_one_deliberate_change():
    n = story_tone.normalize_deliveries
    assert n(["", "lively, interested", "", ""]) == ["", "lively, interested", "", ""]
    assert n(["hook, confident", "", "clear emphasis on the key point", ""]) == ["hook, confident", "", "", ""]
    assert n(None, 3) == ["", "", ""] and n(["hook, confident"], 3) == ["hook, confident", "", ""]


def test_never_more_than_the_hook_and_the_ending_change_tone():
    out = story_tone.normalize_deliveries(["curious", "intrigued", "building", "surprised", "playful", "amazed"])
    assert [bool(x) for x in out] == [True, False, False, False, False, True]
    assert len(out) == 6


def test_every_feel_maps_to_a_mild_hint_that_survives_the_sanitizer():
    # The sanitizer strips acted-delivery words (for example "punch..."); a hint it would cut is no hint at all.
    for feel in ["curious", "intrigued", "building", "surprised", "amazed", "playful", "satisfied"]:
        hint = story_tone.feel_hint(feel)
        assert hint and story_tone.sanitize_delivery(hint) == hint, feel
        assert not any(bad in hint for bad in ["whisper", "slow", "sad", "soft", "quiet"]), hint
    assert story_tone.feel_hint("curious ") == story_tone.feel_hint("Curious")
    assert story_tone.feel_hint("some planner direction") == "some planner direction"  # not a feel word: passes through unchanged
