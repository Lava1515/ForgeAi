"""overlay.json reader (KO1, contract 2.3), tested on the shared fixtures in tests/fixtures/overlay (the JS validator of KB1 uses the same)."""
import json
from pathlib import Path

import pytest

from narrative_factory.codebuilt.post import overlay

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "overlay"
CASES = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))["cases"]


def test_fixture_folder_has_both_kinds():
    assert sum(c["ok"] for c in CASES) >= 5
    assert sum(not c["ok"] for c in CASES) >= 40
    codes = {c["code"] for c in CASES if not c["ok"]}
    assert codes == set(overlay.SPEC_ERROR_CODES)


@pytest.mark.parametrize("case", CASES, ids=[c["file"] for c in CASES])
def test_shared_fixture(case):
    raw = (FIXTURES / case["file"]).read_bytes()
    if case["ok"]:
        spec = overlay.parse_spec(raw, video_seconds=case["videoSeconds"])
        assert spec["version"] == 1
        for key in ("labels", "measures", "bars", "big"):
            assert isinstance(spec[key], list)
    else:
        with pytest.raises(overlay.SpecError) as err:
            overlay.parse_spec(raw, video_seconds=case["videoSeconds"])
        assert (err.value.code, err.value.where) == (case["code"], case["where"])


def test_load_spec_reads_a_file_and_fills_defaults(tmp_path):
    p = tmp_path / "overlay.json"
    p.write_text(json.dumps({"version": 1, "labels": [{"anchor": "a", "title": "A", "from": 0, "to": 1}]}), encoding="utf-8")
    spec = overlay.load_spec(p, video_seconds=2, job_root=tmp_path)
    assert spec["labels"][0]["side"] == "auto"
    assert spec["counter"] is None and spec["tag"] is None and spec["bars"] == []


def test_load_spec_refuses_a_big_file_before_reading(tmp_path):
    p = tmp_path / "overlay.json"
    p.write_bytes(b" " * (overlay.MAX_SPEC_BYTES + 1))
    with pytest.raises(overlay.SpecError) as err:
        overlay.load_spec(p, job_root=tmp_path)
    assert err.value.code == "too_large"


def test_load_spec_needs_a_regular_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        overlay.load_spec(tmp_path, job_root=tmp_path)


def test_names_used_lists_every_anchor_and_value():
    spec = overlay.parse_spec((FIXTURES / "valid" / "plan-example.json").read_bytes())
    assert overlay.names_used(spec) == {"points": {"mine", "lid_l", "lid_r"}, "values": {"depth", "heat"}}


@pytest.mark.parametrize("fmt,value,text", [
    ("int", 12261.5, "12262"), ("int", -3.5, "-4"), ("int_commas", 12262.0, "12,262"), ("int_commas", 999.4, "999"),
    ("one_decimal", 4.35, "4.4"), ("two_decimals", 0.199, "0.20"), ("year", 1989.2, "1989"), ("times", 3.0, "3×"),
    ("times", 2.5, "2.5×"), ("int_commas", 1234567, "1,234,567"),
])
def test_named_formats(fmt, value, text):
    assert overlay.format_value(value, fmt) == text
