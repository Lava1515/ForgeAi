"""CPU-only Blender probe of the stealth_jet_teardown set (lane M5p). claude-pro · claude-sonnet-5-5, 2026-11-15.

Runs as /job/build/build.py inside the approved generated CPU executor. It builds the set (no render, no save), measures
the REAL world-space vertices Blender holds, and writes /job/work/teardown_probe.json with named checks. It never raises
on a failed check, so one run shows every problem; the launcher reads `failed` from the JSON.
"""
import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Vector

from blender_worker.codebuilt import stage, shotcheck, teardown
from blender_worker.codebuilt.sets import registry, stealth_jet_teardown

OUT = {"blender": bpy.app.version_string}
CHECKS = []
ASPECT = 1080 / 1920


def check(name, ok, detail):
    CHECKS.append({"name": name, "ok": bool(ok), "detail": detail})


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


OUT["kit_sha256"] = {n: sha(m.__file__) for n, m in (("teardown", teardown), ("set", stealth_jet_teardown), ("shotcheck", shotcheck))}


def world_verts(obj):
    mw = obj.matrix_world
    return [tuple(mw @ v.co) for v in obj.data.vertices]


def bbox(pts):
    xs, ys, zs = zip(*pts)
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def build_at(origin, scale=1.0):
    scene = stage.reset_scene()
    h = stealth_jet_teardown.build(origin=origin, scale=scale)
    bpy.context.view_layer.update()
    return scene, h


def pose_world(h, t, mode="exploded", stagger=True):
    h["jet"].pose(t, mode=mode, stagger=stagger)
    bpy.context.view_layer.update()
    return {pid: world_verts(o) for pid, o in h["jet"].parts.items()}


# ------------------------------------------------------------------ 1. counts and size against the skill text
geo = teardown.geometry_summary()
OUT["parts"] = len(teardown.PARTS)
OUT["subsystems"] = teardown.subsystems()
OUT["vertices"] = sum(g["vertex_count"] for g in geo.values())
OUT["faces"] = sum(g["face_count"] for g in geo.values())

# ------------------------------------------------------------------ 2. rest pose equals the authored coordinates
scene, h = build_at((0.0, 0.0, 0.0))
rest = pose_world(h, 0.0, mode="assembled")
gap = {}
for pid, pts in rest.items():
    v, _ = teardown.build_part_geometry(pid)
    lo, hi = bbox([tuple(p) for p in v])
    wlo, whi = bbox(pts)
    gap[pid] = round(max(abs(a - b) for a, b in zip(lo + hi, wlo + whi)), 4)
OUT["rest_vs_authored_max_bbox_gap"] = gap
check("rest_pose_matches_authored_coordinates", all(g < 1e-4 for g in gap.values()),
      {k: v for k, v in gap.items() if v >= 1e-4})
all_rest = [p for pts in rest.values() for p in pts]
lo, hi = bbox(all_rest)
OUT["assembled_extent"] = {"x": hi[0] - lo[0], "y": hi[1] - lo[1], "z": hi[2] - lo[2], "min": lo, "max": hi}
# wing root must meet the fuselage chine
root = min(rest["wing_right"], key=lambda p: abs(p[0] - 1.65) + abs(p[1] - 0.4) + abs(p[2] - 0.12))
chine = (1.65, 0.4, 0.15)
d_root = math.dist(root, chine)
check("wing_root_touches_fuselage_chine", d_root < 0.1, {"nearest_wing_vertex": root, "chine": chine, "distance": round(d_root, 3)})
nose = max(all_rest, key=lambda p: p[1])
# the RAM skin is the upper shell scaled 1.025 about the datum, so it may stand 2.5 percent beyond the nose apex
check("nothing_ahead_of_the_nose_apex", nose[1] <= 5.2 * 1.025 + 1e-3, {"furthest_forward_y": round(nose[1], 3), "nose_apex_y": 5.2})
OUT["pedestal_world_bbox"] = bbox(world_verts(h["pedestal"]))

# ------------------------------------------------------------------ 3. a non-zero origin moves the whole set, once
ORIGIN = (10.0, 20.0, 5.0)
def measure(origin):
    _, hh = build_at(origin)
    return {t: pose_world(hh, t) for t in (0.0, 0.5, 1.0)}, bbox(world_verts(hh["pedestal"]))


ref, ped0 = measure((0.0, 0.0, 0.0))
moved, ped2 = measure(ORIGIN)
worst = {}
for t in ref:
    for pid in ref[t]:
        la, _ = bbox(ref[t][pid])
        lb, _ = bbox(moved[t][pid])
        err = max(abs((lb[i] - la[i]) - ORIGIN[i]) for i in range(3))
        worst[pid] = max(worst.get(pid, 0.0), round(err, 4))
ped_err = round(max(abs((ped2[0][i] - ped0[0][i]) - ORIGIN[i]) for i in range(3)), 4)
OUT["origin_shift_error"] = {"parts_max": max(worst.values()), "pedestal": ped_err}
check("origin_shifts_parts_exactly_once", max(worst.values()) < 1e-3, {k: v for k, v in worst.items() if v >= 1e-3})
check("origin_shifts_pedestal_exactly_once", ped_err < 1e-3, {"pedestal_shift_error": ped_err})

# ------------------------------------------------------------------ 4. the pedestal must not hide any part
scene, h = build_at((0.0, 0.0, 0.0))
ped_lo, ped_hi = bbox(world_verts(h["pedestal"]))
radius = (ped_hi[0] - ped_lo[0]) / 2
hidden = {}
low = {}
for t in (0.0, 0.5, 1.0):
    for pid, pts in pose_world(h, t).items():
        n = sum(1 for p in pts if p[2] < ped_hi[2] - 1e-6 and math.hypot(p[0], p[1]) <= radius)
        if n:
            hidden[f"{pid}@t{t}"] = n
        low[pid] = min(low.get(pid, 99.0), min(p[2] for p in pts))
OUT["lowest_z_by_part"] = {k: round(v, 3) for k, v in low.items()}
OUT["pedestal_top_z"] = ped_hi[2]
check("pedestal_hides_no_vertex", not hidden, {"vertices_below_pedestal_top": hidden})

# ------------------------------------------------------------------ 5. cameras frame what the shot is about
POSES = dict(teardown.CAMERA_POSES)
for ang in registry.get("stealth_jet_teardown").angles:
    POSES["registry:" + ang.name] = {"pos": ang.pos, "target": ang.target, "lens": ang.lens}
# what each pose is for (skill shot beats): parts that must be in the frame, and the animation time of that beat
FOCUS = {
    "exploded_wide": (1.0, None),   # None = every part
    "cockpit_avionics": (1.0, ("canopy", "cockpit_interior", "avionics_bay")),
    "propulsion_rear": (0.75, ("engine_left", "engine_right", "exhaust_nozzle", "intake_left", "intake_right")),
    "weapons_bay_low": (0.95, ("weapons_bay", "bay_door_left", "bay_door_right", "weapon_rack_left", "weapon_rack_right", "ordnance_left", "ordnance_right")),
    "facets_stealth": (0.0, ("fuselage_upper", "canopy")),
    "registry:exploded": (1.0, None),
    "registry:front": (0.0, ("fuselage_upper", "canopy")),
    "registry:rear": (0.75, ("engine_left", "engine_right", "exhaust_nozzle")),
}
SAFE = (0.04, 0.96, 0.04, 0.96)
framing = {}
for name, pose in POSES.items():
    t, focus = FOCUS[name]
    parts = pose_world(h, t)
    use = parts if focus is None else {k: parts[k] for k in focus}
    pts = [p for ps in use.values() for p in ps]
    proj = [shotcheck.project_point(p, pose["pos"], pose["target"], pose["lens"], ASPECT) for p in pts]
    behind = sum(1 for x, y, d in proj if d <= 0.05)
    out = sum(1 for x, y, d in proj if not (SAFE[0] <= x <= SAFE[1] and SAFE[2] <= y <= SAFE[3]))
    xs = [x for x, y, d in proj if d > 0.05]
    ys = [y for x, y, d in proj if d > 0.05]
    cam_inside = [k for k, ps in parts.items()
                  if all(lo_ <= c <= hi_ for c, lo_, hi_ in zip(pose["pos"], *bbox(ps)))]
    framing[name] = {"t": t, "focus": "all" if focus is None else list(focus), "vertices": len(proj),
                     "behind_camera": behind, "outside_safe_area": out,
                     "outside_share": round(out / len(proj), 3),
                     "x_range": [round(min(xs), 3), round(max(xs), 3)], "y_range": [round(min(ys), 3), round(max(ys), 3)],
                     "camera_inside_parts": cam_inside}
OUT["framing"] = framing
for name, f in framing.items():
    limit = 0.0 if name in ("exploded_wide", "registry:exploded") else 0.05
    check(f"frame_{name}", f["behind_camera"] == 0 and f["outside_share"] <= limit and not f["camera_inside_parts"],
          {k: f[k] for k in ("t", "outside_share", "behind_camera", "x_range", "y_range", "camera_inside_parts")})

# ------------------------------------------------------------------ 6. the callout the skill shows
CALLOUT = "PLATYPUS 2D NOZZLE: IR SUPPRESSION"
scene, h = build_at((0.0, 0.0, 0.0))
h["jet"].pose(0.75)
bpy.context.view_layer.update()
cam = stage.Camera(scene)
pose = POSES["propulsion_rear"]
cam.set(pose["pos"], pose["target"], pose["lens"])
scene.render.resolution_x, scene.render.resolution_y = 1080, 1920
bpy.context.view_layer.update()
try:
    lbl = h["jet"].callout("exhaust_nozzle", CALLOUT, pose="propulsion_rear")
except TypeError:  # baseline kit: no pose argument
    lbl = h["jet"].callout("exhaust_nozzle", CALLOUT)
bpy.context.view_layer.update()
probe = shotcheck.BlenderProbe(scene, cam)
probe.update()
box = probe.text_box(lbl)
nozzle_world = h["jet"].parts["exhaust_nozzle"].matrix_world.translation
lbl_world = lbl.matrix_world.translation
facing = (cam.obj.matrix_world.translation - lbl_world).normalized().dot(lbl.matrix_world.to_quaternion() @ Vector((0, 0, 1)))
OUT["callout"] = {"text": CALLOUT, "body": lbl.data.body, "size": round(lbl.data.size, 3), "box": [round(v, 3) for v in box],
                  "label_world": [round(v, 3) for v in lbl_world], "nozzle_world": [round(v, 3) for v in nozzle_world],
                  "label_to_nozzle_distance": round((lbl_world - nozzle_world).length, 3),
                  "inside_text_safe": shotcheck.box_in_safe(box), "width_share": round(box[1] - box[0], 3),
                  "facing_dot": round(facing, 3)}
check("callout_inside_text_safe_in_its_own_shot", shotcheck.box_in_safe(box), OUT["callout"])
check("callout_not_wider_than_readout_limit", not shotcheck.readout_too_wide(box), OUT["callout"])
px, py, _ = shotcheck.project_point(tuple(nozzle_world), pose["pos"], pose["target"], pose["lens"], ASPECT)
OUT["callout"]["part_on_screen"] = [round(px, 3), round(py, 3)]
OUT["callout"]["screen_gap"] = round(math.hypot((box[0] + box[1]) / 2 - px, (box[2] + box[3]) / 2 - py), 3)
check("callout_sits_by_its_part_on_screen", OUT["callout"]["screen_gap"] < 0.3, OUT["callout"])
check("callout_faces_the_camera", facing > 0.95, OUT["callout"])
try:
    h["jet"].callout("platypus_exhaust", "x")
    check("callout_unknown_part_is_loud", False, "returned without error for the FACTS key platypus_exhaust")
except KeyError:
    check("callout_unknown_part_is_loud", True, "KeyError")
if hasattr(h["jet"], "set_callout_visible"):
    h["jet"].set_callout_visible("exhaust_nozzle", False)
    probe.update()
    check("hidden_callout_is_skipped_by_text_qa", lbl not in probe.text_objects(), {})

# ------------------------------------------------------------------ 7. x-ray plus highlight, then reset
scene, h = build_at((0.0, 0.0, 0.0))
jet = h["jet"]
jet.set_xray(True)
jet.highlight("propulsion")
def wears(pid, mat):
    return len(jet.parts[pid].data.materials) == 1 and jet.parts[pid].data.materials[0] == mat


shell_mat = jet.materials["xray_shell"]
check("highlight_keeps_xray_shell_transparent", wears("fuselage_upper", shell_mat) and wears("wing_left", shell_mat),
      {"fuselage_upper_material": jet.parts["fuselage_upper"].data.materials[0].name})
def first_mat(pid):
    return jet.parts[pid].data.materials[0].name


check("highlight_marks_target_and_dims_the_rest",
      first_mat("engine_left").startswith("hl_glow") and first_mat("intake_right").startswith("hl_glow") and first_mat("landing_gear").startswith("dimmed"),
      {"engine_left": first_mat("engine_left"), "landing_gear": first_mat("landing_gear")})
jet.reset_highlight()
check("reset_highlight_keeps_xray_on", wears("fuselage_upper", shell_mat),
      {"is_xray": jet.is_xray, "fuselage_upper_material_after_reset": jet.parts["fuselage_upper"].data.materials[0].name})
jet.set_xray(False)
check("xray_off_restores_shell", wears("fuselage_upper", jet.original_materials["fuselage_upper"]), {})
names = {m.name for m in bpy.data.materials}
for _ in range(3):
    jet.highlight("payload")
OUT["highlight_materials_after_3_calls"] = sorted(m.name for m in bpy.data.materials if m.name.startswith(("hl_glow", "dimmed")))
check("highlight_does_not_pile_up_materials", len([m for m in bpy.data.materials if m.name.startswith(("hl_glow", "dimmed"))]) <= 2,
      OUT["highlight_materials_after_3_calls"])

# ------------------------------------------------------------------ 8. canopy and bay doors open with their own stagger window
scene, h = build_at((0.0, 0.0, 0.0))
jet = h["jet"]
jet.pose(0.5)
door = math.degrees(jet.parts["bay_door_right"].rotation_euler[1])
canopy = math.degrees(jet.parts["canopy"].rotation_euler[0])
OUT["angles_at_t0_5"] = {"bay_door_right_deg": round(door, 1), "canopy_deg": round(canopy, 1)}
check("bay_doors_fully_open_by_end_of_phase_1_t0_5", abs(door) >= 54.9, OUT["angles_at_t0_5"])
check("canopy_fully_open_by_end_of_phase_1_t0_5", canopy >= 21.9, OUT["angles_at_t0_5"])
bpy.context.view_layer.update()
for side, sign in (("left", -1), ("right", 1)):
    pts = world_verts(jet.parts[f"bay_door_{side}"])
    xs = sorted(pts, key=lambda p: abs(p[0]))
    near_centre, near_hinge = xs[:6], xs[-6:]
    dz = sum(p[2] for p in near_hinge) / 6 - sum(p[2] for p in near_centre) / 6
    check(f"bay_door_{side}_swings_down_and_out", dz > 0.4, {"hinge_edge_z_minus_free_edge_z": round(dz, 3)})

# ------------------------------------------------------------------ 9. lights and handles
scene, h = build_at((0.0, 0.0, 0.0))
missing = [k for k in ("collection", "origin", "subject", "lights", "jet", "pedestal") if k not in h]
check("handles_complete", not missing and len(h["lights"]) == 3, {"missing": missing, "lights": len(h["lights"])})

OUT["checks"] = CHECKS
OUT["failed"] = [c["name"] for c in CHECKS if not c["ok"]]
Path("/job/work/teardown_probe.json").write_text(json.dumps(OUT, indent=2, default=str))
