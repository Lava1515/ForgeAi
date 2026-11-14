"""Arguments and the per-frame render loop. Pure Python; the render call is injected."""
import argparse
import json
import os
import shutil
import sys
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
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


# ---- preview mode (visual loop, KAN-934) -------------------------------------------------------------------------------
# The host writes /job/work/preview.json before the container starts. When it exists (and only then) render_frames renders
# just the listed frames at a lower scale into /job/preview, after the QA pass was spent for the full frame list. The
# build script is unchanged: the same render_frames(...) call previews or renders in full depending on the file.
PREVIEW_SPEC = "/job/work/preview.json"
PREVIEW_OUT = "/job/preview"
# codex · gpt-6.1-sol · 2026-11-14: diagnostics stay in the existing writable job mount.
TIMING_PATH = "/job/work/render-timing.json"
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


def loop_state():
    """Evaluated transforms, camera optics, visibility, light and shader input values."""
    import bpy
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    values = {}
    def scalar(key, value):
        if isinstance(value, (int, float, bool)):
            values[key] = float(value)
        elif not isinstance(value, str):
            try:
                items = list(value)
            except TypeError:
                return
            for i, v in enumerate(items):
                scalar(f'{key}/{i}', v)
    scene = bpy.context.scene
    values['active_camera'] = scene.camera.name if scene.camera else None
    for obj in scene.objects:
        ev = obj.evaluated_get(graph)
        key = 'object/' + obj.name
        for i, row in enumerate(ev.matrix_world):
            scalar(f'{key}/matrix/{i}', row)
        scalar(key + '/hidden', ev.hide_render)
        for prop in ('sensor_width', 'sensor_height'):
            if ev.type == 'CAMERA':
                scalar(key + '/' + prop, getattr(ev.data, prop))
        if ev.type in ('CAMERA', 'LIGHT'):
            for prop in ('lens', 'ortho_scale', 'shift_x', 'shift_y', 'clip_start', 'clip_end',
                         'energy', 'color', 'shadow_soft_size', 'size', 'size_y', 'spot_size', 'spot_blend'):
                if hasattr(ev.data, prop):
                    scalar(key + '/' + prop, getattr(ev.data, prop))
            if ev.type == 'CAMERA':
                for prop in ('use_dof', 'focus_distance', 'aperture_fstop'):
                    scalar(key + '/dof/' + prop, getattr(ev.data.dof, prop))
    blocks = list(bpy.data.materials) + list(bpy.data.lights) + list(bpy.data.worlds)
    for block in blocks:
        key = block.bl_rna.identifier + '/' + block.name
        for prop in ('diffuse_color', 'metallic', 'roughness', 'energy', 'color'):
            if hasattr(block, prop):
                scalar(key + '/' + prop, getattr(block, prop))
        if block.use_nodes and block.node_tree:
            for node in block.node_tree.nodes:
                for i, socket in enumerate(node.inputs):
                    if hasattr(socket, 'default_value'):
                        scalar(f'{key}/{node.name}/input/{i}', socket.default_value)
                for i, socket in enumerate(node.outputs):
                    if hasattr(socket, 'default_value'):
                        scalar(f'{key}/{node.name}/output/{i}', socket.default_value)
    return values


def check_loop_state(apply, nframes, snapshot=None, samples=24):
    """No renders: pose frame 0, `samples` whole frames spread over the cycle, and frame N. Raise before frame zero is rendered.

    The state at N must equal frame 0 (the loop closes). Something must differ from frame 0 somewhere in the cycle (it moves): the
    whole cycle is sampled, because a sine that starts at its middle is back at the same value at the half cycle. And the state may
    not stand still for more than a third of the cycle."""
    import math
    snapshot = snapshot or loop_state
    nframes = int(nframes)
    frames = sorted({min(nframes - 1, int(round(i * nframes / samples))) for i in range(samples)})
    states = []
    for frame in frames + [nframes]:
        apply(frame)
        states.append(snapshot())
    def equal(a, b):
        return a.keys() == b.keys() and all(
            math.isclose(a[k], b[k], rel_tol=1e-6, abs_tol=1e-5)
            if isinstance(a[k], (int, float)) and isinstance(b[k], (int, float))
            else a[k] == b[k] for k in a)
    if not equal(states[0], states[-1]):
        raise ValueError('loop preflight: state at N does not equal frame 0')
    cycle = states[:-1]
    moved = sum(1 for st in cycle[1:] if not equal(cycle[0], st))
    if moved == 0:
        raise ValueError('loop preflight: no motion anywhere in the cycle')
    still = longest = 0
    for i in range(len(cycle)):                      # around the seam too
        still = still + 1 if equal(cycle[i], cycle[(i + 1) % len(cycle)]) else 0
        longest = max(longest, still)
    if longest * nframes / len(cycle) > nframes / 3:
        raise ValueError('loop preflight: no motion for more than a third of the cycle')
    apply(0)
    return {'passed': True, 'frames': frames + [nframes], 'frames_differing_from_0': moved, 'longest_still_samples': longest}


def loop_glyphs():
    """Names of text objects and text curves in the scene. A silent loop shows no glyphs; a source scan cannot prove that, the scene can."""
    import bpy
    names = ['object/' + o.name for o in bpy.context.scene.objects if o.type == 'FONT']
    names += ['curve/' + c.name for c in bpy.data.curves if c.bl_rna.identifier == 'TextCurve' and c.users > 0]
    return sorted(set(names))


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
    # codex · gpt-6.1-sol · 2026-11-14: the host's hash-verified format contract,
    # not a generated-code flag, requests an independently posed endpoint.
    loop_end = None
    if os.path.isfile('/job/inputs/pathpack.json'):
        with open('/job/inputs/pathpack.json', encoding='utf-8') as fh:
            pack = json.load(fh)
        if pack.get('videoType') == 'loop':
            glyphs = loop_glyphs()
            if glyphs:
                raise ValueError('loop preflight: text in a silent loop: ' + ', '.join(glyphs[:8]))
            preflight = check_loop_state(apply, pack['loop']['nframes'])
            log('LOOP_PREFLIGHT ' + json.dumps(preflight))
            if spec is None:
                loop_end = pack['loop']['nframes']
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
    tuned = tune_cycles(log)
    started = time.perf_counter()
    timing = {"version": 1, "clock": "perf_counter_seconds", "apply_s": 0.0, "render_s": 0.0,
              "note": "render_s includes engine sync, BVH, tracing, denoising and PNG write; other_s includes held copies and diagnostics",
              "tuned": tuned}
    for f in list(frames) + ([loop_end] if loop_end is not None else []):
        fp = os.path.join(out_dir, f"{f:04d}.png")
        if skip_existing and os.path.exists(fp):
            continue
        src = os.path.join(out_dir, f"{f - f % hold:04d}.png")
        if f % hold and os.path.exists(src):
            _copy_frame(src, fp)
            held += 1
            continue
        before_apply = time.perf_counter()
        apply(f)
        before_render = time.perf_counter()
        render_fn(fp)
        after_render = time.perf_counter()
        timing["apply_s"] += before_render - before_apply
        timing["render_s"] += after_render - before_render
        done.append(f)
        if len(done) == 1:
            timing["first_render_s"] = after_render - before_render
            timing["settings_after_render"] = _actual_settings()
        if len(done) == 1 or len(done) % 30 == 0:
            timing.update(rendered=len(done), held=held, last_frame=f, loop_s=time.perf_counter() - started)
            timing["other_s"] = timing["loop_s"] - timing["apply_s"] - timing["render_s"]
            _save_timing(timing)
    timing.update(rendered=len(done), held=held, loop_s=time.perf_counter() - started)
    timing["other_s"] = timing["loop_s"] - timing["apply_s"] - timing["render_s"]
    _save_timing(timing)
    log(f"DONE {len(done)}" + (f" held {held}" if hold > 1 else ""))
    return done
