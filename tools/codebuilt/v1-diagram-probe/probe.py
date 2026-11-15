"""V1 CPU probe: are Board diagrams legible in the real Blender projection? claude-pro · claude-sonnet-5-5, 2026-11-15.

Runs ONLY inside the approved generated CPU executor (tools/codebuilt/v1-diagram-probe/run-probe.mjs). It never renders, never saves a
scene and never calls shotcheck.run_qa (no render gate is opened); it poses frames and measures. Output: /job/work/diagram.json.

Three shots, each a diagram on a diagram.Board: the Everest triangle at the 34 m world scale of the failed draft, a ray through layers
of air, and a pair of number cards. For every stroke, arrow head and label it measures, with Blender's own camera projection
(world_to_camera_view), the size in pixels at 1080 x 1920 and compares it with the minimum (15 px strokes, 50 px capitals). It then
runs shotcheck's real pass (run_qa_with, the same text-safe-area and shot-variety rules) on the three shots. Finally it projects the
four corners of the OLD Everest triangle with the failed camera and shows Blender agrees with diagram.diagnose that they were off screen.
"""
import json
import math
from pathlib import Path

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

from blender_worker.codebuilt import diagram, meshes, shotcheck, stage, timeline

FPS, NFRAMES = 30, 180
SHOT_STARTS = [0, 2, 4]
W, H = 1080, 1920
scene = stage.reset_scene()
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = W, H, 100
cam = stage.Camera(scene)
colls = {n: meshes.coll(scene, n) for n in ('place-a', 'place-b', 'place-c')}


def ease(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def ramp(t, a, b):
    return max(0.0, min(1.0, (t - a) / (b - a)))


# A: the Everest triangle, drawn on a 34 x 28 m board (the scale of the failed world-space drawing)
A = diagram.Board(colls['place-a'], 'tri', (0, 0, 14), 34, 28, lens=35, az_max=18, el_max=14)
A_items = [
    (A.line((-0.85, -0.55), (0.85, -0.55), 'blue'), 0.0, 0.4),
    (A.line((-0.85, -0.55), (-0.85, -0.2), 'ink'), 0.3, 0.5),
    (A.line((-0.85, -0.2), (0.85, 0.7), 'orange'), 0.5, 0.8),
    (A.line((0.85, -0.55), (0.85, 0.7), 'green'), 0.7, 0.9),
    (A.dot((-0.85, -0.55), 'ink'), 0.0, 0.1), (A.dot((0.85, 0.7), 'red'), 0.8, 0.9),
    (A.label('170 KM', (0, -0.78)), 0.4, 0.6), (A.label('PEAK XV', (0.45, 0.9)), 0.9, 1.0),
]
A.require()
# B: a ray bending through three layers of air
B = diagram.Board(colls['place-b'], 'ray', (0, 0, 10), 24, 20, lens=35, az_max=18, el_max=14)
B_items = [(B.line((-0.9, v), (0.9, v), 'blue'), 0.0, 0.3) for v in (-0.45, 0.0, 0.45)]
B_items += [
    (B.arrow((-0.85, -0.85), (-0.1, 0.0), 'orange'), 0.3, 0.6), (B.arrow((-0.1, 0.0), (0.85, 0.7), 'red'), 0.6, 0.9),
    (B.label('AIR BENDS', (0, -0.72)), 0.5, 0.7), (B.label('LAYERS', (0.55, 0.28)), 0.2, 0.4),
]
B.require()
# C: two number cards
C = diagram.Board(colls['place-c'], 'cards', (0, 0, 7), 12, 9, lens=35, az_max=18, el_max=14)
C_items = [(C.label('250000 STADIA', (0, 0.45)), 0.0, 0.3), (C.label('40000 KM', (0, -0.45)), 0.4, 0.7), (C.line((-0.8, 0), (0.8, 0), 'ink'), 0.2, 0.4)]
C.require()
BOARDS = {'a': A, 'b': B, 'c': C}
VIEW = {'a': (-18, 0), 'b': (18, 0), 'c': (0, 14)}


def make_shot(key, items):
    board, (az, el) = BOARDS[key], VIEW[key]

    def shot(t):
        local = t - SHOT_STARTS['abc'.index(key)]
        u = ease(local / 2.0)
        board.camera(cam, u, push=0.06, az=az, el=el)
        for item, t0, t1 in items:
            board.draw(item, ease(ramp(local, t0 * 1.2, t1 * 1.2 + 0.2)))
    return shot


shots = [(0, 'place-a', make_shot('a', A_items)), (2, 'place-b', make_shot('b', B_items)), (4, 'place-c', make_shot('c', C_items))]


def apply(f):
    timeline.apply_frame(f, shots, colls, FPS)


def to_px(v):
    return (v.x * W, v.y * H)


def dist(p, q):
    return math.hypot(p[0] - q[0], p[1] - q[1])


def stroke_px(o, t):
    """Thickness of a box stroke on screen: the two ends of its local z extent (the in-plane perpendicular), in pixels."""
    a = world_to_camera_view(scene, cam.obj, o.matrix_world @ Vector((0, 0, t / 2)))
    b = world_to_camera_view(scene, cam.obj, o.matrix_world @ Vector((0, 0, -t / 2)))
    return dist(to_px(a), to_px(b))


probe = shotcheck.BlenderProbe(scene, cam)
rows, ok = [], True
for shot_i, (key, items) in enumerate((('a', A_items), ('b', B_items), ('c', C_items))):
    board = BOARDS[key]
    for f in (int(SHOT_STARTS[shot_i] * FPS) + 2, int(SHOT_STARTS[shot_i] * FPS) + 58):   # start of the push, and the end of the shot
        apply(f)
        probe.update()
        for item, _, _ in items:
            if type(item) is dict:
                head, shaft = item['head'], item['shaft']
                R = max(abs(v.co.x) for v in head.data.vertices)
                p1 = world_to_camera_view(scene, cam.obj, head.matrix_world @ Vector((R, 0, 0)))
                p2 = world_to_camera_view(scene, cam.obj, head.matrix_world @ Vector((-R, 0, 0)))
                t = max(abs(v.co.z) for v in shaft.data.vertices) * 2
                rows.append({'shot': key, 'frame': f, 'kind': 'arrow', 'stroke_px': stroke_px(shaft, t), 'head_px': dist(to_px(p1), to_px(p2))})
            elif 'dg_body' in item.keys():
                box = probe.text_box(item)
                rows.append({'shot': key, 'frame': f, 'kind': 'label', 'body': item['dg_body'], 'cap_px': (box[3] - box[2]) * H,
                             'width_px': (box[1] - box[0]) * W, 'in_safe': shotcheck.box_in_safe(box)})
            elif item['dg'][4] == 0.0 and item.scale.x > 0:
                t = max(abs(v.co.z) for v in item.data.vertices) * 2
                rows.append({'shot': key, 'frame': f, 'kind': 'line', 'stroke_px': stroke_px(item, t)})
out = {'blender': bpy.app.version_string, 'kit_diagram_sha256': __import__('hashlib').sha256(Path(diagram.__file__).read_bytes()).hexdigest(),
       'minimum_px': {'stroke': diagram.px(diagram.MIN_STROKE, 'w'), 'cap': diagram.px(diagram.MIN_CAP, 'h')},
       'boards': {k: b.report() for k, b in BOARDS.items()}, 'measured': rows}
Path('/job/work/diagram.json').write_text(json.dumps(out, indent=1, default=str))
bad = [r for r in rows if (r['kind'] in ('line', 'arrow') and r['stroke_px'] < diagram.px(diagram.MIN_STROKE, 'w') * 0.97)
       or (r['kind'] == 'arrow' and r['head_px'] < 3 * r['stroke_px'] * 0.97)
       or (r['kind'] == 'label' and (r['cap_px'] < diagram.px(diagram.MIN_CAP, 'h') * 0.97 or not r['in_safe']))]
out['below_minimum'] = bad

# shotcheck's real pass over every rendered frame: text safe area, shot variety, camera targets (no render gate is opened)
ranges = timeline.shot_frame_ranges(shots, NFRAMES, FPS)
report = shotcheck.run_qa_with(probe, apply, NFRAMES, ranges, hold=2)
out['qa'] = {k: (v[:5] if isinstance(v, list) else v) for k, v in report.items()}

# The old Everest triangle: camera 50 m from the baseline middle, 22 mm; Blender's projection against diagram.diagnose / shotcheck.project_point
tgt, lens = (-3, 17, 14), 22
az, d, el = math.radians(45), 50, math.radians(4)
pos = (tgt[0] + d * math.sin(az) * math.cos(el), tgt[1] - d * math.cos(az) * math.cos(el), tgt[2] + d * math.sin(el))
cam.set(pos, tgt, lens=lens)
bpy.context.view_layer.update()
corners = [(-20, 0, 7.5), (14, 34, 0.5), (14, 34, 36), (-20, 0, 0.5)]
blender = [tuple(world_to_camera_view(scene, cam.obj, Vector(c))) for c in corners]
pure = [shotcheck.project_point(c, pos, tgt, lens) for c in corners]
out['old_everest_triangle'] = {'blender_xy_depth': blender, 'pure_xy_depth': pure,
                               'max_difference': max(abs(a - b) for p, q in zip(blender, pure) for a, b in zip(p, q)),
                               'diagnose': diagram.diagnose(corners, pos, tgt, lens, stroke=1.4)}
Path('/job/work/diagram.json').write_text(json.dumps(out, indent=1, default=str))
assert not bad, bad
assert report['ok'], report
assert out['old_everest_triangle']['max_difference'] < 2e-3, out['old_everest_triangle']
assert out['old_everest_triangle']['diagnose'], 'the old triangle must be reported'
