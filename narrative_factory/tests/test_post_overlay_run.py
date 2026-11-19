"""run.finish and cb5.produce with and without the overlay (KO1). Jobs without overlay.json must report exactly as before."""
import json
import wave

import numpy as np
import pytest
from PIL import Image

from narrative_factory.codebuilt.post import cb5, media, run

try:
    media.resolve_ffmpeg()
    HAVE_FFMPEG = True
except media.MediaError:
    HAVE_FFMPEG = False
needs_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="no ffmpeg")

# The report of run.finish on 67cbb08 (before KO1). A job without the overlay must keep exactly these keys.
OLD_KEYS = {"version", "video", "subtitles", "contact_sheet", "probe", "probe_problems", "subtitle_check", "captions", "ok"}
OLD_CAPTION_KEYS = {"groups", "cues", "lead", "all_inside_safe_zone", "safe_zone", "boxes_outside"}
W, H, N = 216, 384, 30


def job_inputs(tmp_path):
    frames = tmp_path / "frames"
    frames.mkdir()
    for i in range(N):
        Image.fromarray(np.full((H, W, 3), 20 + i * 5, np.uint8)).save(frames / f"{i:04d}.png")
    words = tmp_path / "words.json"
    words.write_text(json.dumps({"dur": 0.3, "words": [{"w": "Deep", "s": 0.0, "e": 0.15}, {"w": "hole.", "s": 0.15, "e": 0.3}]}),
                     encoding="utf-8")
    audio = tmp_path / "mix.wav"
    with wave.open(str(audio), "wb") as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(24000)
        tone = (np.sin(np.arange(24000 * N // 30) * 2 * np.pi * 220 / 24000) * 8000).astype("<i2")
        f.writeframes(tone.tobytes())
    return frames, words, audio


def write(path, obj):
    path.write_text(json.dumps(obj), encoding="utf-8")
    return path


@needs_ffmpeg
def test_finish_without_overlay_keeps_the_old_report(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    rep = run.finish(frames, words, audio, tmp_path / "out", "short")
    assert set(rep) == OLD_KEYS
    assert set(rep["captions"]) == OLD_CAPTION_KEYS
    assert rep["ok"] is True


@needs_ffmpeg
def test_finish_with_overlay_adds_a_block_and_draws(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "counter": {"value": "n", "format": "int", "label": "N", "from": 0, "to": 0.4},
                                             "labels": [{"anchor": "a", "title": "HERE", "from": 0, "to": 0.4}]})
    anchors = write(tmp_path / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {
        str(i): {"p": {"a": [0.5, 0.45, 1]}, "v": {"n": float(i)}} for i in range(N)}})
    plain = run.finish(frames, words, audio, tmp_path / "plain", "short")
    rep = run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, anchors=anchors)
    assert set(rep) == OLD_KEYS | {"overlay"}
    block = rep["overlay"]
    assert block["elements"] == {"counter": 1, "labels": 1, "measures": 0, "bars": 0, "big": 0, "tag": 0}
    assert block["layout"]["frames_checked"] == N
    assert rep["ok"] is block["layout"]["ok"] is True
    assert plain["ok"] is True and "overlay" not in plain
    assert (tmp_path / "out" / "short.mp4").read_bytes() != (tmp_path / "plain" / "short.mp4").read_bytes()   # the text was drawn


@needs_ffmpeg
def test_hyperframes_failure_finishes_with_legacy_text(tmp_path, monkeypatch, caplog):
    # codex · gpt-6.1-sol · 2026-11-19 14:52 +02:00: a failed optional text renderer must not lose a job.
    from narrative_factory.codebuilt.post import hyperframes_text
    job_inputs(tmp_path)
    (tmp_path / "inputs").mkdir()
    spec = write(tmp_path / "inputs" / "overlay.json", {
        "version": 1, "tag": {"text": "LEGACY TEXT", "from": 0, "to": 0.9}})
    calls = []
    original = run.finish

    def finish(*args, **kwargs):
        calls.append(kwargs)
        return original(*args, **kwargs)

    def fail(*args, **kwargs):
        raise media.MediaError("browser render failed")

    monkeypatch.setattr(run, "finish", finish)
    monkeypatch.setattr(hyperframes_text, "finish", fail)
    report = cb5.produce(tmp_path, hyperframes=True)
    assert report["status"] == "ok"
    assert len(calls) == 2 and calls[0]["draw_text"] is False
    assert calls[1].get("draw_text", True) is True and calls[1]["overlay_spec"] == spec
    assert report["post"]["overlay"]["elements"]["tag"] == 1
    assert report["post"]["captions"]["groups"] > 0
    assert report["post"]["hyperframes"] == {"status": "fallback", "reason": "MediaError: browser render failed"}
    saved = json.loads((tmp_path / "out" / "report.json").read_text(encoding="utf-8"))
    assert saved["post"]["hyperframes"] == report["post"]["hyperframes"]
    assert "browser render failed" in caplog.text
    assert media.probe(tmp_path / "out" / "video.mp4")["duration"] == N / run.FPS
    for name in ("video.mp4", "subtitles.srt", "contact_sheet.png"):
        assert (tmp_path / "out" / name).stat().st_size > 0


@needs_ffmpeg
def test_blocking_layout_finding_sets_ok_false(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "counter": {"value": "n", "format": "int", "from": 0, "to": 0.9},
                                             "measures": [{"a": "l", "b": "r", "text": "23 cm", "from": 0, "to": 0.9}]})
    anchors = write(tmp_path / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {
        str(i): {"p": {"l": [0.3, 0.12, 1], "r": [0.7, 0.12, 1]}, "v": {"n": 1.0}} for i in range(N)}})
    rep = run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, anchors=anchors)
    assert rep["ok"] is False
    assert rep["overlay"]["layout"]["blocking"]


def test_bad_anchors_fail_before_anything_is_drawn(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "labels": [{"anchor": "a", "title": "X", "from": 0, "to": 0.3}]})
    anchors = write(tmp_path / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {"999": {}}})
    from narrative_factory.codebuilt.post import anchors_file
    with pytest.raises(anchors_file.AnchorsError):
        run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, anchors=anchors)
    assert not (tmp_path / "out" / "short.mp4").exists()


def test_spec_naming_anchors_needs_the_anchors_file(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "labels": [{"anchor": "a", "title": "X", "from": 0, "to": 0.3}]})
    with pytest.raises(media.MediaError, match="anchors.json"):
        run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec)


def test_overlay_readers_refuse_outside_job_and_symlink(tmp_path):
    from narrative_factory.codebuilt.post import anchors_file, overlay
    job = tmp_path / "job"
    job.mkdir()
    outside = write(tmp_path / "outside.json", {"version": 1})
    for path in (outside, job / ".." / "outside.json"):
        with pytest.raises(media.MediaError, match="would leave"):
            overlay.load_spec(path, job_root=job)
        with pytest.raises(media.MediaError, match="would leave"):
            anchors_file.load(path, 30, job_root=job)
    link = job / "link.json"
    try:
        link.symlink_to(outside)
    except OSError:
        return  # Windows may not grant symlink creation; direct traversal is still checked above.
    with pytest.raises(media.MediaError, match="would leave"):
        overlay.load_spec(link, job_root=job)
    with pytest.raises(media.MediaError, match="would leave"):
        anchors_file.load(link, 30, job_root=job)


def test_finish_checks_overlay_duration_and_input_root(tmp_path):
    from narrative_factory.codebuilt.post import overlay
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "tag": {"text": "OK", "from": 0, "to": 999}})
    with pytest.raises(overlay.SpecError, match="bad_time"):
        run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec)
    with pytest.raises(media.MediaError, match="would leave"):
        run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, job_root=tmp_path / "frames")
    for fps in (0, -1, float("nan"), float("inf"), True):
        with pytest.raises(media.MediaError, match="fps"):
            run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, fps=fps)
    assert not (tmp_path / "out" / "short.mp4").exists()


def test_missing_counter_value_is_a_named_error(tmp_path):
    frames, words, audio = job_inputs(tmp_path)
    spec = write(tmp_path / "overlay.json", {"version": 1, "counter": {"value": "n", "format": "int", "from": 0, "to": 0.5}})
    marks = write(tmp_path / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {}})
    with pytest.raises(media.MediaError, match="anchors.json: missing referenced names: n"):
        run.finish(frames, words, audio, tmp_path / "out", "short", overlay_spec=spec, anchors=marks)


def _fake_cb5_job(tmp_path, monkeypatch):
    job = tmp_path / "job"
    frames, words, audio = job_inputs(job.mkdir() or job)
    seen = {}

    def fake_finish(frames_dir, words_json, audio_path, out_dir, name, **kw):
        seen.update(kw)
        out = media.safe_out_dir(out_dir)
        for suffix in (".mp4", ".srt"):
            (out / f"{name}{suffix}").write_bytes(b"x")
        Image.new("RGB", (4, 4)).save(out / f"{name}_sheet.jpg", format="JPEG")
        return {"ok": True, "video": str(out / f"{name}.mp4"), "subtitles": str(out / f"{name}.srt"),
                "contact_sheet": str(out / f"{name}_sheet.jpg")}
    monkeypatch.setattr(run, "finish", fake_finish)
    return job, seen


def test_cb5_without_overlay_passes_nothing_new(tmp_path, monkeypatch):
    job, seen = _fake_cb5_job(tmp_path, monkeypatch)
    cb5.produce(job)
    assert "overlay_spec" not in seen and "anchors" not in seen


def test_cb5_passes_the_overlay_and_anchors(tmp_path, monkeypatch):
    job, seen = _fake_cb5_job(tmp_path, monkeypatch)
    (job / "inputs").mkdir()
    (job / "work").mkdir()
    write(job / "inputs" / "overlay.json", {"version": 1})
    write(job / "work" / "anchors.json", {"version": 1, "width": W, "height": H, "frames": {}})
    cb5.produce(job)
    assert seen["overlay_spec"] == (job / "inputs" / "overlay.json").resolve()
    assert seen["anchors"] == (job / "work" / "anchors.json").resolve()


def test_cb5_overlay_without_anchors_passes_none(tmp_path, monkeypatch):
    job, seen = _fake_cb5_job(tmp_path, monkeypatch)
    (job / "inputs").mkdir()
    write(job / "inputs" / "overlay.json", {"version": 1})
    cb5.produce(job)
    assert seen["overlay_spec"] == (job / "inputs" / "overlay.json").resolve() and seen["anchors"] is None
