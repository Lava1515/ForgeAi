"""Arguments and the per-frame render loop. Pure Python; the render call is injected."""
import argparse
import json
import os
import queue
import shutil
import sys
import threading
import tempfile
import time

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
    try:
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


class _FrameCopyWorker:
    """Copy completed RAM frames to the job mount with bounded, ordered backpressure."""
    def __init__(self, capacity=2):
        self.tasks = queue.Queue(maxsize=capacity)
        self.error = None
        self.thread = threading.Thread(target=self._run, name="frame-copy", daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            task = self.tasks.get()
            try:
                if task is None:
                    return
                src, dst = task
                try:
                    if self.error is None:
                        _copy_frame(src, dst)
                except BaseException as error:
                    self.error = error
                finally:
                    try:
                        os.unlink(src)
                    except FileNotFoundError:
                        pass
                    except BaseException as error:
                        if self.error is None:
                            self.error = error
            finally:
                self.tasks.task_done()

    def submit(self, src, dst):
        if self.error is not None:
            raise self.error
        self.tasks.put((src, dst))
        if self.error is not None:
            raise self.error

    def drain(self):
        self.tasks.join()
        if self.error is not None:
            raise self.error

    def close(self):
        try:
            self.drain()
        except BaseException:
            pass
        finally:
            self.tasks.put(None)
            self.thread.join()
        if self.error is not None:
            raise self.error


# ---- preview mode (visual loop, KAN-934) -------------------------------------------------------------------------------
# The host writes /job/work/preview.json before the container starts. When it exists (and only then) render_frames renders
# just the listed frames at a lower scale into /job/preview, after the QA pass was spent for the full frame list. The
# build script is unchanged: the same render_frames(...) call previews or renders in full depending on the file.
PREVIEW_SPEC = "/job/work/preview.json"
PREVIEW_OUT = "/job/preview"
RAM_FRAME_DIR = "/tmp"
# codex · gpt-6.1-sol · 2026-11-14: diagnostics stay in the existing writable job mount.
TIMING_PATH = "/job/work/render-timing.json"
PREVIEW_MAX_FRAMES = 24
PREVIEW_SCALE_RANGE = (25, 100)
_PREVIEW_KEYS = {"version", "frames", "scale", "out"}
ANCHORS_PATH = "/job/work/anchors.json"
PREVIEW_ANCHORS_PATH = "/job/work/anchors-preview.json"
# C2-AUTH-1: a preview of an overlay job also poses EVERY other frame of the build (no render) and saves the label and measure
# anchor positions of all of them, in the same anchors.json contract, so the host checks the layout on the whole video.
ALL_ANCHORS_PATH = "/job/work/anchors-all.json"
ALL_ANCHORS_DONE_PATH = "/job/work/anchors-all.done.json"
OVERLAY_SPEC_PATH = "/job/inputs/overlay.json"


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


def _save_timing(timing):
    """Best-effort diagnostics, never an acceptance receipt or a reason to fail a render."""
    try:
        # Outside the executor (e.g. pure Python kit tests), do not create /job.
        if not os.path.isdir(os.path.dirname(TIMING_PATH)):
            return
        with open(TIMING_PATH, "w", encoding="utf-8") as fh:
            json.dump(timing, fh)
    except Exception:
        pass


def _actual_settings():
    """Read AFTER the first render: the GPU launcher's handlers override the build's CPU setting."""
    try:
        import bpy
        scene = bpy.context.scene
        groups = {"render": (scene.render, ("engine", "resolution_x", "resolution_y", "resolution_percentage", "use_persistent_data")),
                  "cycles": (scene.cycles, ("device", "samples", "use_denoising", "denoiser", "denoising_use_gpu", "use_adaptive_sampling", "adaptive_threshold", "adaptive_min_samples", "max_bounces", "diffuse_bounces", "glossy_bounces", "transmission_bounces", "caustics_reflective", "caustics_refractive", "use_auto_tile", "tile_size")),
                  "image": (scene.render.image_settings, ("file_format", "color_mode", "color_depth", "compression"))}
        return {name: {key: getattr(obj, key, None) for key in keys} for name, (obj, keys) in groups.items()}
    except Exception:
        return None  # diagnostics must also work with the injected pure-Python renderer


def _anchor_dimensions():
    """Use the scene's nominal frame size; preview scaling does not change coordinates."""
    try:
        import bpy
        render = bpy.context.scene.render
        return int(render.resolution_x), int(render.resolution_y)
    except Exception:
        # Pure-Python renderloop tests have no Blender. No anchor file is emitted unless marks exist.
        return 1, 1


def _project_anchor(point):
    """Blender camera projection in contract coordinates (origin at top left)."""
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    scene = bpy.context.scene
    if scene.camera is None:
        raise RuntimeError("scene has no active camera")
    projected = world_to_camera_view(scene, scene.camera, Vector(point))
    return projected.x, 1.0 - projected.y, projected.z


def export_all_frame_anchors(frames, apply, log=print, anchors_path=None, done_path=None, project=None):
    """Pose each frame of `frames` with the build's own apply(f), project its marked points with the camera of that frame, and save
    the result as one anchors.json (contract 2.2). Nothing is rendered and no image is written. Returns the completion record.

    A fresh anchors state is used, so the preview anchors file written before this call is untouched. The record file
    (`anchors-all.done.json`, written last and atomically) tells the host that every frame in 0..max_frame was posed:
    {"version": 1, "frames": <count>, "max_frame": <last>, "anchors": <whether anchors-all.json exists>, "pose_s": <seconds>}.
    A frame whose apply() raises stops the export with that error: the final render would stop on the same frame."""
    from . import anchors
    anchors_path = ALL_ANCHORS_PATH if anchors_path is None else anchors_path
    done_path = ALL_ANCHORS_DONE_PATH if done_path is None else done_path
    project = _project_anchor if project is None else project
    ordered = sorted({int(f) for f in frames})
    started = time.perf_counter()
    width, height = _anchor_dimensions()
    anchors.usage()
    anchors.reset(width, height)
    for f in ordered:
        anchors.begin(f)
        apply(f)
        if anchors.has_points():
            try:
                import bpy
                bpy.context.view_layer.update()
            except ImportError:
                pass
            anchors.capture(f, project)
        else:
            anchors.capture(f, None)
    wrote = anchors.write(anchors_path)
    if not wrote:
        try:
            os.unlink(anchors_path)  # a stale file from an earlier run must not outlive a pass that marked nothing
        except FileNotFoundError:
            pass
    record = {"version": 1, "frames": len(ordered), "max_frame": ordered[-1] if ordered else -1, "anchors": bool(wrote),
              "pose_s": round(time.perf_counter() - started, 3)}
    _write_json_atomic(done_path, record)
    log("POSEALL " + json.dumps(record))
    return record


def _write_json_atomic(path, value):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".done-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"), allow_nan=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def tune_cycles(log=print):
    """Two Cycles settings that decide the frame time of these short, simple scenes, applied to the current scene before the
    frame loop. Measured on the RTX 4070 Ti, 1080x1920, 12 samples (output/agent-jobs/fable-kit-0900/speed_ab.py, 2026-11-14):
    6.7 s per frame as the builds set it, 6.2 s with persistent data alone, 0.77 s with persistent data and the denoiser on the GPU.
    The denoiser ran on the CPU while the GPU sat idle between frames (job mwfw97vp-b215f6: GPU load 0 percent, 12 CPU cores busy).
      - render.use_persistent_data: keep the scene and its acceleration structure on the device between frames.
      - cycles.denoising_use_gpu: run the denoiser on the render device.
    Only for Cycles, only when Blender is present, and never fatal: a setting this Blender does not have is reported and skipped.
    Returns {setting: value or reason}."""
    out = {}
    try:
        import bpy
        scene = bpy.context.scene
        if scene.render.engine != 'CYCLES':
            return out
        for owner, name in ((scene.render, "use_persistent_data"), (scene.cycles, "denoising_use_gpu")):
            try:
                setattr(owner, name, True)
                out[name] = bool(getattr(owner, name))
            except Exception as error:  # the property is absent in this build, or read-only here
                out[name] = "unavailable (%s)" % type(error).__name__
    except Exception as error:          # no Blender (pure tests) or no scene
        out["skipped"] = type(error).__name__
    try:
        log("TUNE " + json.dumps(out))
    except Exception:
        pass
    return out


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
        all_frames = frames
        if not set(spec["frames"]) <= set(frames):
            raise PreviewSpecError("preview frames are not in the frames this build renders")
        set_preview_scale(spec["scale"])
        frames, out_dir, hold, skip_existing = spec["frames"], spec["out"], 1, False

    else:
        all_frames = None
    if hold < 1:
        raise ValueError("hold must be >= 1")
    out_dir = require_abs(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    from . import anchors
    anchor_path = PREVIEW_ANCHORS_PATH if spec is not None else ANCHORS_PATH
    width, height = _anchor_dimensions()
    # Resume data is meaningful only when the final output is actually being resumed.
    loaded_anchor_file = skip_existing and spec is None and os.path.exists(anchor_path)
    qa_usage = anchors.usage()
    try:
        anchors.reset(width, height, anchor_path if loaded_anchor_file else None)
    except anchors.AnchorError:
        # A stale, partial, or foreign resume file must not prevent a fresh render.
        anchors.reset(width, height)
        loaded_anchor_file = False
    if loaded_anchor_file:
        anchors.discard_missing_frames(
            int(name[:-4]) for name in os.listdir(out_dir)
            if name.endswith(".png") and name[:-4].isdecimal()
        )
    anchored = bool(spec is None and (loaded_anchor_file or os.path.exists(OVERLAY_SPEC_PATH)))
    if require_qa:
        anchored = anchored or qa_usage["point"] or qa_usage["value"]
    done, held = [], 0
    tuned = tune_cycles(log)
    started = time.perf_counter()
    timing = {"version": 1, "clock": "perf_counter_seconds", "apply_s": 0.0, "render_s": 0.0,
              "note": "render_s includes engine sync, BVH, tracing, denoising and PNG write; other_s includes held copies and diagnostics",
              "tuned": tuned}
    with tempfile.TemporaryDirectory(prefix="forgeai-frames-", dir=RAM_FRAME_DIR) as ram_dir:
        copier = _FrameCopyWorker()
        try:
            for processed, f in enumerate(frames, start=1):
                fp = os.path.join(out_dir, f"{f:04d}.png")
                if skip_existing and os.path.exists(fp) and (anchors.has_frame(f) or not anchored):
                    continue
                if not anchored and f % hold:
                    copier.drain()
                    src = os.path.join(out_dir, f"{f - f % hold:04d}.png")
                    if os.path.exists(src):
                        _copy_frame(src, fp)
                        held += 1
                        continue
                # Resumed frames missing their position record are posed again without re-rendering.
                anchors.begin(f)
                before_apply = time.perf_counter()
                apply(f)
                after_apply = time.perf_counter()
                if anchors.has_points():
                    try:
                        import bpy
                        bpy.context.view_layer.update()
                    except ImportError:
                        pass
                    anchors.capture(f, _project_anchor)
                else:
                    anchors.capture(f, None)
                anchored = anchored or anchors.has_marks()
                timing["apply_s"] += after_apply - before_apply
                if skip_existing and os.path.exists(fp):
                    if anchors.has_marks() and processed % 30 == 0:
                        anchors.write(anchor_path)
                    continue
                src = os.path.join(out_dir, f"{f - f % hold:04d}.png")
                if f % hold:
                    # Earlier renders may still be copying; wait before checking/reading the source.
                    copier.drain()
                    if os.path.exists(src):
                        _copy_frame(src, fp)
                        held += 1
                        if anchors.has_marks() and processed % 30 == 0:
                            anchors.write(anchor_path)
                        continue
                ram_fp = os.path.join(ram_dir, f"{f:04d}.png")
                before_render = time.perf_counter()
                render_fn(ram_fp)
                after_render = time.perf_counter()
                timing["render_s"] += after_render - before_render
                done.append(f)
                copier.submit(ram_fp, fp)
                if len(done) == 1:
                    timing["first_render_s"] = after_render - before_render
                    timing["settings_after_render"] = _actual_settings()
                if len(done) == 1 or len(done) % 30 == 0:
                    timing.update(rendered=len(done), held=held, last_frame=f, loop_s=time.perf_counter() - started)
                    timing["other_s"] = timing["loop_s"] - timing["apply_s"] - timing["render_s"]
                    _save_timing(timing)
                if anchors.has_marks() and processed % 30 == 0:
                    anchors.write(anchor_path)
        finally:
            copier.close()
    anchors.write(anchor_path)
    if all_frames is not None and os.path.exists(OVERLAY_SPEC_PATH):
        # Preview of an overlay job (never a classic job: it has no overlay input): pose the whole video without rendering.
        export_all_frame_anchors(all_frames, apply, log)
    timing.update(rendered=len(done), held=held, loop_s=time.perf_counter() - started)
    timing["other_s"] = timing["loop_s"] - timing["apply_s"] - timing["render_s"]
    _save_timing(timing)
    log(f"DONE {len(done)}" + (f" held {held}" if hold > 1 else ""))
    return done
