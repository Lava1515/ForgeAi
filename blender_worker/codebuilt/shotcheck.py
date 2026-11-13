"""Text-in-frame check and shot-variety rule (pure Python; the scene check needs Blender).

framing.py tests one subject point. Readouts and equations are wide boxes: a box whose centre is
inside the frame can still run off the screen edge (the 46.5 s clipped equation in cb-mwe94ay9).
This module projects the real text box through the camera and fails any shot whose text leaves
the safe area. It also holds the shot-variety rule that generated builds must follow.

run_qa() is the consumer: one pass over the rendered frames. Two checks block: text in frame and shot variety (the shot
target is the one stage.Camera.set recorded, never derived from mesh positions). The top-third check is advisory only
(a warning in the report) until it is calibrated on real generated scenes. A passing run opens a render gate bound to the
exact apply function; renderloop.render_frames(require_qa=True) spends the gate once, at its start, so a generated build
cannot render around its QA, render a different build, or render twice on one pass.
"""
import json
import math
import os

from .framing import MIN_DEPTH

TEXT_SAFE = (0.06, 0.94, 0.08, 0.92)  # xmin, xmax, ymin, ymax of the frame a text box must stay inside
MAX_READOUT_FRAME_SHARE = 0.78
SENSOR_MM = 36.0   # Blender default; with sensor_fit AUTO it spans the longer side of the frame
CHAR_W = 0.6       # glyph advance as a share of text size (wide display fonts; Impact is about 0.5)
LINE_H = 1.2

SHOT_VARIETY_RULE = (
    "Shot variety: no two shots within two of each other may share one composition. Between those shots change at least "
    "one of: camera side (azimuth 30 degrees or more), height (elevation 12 degrees or more), or "
    "distance/lens scale (25 percent or more). Place content so it reaches the upper third as well "
    "as the middle (an empty top third is reported as a warning only; it does not block). Keep every readout and equation fully "
    "inside the text safe area (shotcheck.TEXT_SAFE) at every frame."
)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a):
    n = math.sqrt(_dot(a, a)) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def camera_basis(pos, target, roll=0.0):
    """(right, up, forward) unit vectors for a camera at pos looking at target (world +Z is up)."""
    f = _unit(_sub(target, pos))
    r = _unit(_cross(f, (0.0, 0.0, 1.0) if abs(f[2]) < 0.999 else (0.0, 1.0, 0.0)))
    u = _cross(r, f)
    if roll:
        c, s = math.cos(roll), math.sin(roll)
        r, u = (tuple(c * a + s * b for a, b in zip(r, u)), tuple(-s * a + c * b for a, b in zip(r, u)))
    return r, u, f


def project_point(p, pos, target, lens=50.0, aspect=9 / 16, roll=0.0):
    """Like Blender's world_to_camera_view: (x, y, depth), x and y 0..1 across the frame, y up."""
    r, u, f = camera_basis(pos, target, roll)
    d = _sub(p, pos)
    depth = _dot(d, f)
    if depth <= 1e-9:
        return (0.5, 0.5, depth)
    sx, sy = (SENSOR_MM, SENSOR_MM / aspect) if aspect >= 1 else (SENSOR_MM * aspect, SENSOR_MM)
    return (0.5 + _dot(d, r) / depth * lens / sx, 0.5 + _dot(d, u) / depth * lens / sy, depth)


def text_extent(body, size, scale=1.0, char_w=CHAR_W):
    """Estimated (width, height) of centred text in world units, from the longest line."""
    lines = str(body).split("\n")
    return (max(len(l) for l in lines) * size * char_w * scale, len(lines) * size * LINE_H * scale)


def find_readouts_behind_subject(samples):
    """Keep overlap samples whose subject is strictly nearer than the readout."""
    return [sample for sample in samples if sample[3] is not None and sample[2] > sample[3]]


def subject_in_readout_box(objects, box, margin=0.01):
    """Nearest (name, depth) among non-scenery vertices inside this readout's screen box.

    The margin is one percent of the frame; off-screen and behind-camera vertices never count.
    This is a sampled-vertex overlap check, not a full mesh occlusion test.
    """
    xmin, xmax, ymin, ymax, _ = box
    candidates = ((obj["name"], d) for obj in objects if not obj.get("scenery")
                  for x, y, d in obj["pts"]
                  if d > MIN_DEPTH and 0 <= x <= 1 and 0 <= y <= 1
                  and xmin - margin <= x <= xmax + margin and ymin - margin <= y <= ymax + margin)
    return min(candidates, key=lambda item: item[1], default=None)


def readout_too_wide(box, max_share=MAX_READOUT_FRAME_SHARE):
    return box[1] - box[0] > max_share


def text_corners(center, body, size, scale=1.0, right=(1.0, 0.0, 0.0), up=(0.0, 0.0, 1.0), char_w=CHAR_W):
    """Four world corners of a centred text box. Default axes match stage.text (standing, facing -Y);
    for stage.hud text pass the camera's right and up vectors."""
    w, h = text_extent(body, size, scale, char_w)
    return [tuple(center[i] + right[i] * sx * w / 2 + up[i] * sy * h / 2 for i in range(3))
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def project_box(corners, pos, target, lens=50.0, aspect=9 / 16, roll=0.0):
    """Project world corners; returns (xmin, xmax, ymin, ymax, min_depth)."""
    pts = [project_point(c, pos, target, lens, aspect, roll) for c in corners]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), max(xs), min(ys), max(ys), min(p[2] for p in pts))


def box_in_safe(box, safe=TEXT_SAFE, min_depth=MIN_DEPTH):
    """True when the whole projected box (xmin, xmax, ymin, ymax, depth) is inside the safe area."""
    return (box[0] >= safe[0] and box[1] <= safe[1] and box[2] >= safe[2] and box[3] <= safe[3]
            and box[4] > min_depth)


def find_text_clipped(samples, safe=TEXT_SAFE, min_depth=MIN_DEPTH):
    """samples: iterable of (frame, name, (xmin, xmax, ymin, ymax, depth)).
    Returns (frame, name, rounded box) for every box not fully inside the safe area."""
    return [(f, n, tuple(round(v, 3) for v in b)) for f, n, b in samples if not box_in_safe(b, safe, min_depth)]


def check_text_fits(texts, pos, target, lens=50.0, aspect=9 / 16, safe=TEXT_SAFE, roll=0.0):
    """Estimate check for one camera pose. texts: dicts with name, body, size, center and optional
    scale, right, up. Returns clipped (0, name, box) entries; run it for each shot's start, middle, end."""
    out = []
    for t in texts:
        kw = {k: t[k] for k in ("scale", "right", "up") if k in t}
        box = project_box(text_corners(t["center"], t["body"], t["size"], **kw), pos, target, lens, aspect, roll)
        out.append((0, t["name"], box))
    return find_text_clipped(out, safe)


def check_text_scene(scene, cam, apply, text_objects=None, nframes=0, safe=TEXT_SAFE, step=1):
    """In Blender: pose every step-th frame and project the real bound box of each visible text object.
    Visible means in a renderable collection (timeline.apply_frame hides collections, not objects). text_objects is
    optional; when given, its result is still filtered to the visible set. Returns the clipped list; a shot fails
    when it is not empty. (Not exercised by the pure tests; the actual-Blender probe covers it.)"""
    probe = BlenderProbe(scene, cam)

    def posed(f):
        apply(f)
        probe.update()

    getter = (lambda: only_visible(scene.collection, text_objects())) if text_objects else probe.text_objects
    return text_clips(nframes, posed, getter, probe.text_box, step, safe)


def shot_signature(pos, target, lens=50.0):
    """(azimuth deg, elevation deg, distance/lens scale) of a shot's camera relative to its target."""
    d = _sub(pos, target)
    dist = math.sqrt(_dot(d, d)) or 1e-9
    return (math.degrees(math.atan2(d[0], -d[1])), math.degrees(math.asin(max(-1.0, min(1.0, d[2] / dist)))),
            dist / lens)


def check_shot_variety(shots, min_azimuth=30.0, min_elevation=12.0, min_scale=0.25, neighbour_span=2):
    """shots: dicts pos, target, lens (one representative pose per shot). Returns (i, j) pairs that
    share one composition within neighbour_span shots: all three signature values are too close."""
    sigs = [shot_signature(s["pos"], s["target"], s.get("lens", 50.0)) for s in shots]
    same = []
    for i in range(len(sigs)):
        for j in range(i + 1, min(len(sigs), i + neighbour_span + 1)):
            (a1, e1, s1), (a2, e2, s2) = sigs[i], sigs[j]
            da = abs((a1 - a2 + 180) % 360 - 180)
            if da < min_azimuth and abs(e1 - e2) < min_elevation and abs(s1 - s2) / max(s1, s2, 1e-9) < min_scale:
                same.append((i, j))
    return same


def upper_area_empty(points_xy, min_top=0.6):
    """points_xy: projected (x, y) samples of everything visible in a shot, y up 0..1. True when no
    content reaches above min_top, i.e. the top of the frame is empty."""
    return not any(y >= min_top for _, y in points_xy)


# ---------------------------------------------------------------- consumer: visibility, one QA pass, render gate
UPPER_MIN_TOP = 2 / 3   # advisory: content should reach y >= this (the top third of the frame, y up 0..1)
UPPER_STEP = 16         # frames between upper-area samples (kept a multiple of hold, so each is a rendered frame)
SCENERY_ROLE = "scenery"   # object custom property codebuilt_role: stage.mark_scenery(obj) sets it; unmarked meshes are content
MAX_VERTS = 1500        # vertices projected per object per sample (stride sample above this)
MAX_LISTED = 20         # entries kept in an error message


class QAError(RuntimeError):
    """The generated build failed its pre-render QA, or tried to render without passing it."""


_GATE = {"apply": None, "nframes": 0, "hold": 1}   # open when "apply" is set: the exact function whose frames run_qa posed


def reset_qa():
    _GATE.update(apply=None, nframes=0, hold=1)


def qa_passed():
    return _GATE["apply"] is not None


def require_qa(what="render", apply=None, frames=(), hold=1):
    """Called by renderloop.render_frames(require_qa=True) before any frame is posed or rendered. Spends the gate whatever
    the outcome: one passing run_qa allows one render_frames call, for the same apply, only frames below the run's
    nframes, and only a hold that is a multiple of the run's hold (those are the frames run_qa posed)."""
    gate = dict(_GATE)
    reset_qa()
    if gate["apply"] is None:
        raise QAError(f"{what} refused: shotcheck.run_qa(...) has not passed for this build, or its pass was already used "
                      "(call run_qa before every render_frames; a failed run keeps the gate closed)")
    if apply is not gate["apply"]:
        raise QAError(f"{what} refused: run_qa passed for a different apply function than the one being rendered")
    if hold % gate["hold"]:
        raise QAError(f"{what} refused: hold={hold} renders frames run_qa did not pose (it posed multiples of {gate['hold']})")
    if any(f < 0 or f >= gate["nframes"] for f in frames):
        raise QAError(f"{what} refused: a frame is outside 0..{gate['nframes'] - 1}, the range run_qa checked")


def renderable_collections(root):
    """root and every descendant reachable without crossing a collection whose hide_render is set.
    timeline.apply_frame hides shots through collection.hide_render, which never touches object.hide_render."""
    out, stack = [], [root]
    while stack:
        c = stack.pop()
        if c.hide_render:
            continue
        out.append(c)
        stack.extend(reversed(list(c.children)))
    return out


def visible_objects(root, kinds=None):
    """Objects that render now: object.hide_render False and linked into a renderable collection. kinds: object types."""
    seen, out = set(), []
    for c in renderable_collections(root):
        for o in c.objects:
            if o.name in seen or o.hide_render or (kinds is not None and o.type not in kinds):
                continue
            seen.add(o.name)
            out.append(o)
    return out


def visible_text_objects(root):
    return visible_objects(root, kinds={"FONT"})


def only_visible(root, objs):
    names = {o.name for o in visible_objects(root)}
    return [o for o in objs if o.name in names]


def text_clips(nframes, apply, objects_fn, box_fn, step=1, safe=TEXT_SAFE):
    """Pose every step-th frame, project each object objects_fn() returns (box_fn(o) is None for a degenerate one)
    and return the (frame, name, box) entries that leave the safe area."""
    samples = []
    for f in range(0, nframes, step):
        apply(f)
        for o in objects_fn():
            box = box_fn(o)
            if box is not None:
                samples.append((f, o.name, box))
    return find_text_clipped(samples, safe)


def shot_pose_frames(ranges, hold=2):
    """One representative rendered frame (a multiple of hold) per shot, near its middle; None when a shot has none.
    ranges: timeline.shot_frame_ranges output."""
    out = []
    for _, a, b in ranges:
        m = (a + b) // 2
        m -= m % hold
        if m < a:
            m += hold
        out.append(m if a <= m < b else None)
    return out


def _in_frame(pts):
    return [(x, y) for x, y, d in pts if d > MIN_DEPTH and 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0]


def upper_area_points(objs):
    """objs: dicts with name, pts [(x, y, depth)] and optional scenery. The in-frame (x, y) points of every object not
    explicitly marked scenery. No size heuristic: a wide or tall subject is content."""
    return [p for o in objs if not o.get("scenery") for p in _in_frame(o["pts"])]


def _shot_name(ranges, f):
    return next((n for n, a, b in ranges if a <= f < b), None)


def run_qa_with(probe, apply, nframes, ranges, hold=2, upper_step=UPPER_STEP, safe=TEXT_SAFE, min_top=UPPER_MIN_TOP):
    """One pass over the rendered frames (0, hold, 2*hold, ...; held frames are copies). probe supplies update(),
    text_objects(), text_box(o), content(), cam_pose() (position, lens) and cam_target() (what stage.Camera.set
    recorded, or None); BlenderProbe is the real one. Returns a report dict. Closes the render gate first; only enforce()
    opens it. Blocking: text_clipped, same_composition, missing_target. Advisory: upper_warnings."""
    reset_qa()
    hold = max(1, int(hold))
    samples = shot_pose_frames(ranges, hold)
    uncheckable = [ranges[i][0] for i, f in enumerate(samples) if f is None or not 0 <= f < nframes]
    pose_at = {f: i for i, f in enumerate(samples) if f is not None and 0 <= f < nframes}
    step = max(hold, upper_step // hold * hold)
    upper_frames = set(range(0, nframes, step)) | set(pose_at)
    text_samples, depth_samples, upper_warnings, poses, missing, checked = [], [], [], {}, [], 0
    readout_names = set()
    for f in range(0, nframes, hold):
        apply(f)
        probe.update()
        checked += 1
        content = probe.content()
        for o in probe.text_objects():
            if getattr(o, "get", lambda *_: False)("codebuilt_readout", False):
                readout_names.add(o.name)
            box = probe.text_box(o)
            if box is not None:
                text_samples.append((f, o.name, box))
                if getattr(o, "get", lambda *_: False)("codebuilt_readout", False):
                    subject = subject_in_readout_box(content, box)
                    if subject is not None:
                        depth_samples.append((f, o.name, box[4], subject[1], subject[0], _shot_name(ranges, f)))
        if f in upper_frames and upper_area_empty(upper_area_points(content), min_top):
            upper_warnings.append((f, _shot_name(ranges, f)))
        if f in pose_at:
            target = probe.cam_target()
            if target is None:
                missing.append(_shot_name(ranges, f) or f"shot {pose_at[f]}")
            else:
                pos, lens = probe.cam_pose()
                poses[pose_at[f]] = {"pos": tuple(pos), "target": tuple(target), "lens": lens}
    order = sorted(poses)
    same = [(order[i], order[j]) for i, j in check_shot_variety([poses[k] for k in order])
            if order[j] - order[i] <= 2]
    clipped = find_text_clipped(text_samples, safe)
    too_wide = [(f, n, b) for f, n, b in text_samples if n in readout_names and readout_too_wide(b)]
    behind = find_readouts_behind_subject(depth_samples)
    return {"ok": not (clipped or too_wide or behind or same or missing or uncheckable), "text_clipped": clipped,
            "readout_too_wide": too_wide, "readout_behind_subject": behind, "same_composition": same, "missing_target": missing,
            "uncheckable_shots": uncheckable,
            "upper_warnings": upper_warnings, "frames_checked": checked, "shots": len(ranges), "shots_with_pose": len(poses),
            "nframes": nframes, "hold": hold}


def describe(report, include_warnings=False):
    """Short, bounded text for a QA report: its failures, plus the advisory warnings when include_warnings."""
    parts = []
    if report.get("uncheckable_shots"):
        parts.append(f"shots {report['uncheckable_shots'][:MAX_LISTED]} have no render-cadence QA sample")
    if report["text_clipped"]:
        names = sorted({c[1] for c in report["text_clipped"]})[:MAX_LISTED]
        frames = sorted({c[0] for c in report["text_clipped"]})[:MAX_LISTED]
        parts.append(f"text leaves the safe area {TEXT_SAFE}: {names} at frames {frames}")
    if report.get("readout_too_wide"):
        parts.append(f"readout exceeds {MAX_READOUT_FRAME_SHARE:.0%} of frame width")
    if report.get("readout_behind_subject"):
        groups = {}
        for frame, name, rd, sd, subject, shot in report["readout_behind_subject"]:
            key = (name, subject, shot)
            if key not in groups:
                if len(groups) >= MAX_LISTED:
                    continue
                groups[key] = [frame, frame, rd, sd]
            groups[key][1] = frame
        for (name, subject, shot), (first, last, rd, sd) in groups.items():
            frames = str(first) if first == last else f"{first}-{last}"
            parts.append(f"readout {name[:80]!r} in {str(shot)[:80]} is behind {subject[:80]!r} "
                         f"(readout {rd:.2f} m, object {sd:.2f} m) at frames {frames}: "
                         "move the readout nearer to the camera or move the object")
    if report["same_composition"]:
        parts.append(f"shots share one composition (indices): {report['same_composition'][:MAX_LISTED]}")
    if report["missing_target"]:
        parts.append(f"no camera target recorded for shots {report['missing_target'][:MAX_LISTED]}: position the camera with "
                     "cam.set(pos, target, ...) (stage.Camera.set) in each shot function")
    if include_warnings and report["upper_warnings"]:
        parts.append(f"warning (does not block): top third of the frame shows no content (frame, shot): {report['upper_warnings'][:MAX_LISTED]}")
    return ("; ".join(parts) or ("QA failed" if not report.get("ok") else "QA passed"))[:FAILURE_MAX_CHARS]


FAILURE_FILE = "/job/work/qa_failure.txt"
FAILURE_MAX_CHARS = 4000


def _record_failure(message):
    """Best effort: leave the QA failure text in the job folder so the host can show it to the model that has to fix the build
    (the fence discards the container output). Never raises; the QAError is what stops the build."""
    try:
        directory = os.path.dirname(FAILURE_FILE)
        if os.path.isdir(directory):
            with open(FAILURE_FILE, "w", encoding="utf-8") as fh:
                fh.write(message[:FAILURE_MAX_CHARS])
    except OSError:
        pass


def enforce(report, apply):
    """Open the render gate for a passing report, bound to the apply function that was posed; keep it closed and raise
    QAError for a failing one."""
    reset_qa()
    if not report.get("ok"):
        message = "QA failed before rendering: " + describe(report)
        _record_failure(message)
        raise QAError(message)
    _GATE.update(apply=apply, nframes=int(report["nframes"]), hold=max(1, int(report["hold"])))


def run_qa(scene, cam, apply, nframes, shots, fps=30, hold=2):
    """In Blender: the pre-render QA a generated build must pass. Call it once, as a plain statement, after the scene is
    built and before renderloop.render_frames(..., require_qa=True), which spends the pass: call it again before any further render_frames. shots: the (start_seconds, collection_name, fn) list
    given to timeline.apply_frame. Raises QAError on failure; renders nothing. The camera must be positioned with stage.Camera.set in every shot function."""
    from .timeline import shot_frame_ranges
    probe = BlenderProbe(scene, cam)
    report = run_qa_with(probe, apply, nframes, shot_frame_ranges(shots, nframes, fps), hold=hold)
    report["bounds_source"] = getattr(probe, "bounds_source", None)
    print("QA " + json.dumps({k: (v[:MAX_LISTED] if isinstance(v, list) else v) for k, v in report.items()}))
    if report["ok"] and report["upper_warnings"]:
        print("QA " + describe(report, include_warnings=True))
    enforce(report, apply)
    return report


class BlenderProbe:
    """The Blender side of run_qa_with. Unverified until the actual-Blender probe has run: bound_box on text, the
    numpy projection (self-checked against world_to_camera_view on first use) and base-mesh vertices are the assumptions."""

    def __init__(self, scene, cam):
        import bpy
        import numpy as np
        self.bpy, self.np, self.scene = bpy, np, scene
        self.cam = getattr(cam, "obj", cam)
        self.bounds_source = None
        self._matrix_ok = False

    def update(self):
        self.bpy.context.view_layer.update()

    def text_objects(self):
        return [o for o in visible_text_objects(self.scene.collection) if min(abs(s) for s in o.matrix_world.to_scale()) >= 1e-6]

    def readout_names(self):
        return {o.name for o in self.text_objects() if o.get("codebuilt_readout", False)}

    def _local_corners(self, o):
        try:
            oe = o.evaluated_get(self.bpy.context.evaluated_depsgraph_get())
            corners = [tuple(c) for c in oe.bound_box]
            if max(max(c) - min(c) for c in zip(*corners)) > 1e-9:
                self.bounds_source = self.bounds_source or "evaluated.bound_box"
                return corners
        except Exception:
            pass
        # Fallback: dimensions / scale, centred on the origin (the kit centres its text: align_x = align_y = CENTER).
        half = [d / (abs(s) or 1.0) / 2 for d, s in zip(o.dimensions, o.scale)]
        self.bounds_source = "dimensions-centred"
        return [(sx * half[0], sy * half[1], sz * half[2]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]

    def text_box(self, o):
        from bpy_extras.object_utils import world_to_camera_view
        from mathutils import Vector
        target = next((ch for ch in o.children if ch.type == "MESH" and o.get("codebuilt_readout", False)), o)
        if target is not o:
            corners = [tuple(v.co) for v in target.data.vertices]
            matrix = target.matrix_world
        else:
            corners = self._local_corners(o)
            matrix = o.matrix_world
        vs = [world_to_camera_view(self.scene, self.cam, matrix @ Vector(c)) for c in corners]
        return (min(v.x for v in vs), max(v.x for v in vs), min(v.y for v in vs), max(v.y for v in vs), min(v.z for v in vs))

    def cam_pose(self):
        return (tuple(self.cam.matrix_world.translation), float(self.cam.data.lens))

    def cam_target(self):
        """The target stage.Camera.set recorded on the camera object (custom property codebuilt_target), or None."""
        t = self.cam.get("codebuilt_target")
        return tuple(float(v) for v in t) if t is not None and len(t) == 3 else None

    def _camera_matrix(self):
        np, r = self.np, self.scene.render
        proj = self.cam.calc_matrix_camera(self.bpy.context.evaluated_depsgraph_get(), x=r.resolution_x, y=r.resolution_y,
                                           scale_x=r.pixel_aspect_x, scale_y=r.pixel_aspect_y)
        m = np.array(proj) @ np.array(self.cam.matrix_world.inverted())
        if not self._matrix_ok:
            self._self_check(m)
            self._matrix_ok = True
        return m

    def _self_check(self, m):
        from bpy_extras.object_utils import world_to_camera_view
        from mathutils import Vector
        np = self.np
        for off in ((0.0, 0.0, -5.0), (0.7, 0.4, -5.0), (-0.9, -0.5, -8.0)):
            p = self.cam.matrix_world @ Vector(off)
            ref = world_to_camera_view(self.scene, self.cam, p)
            h = m @ np.array([p.x, p.y, p.z, 1.0])
            got = (h[0] / h[3] * 0.5 + 0.5, h[1] / h[3] * 0.5 + 0.5, h[3])
            if max(abs(a - b) for a, b in zip(got, (ref.x, ref.y, ref.z))) > 2e-3:
                raise QAError(f"upper-area projection self-check failed: numpy {got} vs world_to_camera_view {tuple(ref)}")

    def content(self):
        """Visible MESH objects: dicts name, pts [(x, y, depth)] of (a stride sample of) the base-mesh vertices, scenery (the
        codebuilt_role='scenery' mark; excluded from subject checks)."""
        np, out = self.np, []
        m = self._camera_matrix()
        for o in visible_objects(self.scene.collection, kinds={"MESH"}):
            mw = np.array(o.matrix_world)
            n = len(o.data.vertices)
            if n == 0 or abs(np.linalg.det(mw[:3, :3])) < 1e-12:   # scale 0: a hidden readout plate
                continue
            if o.parent is not None and o.parent.type == "FONT":   # stage.hud_text plate: a readout, not subject content
                continue
            co = np.empty(n * 3, dtype=np.float32)
            o.data.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            if n > MAX_VERTS:
                co = co[::-(-n // MAX_VERTS)]
            world = co @ mw[:3, :3].T + mw[:3, 3]
            h = np.c_[world, np.ones(len(world))] @ m.T
            w = h[:, 3]
            front = w > MIN_DEPTH
            safe_w = np.where(front, w, 1.0)
            x = np.where(front, h[:, 0] / safe_w * 0.5 + 0.5, 0.5)
            y = np.where(front, h[:, 1] / safe_w * 0.5 + 0.5, 0.5)
            out.append({"name": o.name, "pts": list(zip(x.tolist(), y.tolist(), w.tolist())), "scenery": o.get("codebuilt_role") == SCENERY_ROLE})
        return out

    def subject_depth(self, box):
        """Nearest (object name, depth) overlapping this readout's projected box, or None."""
        return subject_in_readout_box(self.content(), box)
