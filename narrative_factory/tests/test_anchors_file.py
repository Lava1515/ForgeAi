"""anchors.json untrusted reader (KO1, contract 2.2)."""
import json

import pytest

from narrative_factory.codebuilt.post import anchors_file as af


def doc(frames=None, **top):
    base = {"version": 1, "width": 1080, "height": 1920,
            "frames": frames if frames is not None else {"0": {"p": {"lid": [0.512, 0.431, 1]}, "v": {"depth": 0.0}}}}
    base.update(top)
    return base


def parse(obj, nframes=10):
    return af.parse(json.dumps(obj).encode("utf-8"), nframes)


def test_plan_example_reads():
    a = parse(doc())
    assert (a.width, a.height) == (1080, 1920)
    assert a.point(0, "lid") == (0.512, 0.431, True)
    assert a.value(0, "depth") == 0.0
    assert a.point(1, "lid") is None


def test_load_reads_a_file(tmp_path):
    p = tmp_path / "anchors.json"
    p.write_text(json.dumps(doc()), encoding="utf-8")
    assert af.load(p, 5, job_root=tmp_path).point(0, "lid")[2] is True


def test_p_and_v_may_be_absent():
    a = parse(doc({"0": {"p": {"a": [0.5, 0.5, 0]}}, "1": {"v": {"n": 2}}, "2": {}}))
    assert a.point(0, "a") == (0.5, 0.5, False)
    assert a.value(1, "n") == 2.0


def test_values_hold_between_frames():
    a = parse(doc({"2": {"v": {"n": 5}}, "6": {"v": {"n": 9}}}))
    assert [a.value(f, "n") for f in range(9)] == [5, 5, 5, 5, 5, 5, 9, 9, 9]
    assert a.value(3, "other") is None


def test_xy_are_clamped():
    a = parse(doc({"0": {"p": {"a": [-50, 99.5, 1]}}}))
    assert a.point(0, "a")[:2] == (-2.0, 3.0)


@pytest.mark.parametrize("obj,needle", [
    ([], "object"),
    (doc(version=2), "version"),
    (doc(extra=1), "unknown key"),
    ({"version": 1, "width": 1080, "height": 1920}, "frames"),
    (doc(width=0), "width"),
    (doc(width=True), "width"),
    (doc(height=1920.5), "height"),
    (doc({"10": {}}), "frame"),
    (doc({"-1": {}}), "frame"),
    (doc({"01": {}}), "frame"),
    (doc({"x": {}}), "frame"),
    (doc({"0": []}), "frame 0"),
    (doc({"0": {"q": {}}}), "unknown key"),
    (doc({"0": {"p": {"Lid": [0, 0, 1]}}}), "name"),
    (doc({"0": {"p": {"a" * 25: [0, 0, 1]}}}), "name"),
    (doc({"0": {"p": {"a": [0, 0]}}}), "point"),
    (doc({"0": {"p": {"a": [0, "0", 1]}}}), "number"),
    (doc({"0": {"p": {"a": [0, True, 1]}}}), "number"),
    (doc({"0": {"p": {"a": [0, 0, 2]}}}), "front"),
    (doc({"0": {"p": {"a": [0, 0, 0.5]}}}), "front"),
    (doc({"0": {"v": {"n": "1"}}}), "number"),
    (doc({"0": {"v": {"n": [1]}}}), "number"),
    (doc({"0": {"p": {f"p{i}": [0, 0, 1] for i in range(25)}}}), "24"),
    (doc({str(f): {"p": {f"p{f}_{i}": [0, 0, 1] for i in range(13)}} for f in range(5)}), "64"),
    (doc({"0": {"v": {f"v{i}": 1 for i in range(5)}}}), "4"),
])
def test_bad_files_fail_with_a_named_error(obj, needle):
    with pytest.raises(af.AnchorsError) as err:
        parse(obj)
    assert needle in str(err.value)
    assert str(err.value).startswith("anchors.json")


@pytest.mark.parametrize("raw", [b'{"version": 1, "width": NaN}', b'{"version": 1, "width": Infinity}', b"{", b"\xff\xfe",
                                 b'{"version":1,"width":1080,"height":1920,"frames":{"0":{"v":{"n":1e999}}}}',
                                 b'{"version":1,"version":1,"width":1080,"height":1920,"frames":{}}',
                                 b"[" * 100000 + b"]" * 100000],
                         ids=["nan", "infinity", "cut", "not-utf8", "overflow", "duplicate-key", "deep-nesting"])
def test_not_json_or_non_finite(raw):
    with pytest.raises(af.AnchorsError):
        af.parse(raw, 10)


def test_size_cap(tmp_path):
    p = tmp_path / "anchors.json"
    p.write_bytes(b" " * (af.MAX_BYTES + 1))
    with pytest.raises(af.AnchorsError, match="8 MB"):
        af.load(p, 10, job_root=tmp_path)


def test_a_file_never_carries_text():
    with pytest.raises(af.AnchorsError):
        parse(doc({"0": {"t": "HELLO"}}))
    with pytest.raises(af.AnchorsError):
        parse(doc({"0": {"p": {"a": [0, 0, 1, "TEXT"]}}}))


def test_empty_is_usable():
    a = af.Anchors.empty(1080, 1920)
    assert a.point(0, "x") is None and a.value(0, "x") is None
