"""Overlay drawing, fit and hide rules, and every layout finding on a made-up case (KO1)."""
import json

import numpy as np
from PIL import Image

from narrative_factory.codebuilt.post import anchors_file, captions, overlay

W, H = 540, 960       # half size keeps the tests quick; every size scales with the frame


def spec(**parts):
    return overlay.validate_spec({"version": 1, **parts})


def anchors(frames):
    return anchors_file.parse(json.dumps({"version": 1, "width": 1080, "height": 1920, "frames": frames}).encode(), 300)


def still(frames=None, nframes=60):
    return anchors({str(f): {"p": {"a": [0.5, 0.45, 1]}} for f in range(nframes)} if frames is None else frames)


def kinds(ov, frame, t):
    return sorted(p["kind"] for p in ov.pieces(frame, t))


def test_counter_shows_for_its_window_and_draws_pixels():
    a = anchors({str(f): {"v": {"depth": f * 10.0}} for f in range(60)})
    ov = overlay.Overlay(spec(counter={"value": "depth", "format": "int_commas", "unit": "m", "label": "DEPTH", "from": 0.5, "to": 1.5}),
                         a, W, H)
    assert kinds(ov, 10, 10 / 30) == []
    assert kinds(ov, 30, 1.0) == ["counter"]
    assert ov.text_of(ov.pieces(30, 1.0)[0]) == "300 m"
    blank = Image.new("RGB", (W, H), (40, 40, 40))
    im = blank.copy()
    ov.draw(im, 30, 1.0)
    assert np.abs(np.asarray(im, int) - np.asarray(blank, int)).sum() > 0
    im2 = blank.copy()
    ov.draw(im2, 5, 5 / 30)
    assert np.array_equal(np.asarray(im2), np.asarray(blank))


def test_label_pops_in_at_from_and_points_at_its_anchor():
    ov = overlay.Overlay(spec(labels=[{"anchor": "a", "title": "DEEPEST MINE", "value": "4 km", "from": 1.0, "to": 2.0}]), still(), W, H)
    assert kinds(ov, 29, 0.99) == []
    early, late = ov.pieces(30, 1.0)[0], ov.pieces(45, 1.5)[0]
    assert early["scale"] < 1.0 <= late["scale"] + 1e-9
    x, y, w, h = late["box"]
    assert late["pointer"][0] == (0.5 * W, 0.45 * H)
    assert y + h <= 0.45 * H or y >= 0.45 * H      # the box sits above or below its anchor, never on it


def test_label_auto_side_is_away_from_the_anchor():
    right = anchors({str(f): {"p": {"a": [0.8, 0.5, 1]}} for f in range(60)})
    ov = overlay.Overlay(spec(labels=[{"anchor": "a", "title": "X", "from": 0, "to": 2}]), right, W, H)
    x, _, w, _ = ov.pieces(30, 1.0)[0]["box"]
    assert x + w / 2 < W / 2


def test_label_is_hidden_off_screen_or_behind_the_camera():
    frames = {"0": {"p": {"a": [0.5, 0.5, 1]}}, "1": {"p": {"a": [1.4, 0.5, 1]}}, "2": {"p": {"a": [0.5, -0.1, 1]}},
              "3": {"p": {"a": [0.5, 0.5, 0]}}, "4": {}}
    ov = overlay.Overlay(spec(labels=[{"anchor": "a", "title": "X", "from": 0, "to": 1}]), anchors(frames), W, H)
    assert [kinds(ov, f, f / 30) for f in range(5)] == [["label"], [], [], [], []]


def test_text_shrinks_to_the_safe_zone():
    ov = overlay.Overlay(spec(tag={"text": "WWWWWWWWWWWWWWWWWWWWWWWWWWWW", "from": 0, "to": 1},
                              big=[{"text": "88,888,888,888,888,888,888", "sub": "s" * 40, "from": 0, "to": 1}]), still(), W, H)
    left, top, right, bottom = captions.safe_zone(W, H)
    for p in ov.pieces(15, 0.5):
        x, y, w, h = p["box"]
        assert left <= x and x + w <= right and top <= y and y + h <= bottom, p


def test_fixed_elements_stack_instead_of_overlapping():
    a = anchors({str(f): {"v": {"n": 1.0}} for f in range(60)})
    ov = overlay.Overlay(spec(tag={"text": "KOLA", "from": 0, "to": 2}, counter={"value": "n", "format": "int", "from": 0, "to": 2},
                              big=[{"text": "0.2%", "sub": "of the way", "from": 0, "to": 2}]), a, W, H)
    rep = ov.layout_report(60)
    assert rep["ok"] and not rep["blocking"], rep


def test_a_label_with_no_free_place_is_hidden_not_drawn_over_another():
    labels = [{"anchor": "a", "title": f"LABEL {i}", "value": "1 km", "from": 0, "to": 1, "side": "left"} for i in range(3)]
    ov = overlay.Overlay(spec(labels=labels), still(), W, H)
    assert [p["id"] for p in ov.pieces(15, 0.5)] == ["labels[0]", "labels[1]"]
    rep = ov.layout_report(30)
    assert rep["ok"] and rep["blocking"] == []
    assert [(f["code"], f["elements"], f["share"]) for f in rep["findings"]] == [("label_hidden", ["labels[2]"], 1.0)]


def test_finding_overlap_blocks():
    a = anchors({str(f): {"p": {"l": [0.3, 0.12, 1], "r": [0.7, 0.12, 1]}, "v": {"n": 5.0}} for f in range(30)})
    ov = overlay.Overlay(spec(counter={"value": "n", "format": "int", "label": "N", "from": 0, "to": 1},
                              measures=[{"a": "l", "b": "r", "text": "23 cm", "from": 0, "to": 1}]), a, W, H)
    rep = ov.layout_report(30)
    assert not rep["ok"]
    assert [(f["code"], f["elements"]) for f in rep["blocking"]] == [("overlap", ["counter", "measures[0]"])]


def test_finding_caption_overlap_blocks():
    words = [{"w": "Past", "s": 0.0, "e": 0.3}, {"w": "the", "s": 0.3, "e": 0.5}, {"w": "mine.", "s": 0.5, "e": 1.0}]
    track = captions.Track(words, W, H)
    a = anchors({str(f): {"p": {"top": [0.5, 0.65, 1], "low": [0.5, 0.81, 1]}} for f in range(30)})
    ov = overlay.Overlay(spec(measures=[{"a": "top", "b": "low", "text": "6,371 km", "from": 0, "to": 1}]), a, W, H, captions_track=track)
    rep = ov.layout_report(30)
    assert not rep["ok"]
    assert {f["code"] for f in rep["blocking"]} == {"caption_overlap"}


def test_finding_outside_safe_zone_blocks():
    safe = captions.safe_zone(W, H)
    pieces = [{"kind": "label", "id": "labels[0]", "box": (0, 0, 50, 50)}, {"kind": "tag", "id": "tag", "box": (100, 200, 50, 50)}]
    found = overlay.frame_findings(pieces, None, safe)
    assert [(f[0], f[1]) for f in found] == [("outside_safe_zone", ("labels[0]",))]
    found = overlay.frame_findings([{"kind": "tag", "id": "tag", "box": (100, 200, 50, 50)}], (120, 220, 40, 40), safe)
    assert [(f[0], f[1]) for f in found] == [("caption_overlap", ("tag",))]


def test_finding_label_hidden_too_long_is_not_blocking():
    frames = {str(f): {"p": {"a": [0.5, 0.45, 1 if f < 15 else 0]}} for f in range(30)}
    rep = overlay.Overlay(spec(labels=[{"anchor": "a", "title": "X", "from": 0, "to": 1}]), anchors(frames), W, H).layout_report(30)
    assert rep["ok"]
    hidden = [f for f in rep["findings"] if f["code"] == "label_hidden"]
    assert hidden and hidden[0]["elements"] == ["labels[0]"] and 0.4 < hidden[0]["share"] < 0.6


def test_label_hidden_under_30_percent_is_fine():
    frames = {str(f): {"p": {"a": [0.5, 0.45, 1 if f < 25 else 0]}} for f in range(30)}
    rep = overlay.Overlay(spec(labels=[{"anchor": "a", "title": "X", "from": 0, "to": 1}]), anchors(frames), W, H).layout_report(30)
    assert rep["findings"] == []


def test_finding_counter_goes_down_and_up_again():
    vals = [0, 1, 2, 3, 2, 1, 2, 3, 4, 5]
    a = anchors({str(f): {"v": {"n": float(v)}} for f, v in enumerate(vals)})
    rep = overlay.Overlay(spec(counter={"value": "n", "format": "int", "from": 0, "to": 0.33}), a, W, H).layout_report(10)
    assert rep["ok"]
    assert [f["code"] for f in rep["findings"]] == ["counter_reversal"]
    one_way = anchors({str(f): {"v": {"n": float(f)}} for f in range(10)})
    assert overlay.Overlay(spec(counter={"value": "n", "format": "int", "from": 0, "to": 0.33}), one_way, W, H).layout_report(10)["findings"] == []


def test_measure_between_two_anchors():
    frames = {str(f): {"p": {"l": [0.3, 0.5, 1], "r": [0.7, 0.5, 1]}} for f in range(30)}
    ov = overlay.Overlay(spec(measures=[{"a": "l", "b": "r", "text": "23 cm", "from": 0, "to": 1}]), anchors(frames), W, H)
    p = ov.pieces(20, 20 / 30)[0]
    assert p["kind"] == "measure" and p["line"][0][0] < p["line"][1][0]
    x, y, w, h = p["box"]
    assert y + h <= 0.5 * H
    one_missing = {str(f): {"p": {"l": [0.3, 0.5, 1]}} for f in range(30)}
    assert overlay.Overlay(spec(measures=[{"a": "l", "b": "r", "text": "23 cm", "from": 0, "to": 1}]), anchors(one_missing), W, H).pieces(20, 0.6) == []


def test_bar_fill_follows_its_value():
    a = anchors({str(f): {"v": {"heat": f * 6.0}} for f in range(31)})
    ov = overlay.Overlay(spec(bars=[{"value": "heat", "label": "HEAT", "min": 0, "max": 180, "from": 0, "to": 1.0}]), a, W, H)
    assert abs(ov.pieces(15, 0.5)[0]["fill"] - 0.5) < 1e-9
    assert ov.pieces(0, 0.0)[0]["fill"] == 0.0


def test_draw_never_touches_pixels_without_a_spec():
    ov = overlay.Overlay(spec(), anchors_file.Anchors.empty(1080, 1920), W, H)
    im = Image.new("RGB", (W, H), (1, 2, 3))
    ov.draw(im, 0, 0.0)
    assert im.getpixel((W // 2, H // 2)) == (1, 2, 3)
    assert ov.layout_report(10) == {"version": 1, "frames_checked": 10, "ok": True, "blocking": [], "findings": []}
