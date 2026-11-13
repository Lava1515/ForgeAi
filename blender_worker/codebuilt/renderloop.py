"""Arguments and the per-frame render loop. Pure Python; the render call is injected."""
import argparse
import json
import os
import shutil
import sys

from .paths import require_abs


def parse_frames(spec=None, rng=None, nframes=0):
    """--frames '1,2,3' beats --range a b (b exclusive); default is every frame."""
    if spec:
        return [int(x) for x in str(spec).split(",") if x.strip() != ""]
    a, b = (int(rng[0]), int(rng[1])) if rng else (0, nframes)
    if a < 0 or b < a:
        raise ValueError(f"bad frame range {a}..{b}")
    return list(range(a, min(b, nframes) if nframes else b))


def parse_args(argv):
    """argv is the list after the '--' separator. --out is required and must be absolute."""
    ap = argparse.ArgumentParser(prog="codebuilt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames")
    ap.add_argument("--range", nargs=2, metavar=("A", "B"))
    ap.add_argument("--scale", type=int, default=100)
    ap.add_argument("--samples", type=int, default=24)
    ap.add_argument("--qa", action="store_true")
    ap.add_argument("--info", action="store_true")
    ap.add_argument("--blend-out", help="optional absolute path to save the .blend")
    a = ap.parse_args(argv)
    a.out = require_abs(a.out)
    if a.blend_out:
        a.blend_out = require_abs(a.blend_out)
    if not 1 <= a.scale <= 100:
        raise ValueError("--scale must be 1..100")
    return a


def script_argv(argv=None):
    argv = sys.argv if argv is None else argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def _copy_frame(src, dst):
    """Copy via a temp name and an atomic rename, so an interrupted copy never leaves a file that resume would trust."""
    tmp = dst + ".part"
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


# ---- preview mode (visual loop, KAN-934) -------------------------------------------------------------------------------
# The host writes /job/work/preview.json before the container starts. When it exists (and only then) render_frames renders
# just the listed frames at a lower scale into /job/preview, after the QA pass was spent for the full frame list. The
# build script is unchanged: the same render_frames(...) call previews or renders in full depending on the file.
PREVIEW_SPEC = "/job/work/preview.json"
PREVIEW_OUT = "/job/preview"
PREVIEW_MAX_FRAMES = 24
PREVIEW_SCALE_RANGE = (25, 100)
_PREVIEW_KEYS = {"version", "frames", "scale", "out"}


class PreviewSpecError(ValueError):
    """The preview spec is malformed, or the build does not allow a preview of it. Nothing is rendered."""


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def load_preview_spec(path=None):
    """None when no spec file exists; else the validated spec dict {version, frames, scale, out}. Raises PreviewSpecError."""
    path = PREVIEW_SPEC if path is None else path
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    except (OSError, ValueError) as error:
        raise PreviewSpecError(f"preview spec is not readable JSON: {error}") from error
    if not isinstance(spec, dict) or set(spec) != _PREVIEW_KEYS:
        raise PreviewSpecError("preview spec must be an object with exactly version, frames, scale, out")
    if spec["version"] != 1 or not _is_int(spec["version"]):
        raise PreviewSpecError("preview spec version must be 1")
    frames = spec["frames"]
    if not isinstance(frames, list) or not 1 <= len(frames) <= PREVIEW_MAX_FRAMES:
        raise PreviewSpecError(f"preview frames must be a list of 1..{PREVIEW_MAX_FRAMES} items")
    if not all(_is_int(f) and f >= 0 and f % 2 == 0 for f in frames):
        raise PreviewSpecError("preview frames must be even integers >= 0")
    if any(b <= a for a, b in zip(frames, frames[1:])):
        raise PreviewSpecError("preview frames must be strictly increasing")
    lo, hi = PREVIEW_SCALE_RANGE
    if not _is_int(spec["scale"]) or not lo <= spec["scale"] <= hi:
        raise PreviewSpecError(f"preview scale must be an integer {lo}..{hi}")
    if spec["out"] != PREVIEW_OUT:
        raise PreviewSpecError(f"preview out must be {PREVIEW_OUT}")
    return spec


def set_preview_scale(scale):
    """Preview mode only: the scene render scale in percent. A module-level hook (not a render_frames argument) so the public signature the
    planner's kit contract quotes stays exactly as it was; tests replace it."""
    import bpy  # lazy: only preview mode needs it, and only inside Blender
    bpy.context.scene.render.resolution_percentage = scale


def render_frames(frames, out_dir, apply, render_fn, skip_existing=True, log=print, hold=1, require_qa=False):
    """Pose and render each frame to out_dir/NNNN.png; returns the frames actually rendered.

    skip_existing resumes an interrupted run. Pass False for an explicit frame list.
    hold=N renders only frames that are a multiple of N and writes every other frame as a copy of the
    nearest rendered frame before it (N=2: 15 unique fps at 30 fps). Every frame index is still written, so the
    sequence keeps its names and count; a held frame whose source is not on disk is rendered for real instead.
    require_qa=True refuses (shotcheck.QAError) to pose or render anything unless shotcheck.run_qa passed for this exact apply
    function and covered these frames and this hold. It spends that pass at the start, so one run_qa allows one render_frames call.
    """
    hold = int(hold)
    if require_qa:
        from . import shotcheck
        frames = list(frames)
        shotcheck.require_qa("render_frames", apply, frames, hold)

    spec = load_preview_spec()
    if spec is not None:
        # Preview mode: QA above has already been spent for the full frame list. Only the listed frames are rendered,
        # each for real (hold 1: no copies), into the preview folder, at the spec scale.
        if not require_qa:
            raise PreviewSpecError("preview mode needs require_qa=True: a preview must prove the QA gate of the script that will ship")
        frames = list(frames)
        if not set(spec["frames"]) <= set(frames):
            raise PreviewSpecError("preview frames are not in the frames this build renders")
        set_preview_scale(spec["scale"])
        frames, out_dir, hold, skip_existing = spec["frames"], spec["out"], 1, False

    if hold < 1:
        raise ValueError("hold must be >= 1")
    out_dir = require_abs(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    done, held = [], 0
    for f in frames:
        fp = os.path.join(out_dir, f"{f:04d}.png")
        if skip_existing and os.path.exists(fp):
            continue
        src = os.path.join(out_dir, f"{f - f % hold:04d}.png")
        if f % hold and os.path.exists(src):
            _copy_frame(src, fp)
            held += 1
            continue
        apply(f)
        render_fn(fp)
        done.append(f)
    log(f"DONE {len(done)}" + (f" held {held}" if hold > 1 else ""))
    return done
