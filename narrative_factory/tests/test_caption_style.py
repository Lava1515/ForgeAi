# codex · gpt-6.1-sol · 2026-11-18 20:08 +02:00
"""M5 regressions: route style, persistent emphasis and safe caption envelopes."""
import pytest
from PIL import Image
from narrative_factory.codebuilt.post import captions


def words():
    return [{"w": "Extraordinary", "s": 1, "e": 1.2},
            {"w": "through", "s": 2, "e": 2.2},
            {"w": "42.", "s": 2.2, "e": 2.4}]


def test_overlay_grouping_ignores_char_cap_and_pause():
    assert len(captions.Track(words(), 1080, 1920).chunks) == 2
    track = captions.Track(words(), 1080, 1920, style="overlay")
    assert len(track.chunks) == 1
    assert track.font.size == 92
    assert track.at(.969) is None
    assert track.at(.97)[2] == pytest.approx(.7)
    assert track.at(1.13)[2] == pytest.approx(1)
    assert track.at(2.749) is not None
    assert track.at(2.75) is None
    assert 1 < max(captions.overlay_pop(i / 10000) for i in range(1601)) < 1.031


def test_emphasis_persists_and_explicit_boolean_overrides_generic_rule():
    assert captions.keyword({"w": "42"})
    assert captions.keyword({"w": "bridge"})
    assert not captions.keyword({"w": "through"})
    assert not captions.keyword({"w": "bridge", "emphasis": False})
    assert captions.keyword({"w": "a", "emphasis": True})
    ch = [{"w": "Bridge", "s": 1, "e": 1.2}, {"w": "42", "s": 1.2, "e": 1.4}]
    tr = captions.Track(ch, 1080, 1920, style="overlay")
    assert tr.at(.98)[1] == -1  # no yellow before spoken
    early = captions.layer(tr.chunks[0], 0, tr.font, "overlay")
    late = captions.layer(tr.chunks[0], 1, tr.font, "overlay")
    yellow = (255, 214, 10, 255)
    early_yellow = {i for i, p in enumerate(early.getdata()) if p == yellow}
    late_yellow = {i for i, p in enumerate(late.getdata()) if p == yellow}
    assert early_yellow and early_yellow < late_yellow


@pytest.mark.parametrize("size", [(1080, 1920), (540, 960), (216, 384)])
def test_drawn_boxes_stay_in_conservative_envelope_and_safe_zone(size):
    tr = captions.Track(words(), *size, style="overlay")
    envelope = tr.box(0, 0)
    assert captions.inside_safe_zone(envelope, *size)
    assert envelope[2] <= round(920 * size[0] / 1080)
    assert envelope[1] + envelope[3] // 2 == round(1354 * size[1] / 1920)
    for i in range(18):
        im = Image.new("RGB", size)
        box = tr.draw(im, .97 + i / 100)
        assert captions.inside_safe_zone(box, *size)
        assert box[2] <= envelope[2] and box[3] <= envelope[3]


def test_unknown_style_rejected():
    with pytest.raises(ValueError, match="style"):
        captions.Track(words(), 1080, 1920, style="other")
