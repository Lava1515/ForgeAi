# claude-pro · claude-sonnet-5-5 · 2026-11-18 17:55 +02:00
"""Host-side all-frame text layout check for the authored route (Fable check 2, fix 1).

Runs the canonical post-step layout algorithm (narrative_factory/codebuilt/post/overlay.py, Overlay.layout_report) on EVERY frame of
the video, at the final 1080x1920 size, before the author's `pass` is accepted. It is CPU only, reads three host-owned files, writes
nothing, and prints one JSON line. No model, no shell, no network.

What it can know at preview time: the preview render only poses the previewed frames, so anchors-preview.json holds points for those
frames alone. The fixed elements (tag, counter, big, bars) do not depend on points, so their windows are checked on all frames. Labels
and measures stick to points: on a frame without a point they are not drawn, so they are checked only on the previewed frames
(label_hidden is therefore measured on those frames only). The counter box uses the last known value, so its width is approximate.

    python -I layout_gate.py --overlay FILE --nframes N --job-root DIR --frames 6,54,... [--anchors FILE] [--words FILE]
                             [--lead 0.35] [--fps 30] [--width 1080] [--height 1920]
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))


def run(opts):
    from narrative_factory.codebuilt.post import anchors_file, captions, overlay

    root = Path(opts.job_root).resolve()
    spec = overlay.load_spec(opts.overlay, video_seconds=opts.nframes / opts.fps, job_root=root)
    marks = anchors_file.load(opts.anchors, opts.nframes, job_root=root) if opts.anchors else anchors_file.Anchors.empty(opts.width, opts.height)
    track = None
    if opts.words:
        _, words = captions.load_words(Path(opts.words))
        track = captions.Track(words, opts.width, opts.height, lead=opts.lead, style="overlay")
    ov = overlay.Overlay(spec, marks, opts.width, opts.height, captions_track=track, fps=opts.fps, nframes=opts.nframes)
    rep = ov.layout_report()
    preview = sorted({int(f) for f in opts.frames.split(",") if f.strip()} if opts.frames else set())
    # label_hidden on the previewed frames only: elsewhere a label has no point, which is not "hidden from the camera".
    active, hidden = {}, {}
    for f in preview:
        if not 0 <= f < opts.nframes:
            continue
        t = f / opts.fps
        ids = {p["id"] for p in ov.pieces(f, t)}
        for i, lab in enumerate(spec["labels"]):
            if lab["from"] <= t < lab["to"]:
                active[i] = active.get(i, 0) + 1
                hidden[i] = hidden.get(i, 0) + (f"labels[{i}]" not in ids)
    label_hidden = [{"element": f"labels[{i}]", "share": round(hidden[i] / n, 3), "frames": n} for i, n in sorted(active.items()) if hidden.get(i)]
    return {"status": "ok", "version": 1, "frames_checked": rep["frames_checked"], "fps": opts.fps, "ok": rep["ok"], "blocking": rep["blocking"],
            "label_hidden": label_hidden, "preview_frames": len(preview), "anchored_frames": len(marks._points)}


def main(argv):
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--overlay", required=True)
    parser.add_argument("--nframes", type=int, required=True)
    parser.add_argument("--job-root", required=True)
    parser.add_argument("--frames", default="")
    parser.add_argument("--anchors")
    parser.add_argument("--words")
    parser.add_argument("--lead", type=float, default=0.35)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    try:
        opts = parser.parse_args(argv)
        if opts.nframes < 1 or opts.fps <= 0:
            raise ValueError("nframes and fps must be positive")
        print(json.dumps(run(opts)))
        return 0
    except SystemExit:
        print(json.dumps({"status": "error", "error": "bad arguments"}))
    except Exception as err:  # noqa: BLE001 - the host reads the one line; the reason is short and has no paths
        print(json.dumps({"status": "error", "error": f"{type(err).__name__}: {str(err)[:300]}"}))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
