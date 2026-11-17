import json
import os
import tempfile

import pytest

from blender_worker.codebuilt import anchors


def test_names_limits_and_finite_values():
    anchors.reset(1080, 1920)
    anchors.begin(0)
    anchors.mark("lid", (1, 2, 3))
    anchors.value("depth", 2.5)
    with pytest.raises(anchors.AnchorError, match="name"):
        anchors.mark("Bad", (0, 0, 0))
    with pytest.raises(anchors.AnchorError, match="finite"):
        anchors.value("depth", float("nan"))
    for i in range(1, anchors.MAX_POINTS_PER_FRAME):
        anchors.mark(f"p{i}", (0, 0, 0))
    with pytest.raises(anchors.AnchorError, match="too many points in frame"):
        anchors.mark("overflow", (0, 0, 0))
    for i in range(1, anchors.MAX_VALUES):
        anchors.value(f"v{i}", i)
    with pytest.raises(anchors.AnchorError, match="too many value names"):
        anchors.value("overflow", 1)


def test_marks_during_qa_poses_outside_renderloop_are_discarded():
    anchors.reset(1080, 1920)
    anchors.mark("preview_only", (0, 0, 0))
    anchors.value("depth", 9)
    assert not anchors.has_marks()
    anchors.begin(0)
    anchors.capture(0, None)
    assert anchors.document()["frames"] == {}


def test_global_name_limit_is_enforced_across_frames():
    anchors.reset(100, 200)
    for frame in range(anchors.MAX_POINTS):
        anchors.begin(frame)
        anchors.mark(f"p{frame:02d}", (0, 0, 0))
        anchors.capture(frame, lambda point: (0.5, 0.5, 1))
    anchors.begin(anchors.MAX_POINTS)
    with pytest.raises(anchors.AnchorError, match="too many point names"):
        anchors.mark("overflow", (0, 0, 0))


def test_projection_shape_front_and_values():
    anchors.reset(1080, 1920)
    anchors.begin(12)
    anchors.mark("lid", (1, 2, 3))
    anchors.mark("behind", (4, 5, 6))
    anchors.value("depth", 27.3)
    anchors.capture(12, lambda p: (p[0] / 10, p[1] / 10, 1 if p[2] == 3 else -1))
    assert anchors.document() == {
        "version": 1, "width": 1080, "height": 1920,
        "frames": {"12": {"p": {"lid": [0.1, 0.2, 1], "behind": [0.4, 0.5, 0]}, "v": {"depth": 27.3}}},
    }


def test_capture_requires_matching_frame_and_valid_projector():
    anchors.reset(1, 1)
    anchors.begin(3)
    anchors.mark("lid", (0, 0, 0))
    with pytest.raises(anchors.AnchorError, match="does not match"):
        anchors.capture(4, lambda _: (0, 0, 1))
    with pytest.raises(anchors.AnchorError, match="finite"):
        anchors.capture(3, lambda _: (0, float("inf"), 1))


def test_write_is_atomic_shape_and_no_file_without_marks():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "anchors.json")
        anchors.reset(1080, 1920)
        assert anchors.write(path) is False
        assert not os.path.exists(path)
        anchors.begin(0)
        anchors.value("depth", 1)
        anchors.capture(0, None)
        assert anchors.write(path) is True
        with open(path, encoding="utf-8") as handle:
            assert json.load(handle) == {
                "version": 1, "width": 1080, "height": 1920,
                "frames": {"0": {"p": {}, "v": {"depth": 1.0}}},
            }
        assert os.listdir(tmp) == ["anchors.json"]


def test_resume_keeps_entries_and_fills_missing_frame():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "anchors.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "width": 1080, "height": 1920,
                       "frames": {"0": {"p": {"old": [0.1, 0.2, 1]}, "v": {"depth": 2}}}}, handle)
        anchors.reset(1080, 1920, path)
        assert anchors.has_frame(0)
        anchors.begin(1)
        anchors.mark("new", (2, 0, 1))
        anchors.capture(1, lambda _: (0.7, 0.8, 4))
        anchors.write(path)
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        assert data["frames"]["0"] == {"p": {"old": [0.1, 0.2, 1]}, "v": {"depth": 2}}
        assert data["frames"]["1"] == {"p": {"new": [0.7, 0.8, 1]}, "v": {}}


def test_existing_file_must_match_contract_header():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "anchors.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "width": 10, "height": 10, "frames": {}}, handle)
        with pytest.raises(anchors.AnchorError, match="invalid header"):
            anchors.reset(11, 10, path)
