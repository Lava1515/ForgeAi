"""CPU-only camera search for the stealth_jet_teardown shots (lane M5p). claude-pro · claude-sonnet-5-5, 2026-11-15.

Runs as /job/build/build.py in the approved generated CPU executor. For each shot it keeps the designed viewing direction and
lens, aims at the middle of what the shot is about, and finds the nearest camera distance at which all of it is inside the
safe frame. Writes /job/work/camera_search.json. Nothing renders and nothing is saved.
"""
import json
import math
from pathlib import Path

import bpy
from blender_worker.codebuilt import stage, shotcheck, teardown
from blender_worker.codebuilt.sets import stealth_jet_teardown

ASPECT = 1080 / 1920
SAFE = (0.05, 0.95, 0.05, 0.95)
scene = stage.reset_scene()
h = stealth_jet_teardown.build()


def parts_at(t):
    h["jet"].pose(t)
    bpy.context.view_layer.update()
    return {pid: [tuple(o.matrix_world @ v.co) for v in o.data.vertices] for pid, o in h["jet"].parts.items()}


def norm(v):
    m = math.sqrt(sum(c * c for c in v))
    return tuple(c / m for c in v)


def stats(pts, pos, target, lens):
    proj = [shotcheck.project_point(p, pos, target, lens, ASPECT) for p in pts]
    out = sum(1 for x, y, d in proj if d <= 0.05 or not (SAFE[0] <= x <= SAFE[1] and SAFE[2] <= y <= SAFE[3]))
    xs = [x for x, y, d in proj]
    ys = [y for x, y, d in proj]
    return out, (min(xs), max(xs)), (min(ys), max(ys))


def search(pts, direction, lens, up_margin=1.04):
    lo = [min(p[i] for p in pts) for i in range(3)]
    hi = [max(p[i] for p in pts) for i in range(3)]
    target = tuple((a + b) / 2 for a, b in zip(lo, hi))
    d_unit = norm(direction)
    best = None
    for _ in range(4):
        found = None
        d = 2.0
        while d < 120.0:
            pos = tuple(t + c * d for t, c in zip(target, d_unit))
            out, xr, yr = stats(pts, pos, target, lens)
            if out == 0:
                found = (d, pos, xr, yr)
                break
            d += 0.25
        if not found:
            return None
        d, pos, xr, yr = found
        r, u, f = shotcheck.camera_basis(pos, target)
        fw = d * shotcheck.SENSOR_MM * ASPECT / lens
        fh = d * shotcheck.SENSOR_MM / lens
        shift = [(((xr[0] + xr[1]) / 2) - 0.5) * fw * c1 + (((yr[0] + yr[1]) / 2) - 0.5) * fh * c2 for c1, c2 in zip(r, u)]
        target = tuple(t + s for t, s in zip(target, shift))
        best = found
    d = best[0] * up_margin
    pos = tuple(t + c * d for t, c in zip(target, d_unit))
    out, xr, yr = stats(pts, pos, target, lens)
    return {"pos": [round(v, 1) for v in pos], "target": [round(v, 1) for v in target], "lens": lens, "distance": round(d, 2),
            "outside": out, "x_range": [round(v, 3) for v in xr], "y_range": [round(v, 3) for v in yr]}


def dirs(azimuth_xy, elevations):
    n = math.hypot(*azimuth_xy)
    return [(azimuth_xy[0] / n * math.cos(math.radians(e)), azimuth_xy[1] / n * math.cos(math.radians(e)), math.sin(math.radians(e))) for e in elevations]


WEAPONS = ("weapons_bay", "bay_door_left", "bay_door_right", "weapon_rack_left", "weapon_rack_right", "ordnance_left", "ordnance_right")
REAR = ("engine_left", "engine_right", "exhaust_nozzle", "intake_left", "intake_right")
SHOTS = {
    # name: (t, focus parts or None, [viewing directions from the aim point], lens)
    "exploded_wide": (1.0, None, dirs((9.5, -16.0), (24, 40, 55, 65, 75)), 35),
    "cockpit_avionics": (1.0, ("canopy", "cockpit_interior", "avionics_bay"), dirs((2.2, 3.5), (30, 45, 60)), 50),
    "propulsion_rear": (0.75, REAR, dirs((-3.5, -7.5), (23, 40, 55, 65)), 45),
    "weapons_bay_low": (0.95, WEAPONS, dirs((4.0, -6.0), (-10, -25, -40, -55)) + dirs((0.0, -1.0), (-30, -50)), 40),
    "facets_stealth": (0.0, ("fuselage_upper", "canopy"), dirs((0.0, 10.0), (11, 25, 40)), 45),
}
out = {}
for name, (t, focus, direction_list, lens) in SHOTS.items():
    parts = parts_at(t)
    use = parts if focus is None else {k: parts[k] for k in focus}
    pts = [p for ps in use.values() for p in ps]
    rows = []
    for direction in direction_list:
        res = search(pts, direction, lens)
        if res:
            res["elevation_deg"] = round(math.degrees(math.asin(norm(direction)[2])), 1)
            res["camera_inside_parts"] = [k for k, ps in parts.items()
                                          if all(min(p[i] for p in ps) <= res["pos"][i] <= max(p[i] for p in ps) for i in range(3))]
            res["y_span"] = round(res["y_range"][1] - res["y_range"][0], 3)
            rows.append(res)
    out[name] = rows
Path("/job/work/camera_search.json").write_text(json.dumps(out, indent=1))
