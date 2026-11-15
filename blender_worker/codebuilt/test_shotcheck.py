"""Regressions from proof runs 6 and 7 (2026-11-13); no Blender required."""
import math

from blender_worker.codebuilt import shotcheck as qa


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
