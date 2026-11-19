"""Host-only HyperFrames text pass; no package installation or remote page assets.

codex · gpt-6.1-sol · 2026-11-19 14:29 +02:00
"""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

from . import anchors_file, captions, media, overlay, sheet

VERSION = "0.9.70"
ASSETS = Path(__file__).with_name("hyperframes_assets")


def cli():
    """Use an explicitly selected installed CLI, never npx (which can download)."""
    entry = Path(os.environ.get("FORGE_HYPERFRAMES_CLI", ""))
    if not entry.is_absolute() or not entry.is_file():
        raise media.MediaError("set FORGE_HYPERFRAMES_CLI to installed hyperframes/bin/hyperframes.mjs")
    package = json.loads((entry.parent.parent / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != "hyperframes" or package.get("version") != VERSION:
        raise media.MediaError(f"HyperFrames must be exactly {VERSION}; no install attempted")
    node = shutil.which("node")
    if not node:
        raise media.MediaError("installed Node.js not found")
    return [node, str(entry)]


def finish(job, result, words_path, spec_path, marks_path, *, fps, lead):
    """Add text to the graded, muxed base, then copy its audio unchanged.

    All writable CLI caches and media live in a fresh directory inside this job.
    The caller runs this after the executor stops, under the existing serial job lease.
    """
    command = cli()
    browser = os.environ.get("FORGE_HYPERFRAMES_BROWSER", "")
    if not Path(browser).is_absolute() or not Path(browser).is_file():
        raise media.MediaError("set FORGE_HYPERFRAMES_BROWSER to an existing Chrome executable; no install attempted")
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise media.MediaError("existing ffprobe must be on host PATH; no install attempted")
    job = Path(job).resolve()
    base = media.inside(job, result["video"])
    measured = media.probe(base)
    width, height = measured["width"], measured["height"]
    nframes = round(measured["duration"] * fps)
    if not 0 < nframes <= 216000:
        raise media.MediaError("HyperFrames frame count outside 1..216000")
    duration = nframes / fps
    spec = overlay.load_spec(spec_path, duration, job_root=job) if spec_path else overlay.validate_spec({"version": 1})
    marks = anchors_file.load(marks_path, nframes, job_root=job) if marks_path else anchors_file.Anchors.empty(width, height)
    names = overlay.names_used(spec)
    if names["points"] - marks.point_names or names["values"] - marks.value_names:
        raise media.MediaError("anchors.json: missing referenced text points or values")
    _, words = captions.load_words(media.inside(job, words_path))
    chunks = captions.group_words(words)
    cues = captions.cues(chunks, lead=lead)
    groups = [{**cue, "words": [{"text": text.upper(), "start": w["s"] + lead,
                                "key": captions.keyword(w)} for w, text in zip(chunk, captions.display_words(chunk))]}
              for cue, chunk in zip(cues, chunks)]
    points = {name: [None if marks.point(f, name) is None or not marks.point(f, name)[2] or marks.occluded(f, name)
                     else list(marks.point(f, name)[:2]) for f in range(nframes)] for name in names["points"]}
    values = {name: [marks.value(f, name) for f in range(nframes)] for name in names["values"]}
    counter = spec["counter"]
    numbers = [overlay.format_value(v, counter["format"]) for v in values[counter["value"]]] if counter else []
    project = Path(tempfile.mkdtemp(prefix=".hyperframes-text-", dir=job))
    assets = project / "assets"
    assets.mkdir()
    shutil.copyfile(base, assets / "base.mp4")
    for name in ("Inter-700.woff2", "OFL-inter.txt", "text.js", "text.css"):
        shutil.copyfile(ASSETS / name, assets / name)
    payload = {"width": width, "height": height, "fps": fps, "groups": groups,
               "spec": spec, "points": points, "values": values, "numbers": numbers}
    (assets / "data.js").write_text("window.TEXT_DATA=" + json.dumps(payload, ensure_ascii=True) + ";", encoding="utf-8")
    (project / "index.html").write_text(f'''<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'">
<link rel="stylesheet" href="assets/text.css"></head><body>
<div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="{duration}" data-width="{width}" data-height="{height}" data-fps="{fps}">
<video id="base" class="clip" src="assets/base.mp4" data-start="0" data-duration="{duration}" muted playsinline></video>
<div id="graphics"></div><div id="captions"></div><div id="flash"></div></div>
<script src="assets/data.js"></script><script src="assets/text.js"></script></body></html>''', encoding="utf-8")
    # Disable proxy/download paths and keep every cache beneath this fresh job directory.
    (project / "hyperframes.json").write_text(json.dumps({"media": {"autoProxy": False}}), encoding="utf-8")
    env = os.environ.copy()
    for key in ("TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA", "HYPERFRAMES_HOME"):
        target = project / "cache" / key
        target.mkdir(parents=True)
        env[key] = str(target)
    env.update({"HYPERFRAMES_NO_TELEMETRY": "1", "DO_NOT_TRACK": "1",
                "HYPERFRAMES_FFMPEG_PATH": media.resolve_ffmpeg(), "HYPERFRAMES_FFPROBE_PATH": ffprobe})
    rendered = project / "text.mp4"
    args = command + ["render", str(project), "--output", str(rendered), "--fps", str(fps),
                      "--workers", "1", "--no-browser-gpu", "--no-gpu", "--frames-cache-dir", "off"]
    # Existing browser only; this override bypasses the CLI's managed browser installer.
    env["HYPERFRAMES_BROWSER_PATH"] = browser
    started = time.monotonic()
    log_path = project / "render.log"
    with log_path.open("wb") as log:
        process = subprocess.Popen(args, cwd=project, env=env, stdout=log, stderr=log, shell=False,
                                   start_new_session=os.name != "nt")
        try:
            code = process.wait(timeout=1500)
        except subprocess.TimeoutExpired as error:
            # A stalled browser happened in the CPU sample. Stop this render's children too.
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=30)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=30)
            raise media.MediaError("HyperFrames text render timed out; see " + str(log_path)) from error
    if code:
        with log_path.open("rb") as log:
            log.seek(max(0, log_path.stat().st_size - 1000))
            tail = log.read().decode("utf-8", "replace")
        raise media.MediaError("HyperFrames text failed: " + tail)
    output = project / "video.mp4"
    media.run_ffmpeg(["-y", "-i", str(rendered), "-i", str(base), "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", str(output)])
    probe = media.probe(output)
    problems = media.judge(probe, width, height, fps, duration)
    if problems:
        raise media.MediaError("HyperFrames output: " + ", ".join(problems))
    sheet_path = project / "sheet.jpg"
    sheet.contact_sheet(output, sheet_path)
    return {**result, "video": str(output), "contact_sheet": str(sheet_path), "probe": probe,
            "hyperframes": {"version": VERSION, "project": str(project), "seconds": round(time.monotonic() - started, 2)}}
