"""A post layout refusal is a named end (fix 2 of fable-check-2): it happens before the encode, writes a failed out/report.json with the
blocking list, keeps the frames, and a rerun with a corrected inputs/overlay.json finishes without any second render.

Written by claude-pro, claude-sonnet-5-5.
"""
import inspect
import json

import pytest

from narrative_factory.codebuilt.post import cb5, cb5_main, media, run

from test_post_overlay_run import H, N, W, job_inputs, needs_ffmpeg, write

# A counter and a measure drawn at the same place: a blocking overlap, the shape of the Danube refusal.
BLOCKED = {"version": 1, "counter": {"value": "n", "format": "int", "from": 0, "to": 0.4},
           "measures": [{"a": "l", "b": "r", "text": "23 cm", "from": 0, "to": 0.4}]}
# The same text with the measure moved after the counter: nothing overlaps.
CORRECTED = {"version": 1, "counter": {"value": "n", "format": "int", "from": 0, "to": 0.4},
             "measures": [{"a": "l", "b": "r", "text": "23 cm", "from": 0.5, "to": 0.9}]}


def make_job(tmp_path, spec):
    job = tmp_path / "job"
    job.mkdir()
    job_inputs(job)
    (job / "inputs").mkdir()
    (job / "work").mkdir()
    write(job / "inputs" / "overlay.json", spec)
    write(job / "work" / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {
        str(i): {"p": {"l": [0.3, 0.12, 1], "r": [0.7, 0.12, 1]}, "v": {"n": 1.0}} for i in range(N)}})
    return job


def frame_bytes(job):
    return {p.name: p.read_bytes() for p in sorted((job / "frames").glob("*.png"))}


def test_check_layout_refuses_before_any_output_or_audio(tmp_path):
    job = make_job(tmp_path, BLOCKED)
    with pytest.raises(cb5.OverlayLayoutBlocked) as caught:
        cb5.check_layout(job / "frames", job / "words.json", job / "inputs" / "overlay.json", job / "work" / "anchors.json", job,
                         fps=run.FPS, lead=cb5.LEAD)
    assert str(caught.value) == "overlay_layout_blocked"
    assert caught.value.blocking and caught.value.blocking[0]["elements"]
    # The corrected spec in the job passes the same check.
    write(job / "inputs" / "overlay.json", CORRECTED)
    cb5.check_layout(job / "frames", job / "words.json", job / "inputs" / "overlay.json", job / "work" / "anchors.json", job,
                     fps=run.FPS, lead=cb5.LEAD)


def test_produce_refuses_before_the_audio_premix(tmp_path, monkeypatch):
    job = make_job(tmp_path, BLOCKED)
    monkeypatch.setattr(cb5.audio_kit, "synth_music", lambda *a, **k: pytest.fail("the audio premix ran before the layout check"))
    with pytest.raises(cb5.OverlayLayoutBlocked):
        cb5.produce(job)
    assert not (job / "out" / "audio").exists()


def test_produce_writes_a_failed_report_and_keeps_the_frames(tmp_path):
    job = make_job(tmp_path, BLOCKED)
    before = frame_bytes(job)
    with pytest.raises(cb5.OverlayLayoutBlocked):
        cb5.produce(job)
    report = json.loads((job / "out" / "report.json").read_text(encoding="utf-8"))
    assert report["status"] == "failed" and report["version"] == "codebuilt-cb5-v1"
    assert report["error"]["code"] == "overlay_layout_blocked"
    blocking = report["error"]["blocking"]
    assert blocking and set(blocking[0]) == {"code", "elements", "first_frame", "last_frame", "frames"}
    assert report["error"]["blocking_total"] == len(blocking)
    for name in ("video.mp4", "subtitles.srt", "contact_sheet.png"):
        assert not (job / "out" / name).exists()
    assert frame_bytes(job) == before


def test_main_prints_the_named_refusal_with_the_blocking_list(tmp_path, capsys):
    job = make_job(tmp_path, BLOCKED)
    assert cb5_main.main(["cb5_main.py", str(job)]) == 1
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["status"] == "error" and line["code"] == "overlay_layout_blocked"
    assert line["blocking"] and line["blocking_total"] == len(line["blocking"])


def test_blocking_list_is_bounded():
    many = [{"code": "overlap", "elements": [f"e{i}"] * 9, "first_frame": i, "last_frame": i, "frames": 1, "extra": "x" * 500}
            for i in range(100)]
    error = cb5.OverlayLayoutBlocked(many)
    assert len(error.blocking) == cb5.MAX_BLOCKING_REPORTED and error.total == 100
    assert all(len(item["elements"]) <= 4 and "extra" not in item for item in error.blocking)


def test_produce_has_no_caller_chosen_overlay_path():
    # A corrected overlay reaches the post step only as the host's own inputs/overlay.json (the runner replaces it after it checked the
    # frames, the build and every other input); a caller-supplied path would skip that identity check.
    assert "corrected_overlay" not in inspect.signature(cb5.produce).parameters


@needs_ffmpeg
def test_rerun_with_a_corrected_overlay_finishes_from_the_same_frames(tmp_path):
    job = make_job(tmp_path, BLOCKED)
    before = frame_bytes(job)
    with pytest.raises(cb5.OverlayLayoutBlocked):
        cb5.produce(job)
    write(job / "inputs" / "overlay.json", CORRECTED)
    report = cb5.produce(job)
    assert report["status"] == "ok"
    assert json.loads((job / "out" / "report.json").read_text(encoding="utf-8"))["status"] == "ok"
    for name in ("video.mp4", "subtitles.srt", "contact_sheet.png"):
        assert (job / "out" / name).stat().st_size > 0
    assert frame_bytes(job) == before   # no frame was rendered or rewritten
