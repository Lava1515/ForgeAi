import json

from PIL import Image

from narrative_factory.codebuilt.post import preview_sheet


def frame(folder, number):
    Image.new("RGB", (120, 180), (35, 45, 55)).save(folder / f"{number:04}.png")


def test_sheets_preserve_legacy_when_caption_inputs_are_absent(tmp_path):
    frames, out = tmp_path / "frames", tmp_path / "out"
    frames.mkdir(); frame(frames, 0)
    result = preview_sheet.make_sheets(frames, out, "ABCDE")
    assert result[0]["tiles"][0]["frame"] == 0
    assert "layout_findings" in result[0]


def test_sheets_burn_caption_and_overlay_and_validate_sparse_indices_by_timeline(tmp_path):
    frames, out = tmp_path / "frames", tmp_path / "out"
    job = tmp_path / "job"; frames.mkdir(); job.mkdir(); out.mkdir()
    frame(frames, 8)
    words = job / "words.json"
    words.write_text(json.dumps({"dur": 1, "words": [{"w": "HELLO", "s": 0.2, "e": 0.8}]}))
    spec = job / "overlay.json"
    spec.write_text(json.dumps({"version": 1, "labels": [{"anchor": "mark", "title": "LANDMARK", "from": 0, "to": 0.9}]}))
    anchors = job / "anchors-preview.json"
    anchors.write_text(json.dumps({"version": 1, "width": 120, "height": 180,
        "frames": {"8": {"p": {"mark": [0.5, 0.45, 1]}}}}))
    baseline = tmp_path / "baseline"
    preview_sheet.make_sheets(frames, baseline, "ABCDE")
    result = preview_sheet.make_sheets(frames, out, "ABCDE", words=words, overlay_spec=spec,
        anchors_path=anchors, lead=0.35, nframes=30, fps=30, job_root=job)
    assert result[0]["tiles"][0]["frame"] == 8
    assert result[0]["layout_findings"] == []
    assert (out / result[0]["file"]).is_file()
    assert (out / result[0]["file"]).read_bytes() != (baseline / "sheet_1.jpg").read_bytes()


def test_bad_preview_anchors_keep_named_error_and_write_no_sheet(tmp_path, capsys):
    frames, out = tmp_path / "frames", tmp_path / "out"
    job = tmp_path / "job"; frames.mkdir(); job.mkdir(); out.mkdir()
    frame(frames, 28)
    words = job / "words.json"; words.write_text(json.dumps({"dur": 1, "words": [{"w": "HELLO", "s": 0, "e": 1}]}))
    spec = job / "overlay.json"; spec.write_text(json.dumps({"version": 1, "labels": [{"anchor": "mark", "title": "X", "from": 0, "to": 0.9}]}))
    anchors = job / "anchors-preview.json"; anchors.write_text(json.dumps({"version": 1, "width": 120, "height": 180, "frames": {"30": {}}}))
    result = preview_sheet.main(["preview_sheet.py", "sheets", str(frames), str(out), "ABCDE", "--words", str(words),
        "--overlay", str(spec), "--anchors", str(anchors), "--lead", "0.35", "--nframes", "30", "--fps", "30", "--job-root", str(job)])
    assert result == 1
    body = json.loads(capsys.readouterr().out)
    assert body["status"] == "error"
    assert body["error"].startswith("anchors.json: frame key")
    assert not list(out.glob("sheet_*.jpg"))


def test_cli_reports_bad_words_and_outside_paths_without_traceback(tmp_path, capsys):
    frames, out = tmp_path / "frames", tmp_path / "out"
    frames.mkdir(); frame(frames, 12)
    words = tmp_path / "words.json"
    words.write_text('{"words": [null]}')
    args = ["preview_sheet.py", "sheets", str(frames), str(out), "ABCDE", "--words", str(words)]
    assert preview_sheet.main(args) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "error"
    assert preview_sheet.main(args + ["--job-root", str(frames)]) == 1
    assert "would leave" in json.loads(capsys.readouterr().out)["error"]
    assert not out.exists()
