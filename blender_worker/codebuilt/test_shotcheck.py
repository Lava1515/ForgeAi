"""Regressions from proof runs 6 and 7 (2026-11-13); no Blender required."""
import math

from blender_worker.codebuilt import shotcheck as qa


def test_readout_width_matches_seventy_percent_contract_and_allows_stricter_callers():
    assert qa.MAX_READOUT_FRAME_SHARE == 0.70
    assert not qa.readout_too_wide((0.15, 0.85, 0.4, 0.6, 2))
    assert qa.readout_too_wide((0.149, 0.851, 0.4, 0.6, 2))
    assert qa.readout_too_wide((0.1, 0.9, 0.4, 0.6, 2), max_share=0.6)


def test_readout_depth_ignores_nearby_content_outside_its_screen_box():
    class Readout(dict):
        name = "hud_70kg"

    class Probe:
        blocked = False

        def update(self):
            pass

        def text_objects(self):
            return [Readout(codebuilt_readout=True)]

        def text_box(self, _):
            return (0.3, 0.7, 0.6, 0.8, 2.1)

        def subject_depth(self):
            return 0.1  # the old scene-wide query would refuse every frame

        def content(self):
            return [
                {"name": "ground", "pts": [(0.5, 0.1, 0.1)]},
                {"name": "offscreen", "pts": [(1.5, 0.7, 0.2)]},
                {"name": "wall", "scenery": True, "pts": [(0.5, 0.7, 0.3)]},
                {"name": "behind_camera", "pts": [(0.5, 0.7, -1.0)]},
                {"name": "person_torso", "pts": [(0.5, 0.7, 1.35 if self.blocked else 3.0)]},
            ]

        def cam_target(self):
            return (0, 0, 0)

        def cam_pose(self):
            return ((0, -5, 0), 50)

    probe = Probe()
    report = qa.run_qa_with(probe, lambda _: None, 148, [("shot-2", 128, 148)], hold=1)
    assert report["ok"]
    probe.blocked = True
    report = qa.run_qa_with(probe, lambda _: None, 148, [("shot-2", 128, 148)], hold=1)
    assert not report["ok"]
    message = qa.describe(report)
    for text in ("hud_70kg", "person_torso", "shot-2", "2.10 m", "1.35 m", "128-147", "move the readout"):
        assert text in message
    assert len(message) <= qa.FAILURE_MAX_CHARS


def test_thirteen_shots_can_reuse_a_composition_after_two_intervening_shots():
    shots = []
    for i in range(13):
        angle = math.radians((i % 3) * 60)
        shots.append({"pos": (5 * math.sin(angle), -5 * math.cos(angle), 0), "target": (0, 0, 0)})
    assert qa.check_shot_variety(shots) == []
    shots[2] = shots[0]
    assert (0, 2) in qa.check_shot_variety(shots)
    shots[1] = shots[0]
    assert (0, 1) in qa.check_shot_variety(shots)


def test_text_frame_factor_keeps_persistent_labels_inside_safe_area():
    from .shotcheck import text_frame_factor, box_in_safe
    box = (.768, 1.037, .658, .715, 10)
    factor = text_frame_factor(box)
    assert 0 < factor < 1
    fitted = tuple(.5 + (v - .5) * factor for v in box[:4]) + (box[4],)
    assert box_in_safe(fitted)
    assert text_frame_factor((.4, .6, .4, .6, 10)) == 1


def test_clipped_diagnostic_keeps_name_and_frame_paired():
    from .shotcheck import describe
    message = describe({'ok': False, 'text_clipped': [(0, 'tagw', (0, 1, 0, 1, 5)),
                                                     (384, 'rd_clasts', (0, 1, 0, 1, 1))],
                        'same_composition': [], 'missing_target': []})
    assert "'tagw' at frames 0-0" in message
    assert "'rd_clasts' at frames 384-384" in message


# ---- fix lane F2 (2026-11-16): 92 of 310 look rounds had no pictures because a kit check stopped the preview, 31 of them on
# "shots share one composition", which also refused a map tour of different countries at one tilt.
import pytest


class _TwoShotProbe:
    """Two shots in one place; the camera pose and what is in view are chosen per shot."""

    def __init__(self, poses, content=None, targets=True):
        self.poses, self.content_by_shot, self.targets, self.frame = poses, content, targets, 0

    def at(self, f):
        self.frame = f

    def _shot(self):
        return 0 if self.frame < 40 else 1

    def update(self):
        pass

    def text_objects(self):
        return []

    def text_box(self, _):
        return None

    def content(self):
        names = self.content_by_shot[self._shot()] if self.content_by_shot else {"hero": "red"}
        return [{"name": n, "pts": [(0.5, 0.5, 5.0), (0.5, 0.7, 5.0)], "look": look,
                 "box": ((-1, -1, 0), (1, 1, 2))} for n, look in names.items()]

    def cam_target(self):
        return self.poses[self._shot()][1] if self.targets else None

    def cam_pose(self):
        return (self.poses[self._shot()][0], 50)


RANGES = [("place-map", 0, 40), ("place-map", 40, 80)]
SAME = [((0, -5, 2), (0, 0, 0)), ((0, -5, 2), (0, 0, 0))]


def _report(probe):
    return qa.run_qa_with(probe, probe.at, 80, RANGES, hold=1)


def test_failed_variety_check_no_longer_stops_a_preview_but_still_stops_the_final_render():
    probe = _TwoShotProbe(SAME)
    report = _report(probe)
    assert report["same_composition"] == [(0, 1)] and not report["ok"] and not report["hard"]
    qa.enforce(report, probe.at, preview=True)          # the preview renders; the finding travels in the report
    assert qa.qa_passed()
    assert [f["check"] for f in report["findings"]] == ["same_composition"]
    with pytest.raises(qa.QAError):
        qa.enforce(report, probe.at)                    # final render: the hard stop stays
    assert not qa.qa_passed()


def test_same_composition_message_carries_the_camera_numbers():
    message = qa.describe(_report(_TwoShotProbe(SAME)))
    for text in ("shots share one composition: shot 0 and shot 1", "azimuth 0", "elevation 22", "distance 5.4 m",
                 "lens 50 mm", "all shot cameras"):
        assert text in message
    assert len(message) <= qa.FAILURE_MAX_CHARS


def test_a_shot_that_never_aimed_the_camera_stops_a_preview_too():
    probe = _TwoShotProbe(SAME, targets=False)
    report = _report(probe)
    assert report["hard"] and report["missing_target"]
    with pytest.raises(qa.QAError):
        qa.enforce(report, probe.at, preview=True)
    assert not qa.qa_passed()


def test_a_tour_of_different_targets_at_one_tilt_is_not_one_composition():
    tilt = lambda x: {"pos": (x, -3, 9), "target": (x, 0, 0), "lens": 35}
    assert qa.check_shot_variety([tilt(0), tilt(6), tilt(12)]) == []        # three countries, one camera tilt
    assert qa.check_shot_variety([tilt(0), tilt(0.5)]) == [(0, 1)]           # a nudge is not a new place
    assert _report(_TwoShotProbe([((0, -5, 2), (0, 0, 0)), ((20, -5, 2), (20, 0, 0))]))["ok"]


def test_a_held_shot_is_allowed_when_something_new_lands_and_reported_when_nothing_does():
    held = lambda content: _report(_TwoShotProbe(SAME, content))
    assert held([{"map": "grey"}, {"map": "grey", "label_fr": None}])["ok"]                  # a label lands
    assert held([{"map": "grey", "fr": "grey"}, {"map": "grey", "fr": "gold"}])["ok"]        # a fill lands
    assert held([{"map": "grey", "fr": "gold"}, {"map": "grey", "fr": "gold"}])["same_composition"] == [(0, 1)]
    assert held([{"map": "grey", "label_fr": None}, {"map": "grey"}])["same_composition"] == [(0, 1)]   # only less


def test_framing_numbers_name_what_the_camera_is_aimed_at_and_its_edge_cuts():
    objs = [{"name": "ground", "pts": [(-3, -3, 5), (4, 4, 5)], "box": ((-900, -900, -1), (900, 900, 0))},
            {"name": "sky", "scenery": True, "pts": [(0.5, 0.5, 5)], "box": ((-2, -2, 0), (2, 2, 2))},
            {"name": "hero", "pts": [(0.45, 0.4, 5), (0.55, 0.5, 5)], "box": ((-0.5, -0.5, 0), (0.5, 0.5, 1.8))}]
    seen = qa.measure_framing(objs, (0, -8, 1), (0, 0, 1))
    assert seen["subject"] == "hero" and seen["h"] == 0.1 and seen["cut"] == []
    objs[2]["pts"] = [(-0.2, 0.4, 5), (0.55, 1.3, 5)]
    assert qa.measure_framing(objs, (0, -8, 1), (0, 0, 1))["cut"] == ["left", "top"]
    assert qa.measure_framing(objs[:2], (0, -8, 1), (0, 0, 1)) == {"subject": None}
