"""CB4 post step: rendered frames + words + audio mix -> graded, captioned video, .srt, contact sheet and a report (KAN-913).

    python -m narrative_factory.codebuilt.post.run --frames F --words words.json --audio mix.wav --out OUT --name short [--lead 0.35]

Input is what a code-built job leaves behind (frames/NNNN.png, words.json, the mixed audio). Nothing is read from or written to any
other place. The audio mix itself is CB3; this step only muxes the file it is given, delayed by --lead and padded with silence to the video length.
"""
import argparse
import json
import os
import subprocess
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from . import captions, grade, media, sheet, subtitles

FPS = 30


def open_frame(path):
    """A frame the executor wrote. It is untrusted input: decode PNG only, whatever the file is named."""
    return Image.open(path, formats=["PNG"])


def _frames(frames_dir):
    """The .png frames, in name order. Each must be a regular file that resolves to a place inside the frames directory."""
    text = os.fspath(frames_dir)
    if not text or "\x00" in text:
        raise media.MediaError("frames directory is empty or has a NUL")
    root = Path(text).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"no .png frames in {frames_dir}")
    files = [media.inside(root, f) for f in sorted(root.glob("*.png"))]
    files = [f for f in files if f.is_file()]
    if not files:
        raise FileNotFoundError(f"no .png frames in {frames_dir}")
    return files


MAX_GRADE_WORKERS = 8


def grade_workers():
    """Threads for decoding and grading frames: half the logical CPUs, at least 1, at most MAX_GRADE_WORKERS."""
    return max(1, min(MAX_GRADE_WORKERS, (os.cpu_count() or 2) // 2))


def _graded_frame(path, width, height, vig):
    """One frame decoded, fitted to the output size and graded (glow, saturation, vignette), as an RGB image. No captions."""
    with open_frame(path) as opened:
        im = opened.convert("RGB")
    if im.size != (width, height):
        im = im.resize((width, height), Image.LANCZOS)
    return Image.fromarray(grade.apply_look(np.asarray(im), vig))


def finish(frames_dir, words_json, audio, out_dir, name, lead=0.0, fps=FPS, width=None, height=None, crf=17, preset="medium",
           sheet_count=12, sheet_cols=6, video_type=None):
    """Run the whole post step. Returns the report dict (also written to OUT/NAME.post.json).

    Guards first, before anything is written: `name` must be a bare file name, `out_dir` has no '..', every output path must resolve
    inside `out_dir`, and the words and audio inputs must be existing regular files.
    """
    out_root = media.safe_out_dir(out_dir)
    video, srt, sheet_path, report_path = (media.output_path(out_root, name, suffix)
                                           for suffix in (".mp4", ".srt", "_sheet.jpg", ".post.json"))
    files = _frames(frames_dir)
    looping = video_type == 'loop'
    if looping:
        files = files[:-1]  # independent frame N is QA evidence, not an encoded frame
    words_json, audio = (None if looping else media.input_file(words_json)), media.input_file(audio)
    with open_frame(files[0]) as first:
        width, height = width or first.width, height or first.height
    if width % 2 or height % 2:
        raise ValueError("yuv420p needs an even width and height")
    words = [] if looping else captions.load_words(words_json)[1]
    out_root.mkdir(parents=True, exist_ok=True)

    track = None if looping else captions.Track(words, width, height, lead=lead)
    boxes = [] if looping else track.worst_boxes()
    off_zone = [b for b in boxes if not captions.inside_safe_zone(b, width, height)]
    cs = [] if looping else captions.cues(track.chunks, lead=lead)
    if not looping:
        srt.write_text(subtitles.to_srt(cs), encoding="utf-8")

    vig = grade.vignette_mask(width, height)
    # The frames run `lead` seconds (plus a tail) longer than the voice: the executor shifts every cue by `lead`. So the voice is delayed
    # by `lead` and padded with silence up to the video length (apad whole_dur; an unbounded apad stalls ffmpeg 7 on a piped video), so the
    # file is as long as the frames and -shortest never cuts the video.
    # The audio file itself is not touched; only this mux changes it.
    delay_ms = max(0, int(round(float(lead) * 1000)))
    afilter = (f"adelay={delay_ms}:all=1," if delay_ms else "") + f"apad=whole_dur={len(files) / fps:.6f}"
    # `-f wav` before the audio input: ffmpeg must read it as WAV only, never probe a file the job folder holds for another demuxer.
    cmd = [media.resolve_ffmpeg(), "-hide_banner", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
           "-r", str(fps), "-i", "-", "-f", "wav", "-i", str(audio), "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p",
           "-af", afilter, "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", str(video)]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
    try:
        # Decoding and grading a frame is independent of every other frame and is where the time went (about 6 of the 7 minutes
        # between the last rendered frame and the draft, measured 2026-11-14 on jobs mwg20ivw-ea1a19 and mwg64zr1-5606e5, on one
        # core). Pillow and numpy release the interpreter lock in that work, so a few threads do it side by side. The frames still
        # reach the encoder in order, captions are still drawn one frame at a time on this thread, and at most `ahead` graded
        # frames wait in memory.
        workers = grade_workers()
        ahead = workers * 2
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="grade") as pool:
            pending = deque()
            source = iter(enumerate(files))
            def fill():
                while len(pending) < ahead:
                    item = next(source, None)
                    if item is None:
                        return
                    pending.append((item[0], pool.submit(_graded_frame, item[1], width, height, vig)))
            fill()
            while pending:
                i, future = pending.popleft()
                out = future.result()
                fill()
                if track is not None:
                    track.draw(out, i / fps)
                ff.stdin.write(out.tobytes())
        ff.stdin.close()
        err = ff.stderr.read().decode("utf-8", "replace")[-media.STDERR_TAIL:]
        code = ff.wait(timeout=600)
    except BrokenPipeError:
        err = ff.stderr.read().decode("utf-8", "replace")[-media.STDERR_TAIL:]
        ff.wait()
        raise media.MediaError(f"ffmpeg stopped early: {err}")
    finally:
        if ff.poll() is None:
            ff.kill()
    if code != 0:
        raise media.MediaError(f"ffmpeg failed ({code}): {err}")

    measured = media.probe(video)
    expected = len(files) / fps
    problems = media.judge(measured, width, height, fps, expected)
    check = {"errors": [], "skipped": "loop has no captions"} if looping else subtitles.check_srt(srt.read_text(encoding="utf-8"), duration=measured["duration"])
    sheet.contact_sheet(video, sheet_path, count=sheet_count, cols=sheet_cols)
    report = {
        "version": "codebuilt-post-v1", "video": str(video), "subtitles": None if looping else str(srt), "contact_sheet": str(sheet_path),
        "probe": measured, "probe_problems": problems, "subtitle_check": check,
        "captions": {"groups": 0 if looping else len(track.chunks), "cues": len(cs), "lead": lead, "all_inside_safe_zone": not off_zone,
                     "safe_zone": captions.safe_zone(width, height), "boxes_outside": off_zone},
        "ok": not problems and not check["errors"] and not off_zone,
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--frames", required=True)
    ap.add_argument("--words", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--lead", type=float, default=0.0)
    a = ap.parse_args(argv)
    rep = finish(a.frames, a.words, a.audio, a.out, a.name, lead=a.lead)
    print(json.dumps({k: rep[k] for k in ("video", "subtitles", "contact_sheet", "ok")}))
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
