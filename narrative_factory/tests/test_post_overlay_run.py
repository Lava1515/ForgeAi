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
