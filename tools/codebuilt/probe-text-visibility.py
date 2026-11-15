"""CPU-only Blender regression probe. codex · gpt-6.1-sol, 2026-11-15.

Run through the approved generated CPU executor; never renders or saves a scene.
"""
import hashlib
import json
from pathlib import Path

import bpy
from blender_worker.codebuilt import meshes, stage, shotcheck, timeline

scene = stage.reset_scene()
scene.render.resolution_x, scene.render.resolution_y = 1080, 1920
cam = stage.Camera(scene)
cam.set((0, -10, 0), (0, 0, 0))
a, b = meshes.coll(scene, 'active'), meshes.coll(scene, 'inactive')
parent = bpy.data.objects.new('gauge', None)
a.objects.link(parent)
label = stage.text(a, 'gl100', '100', .3, None, (0, 0, 0))
label.parent = parent
other = stage.text(b, 'cd1', 'DAY 1', .3, None, (0, 0, 0))
visible = stage.text(a, 'persistent', 'RECONSTRUCTION', .3, None, (3, 0, 0))
probe = shotcheck.BlenderProbe(scene, cam)
states = []
for scale in (1, 0, 1):
    parent.scale = (scale,) * 3
    timeline.apply_frame(0, [(0, 'active', lambda t: None)], {'active': a, 'inactive': b})
    probe.update()
    states.append({'parent_scale': scale, 'text': [o.name for o in probe.text_objects()],
                   'world_scale': list(label.matrix_world.to_scale()),
                   'hidden_collection': b.hide_render,
                   'clipped': [(o.name, list(probe.text_box(o))) for o in probe.text_objects()
                               if not shotcheck.box_in_safe(probe.text_box(o))]})
assert 'cd1' not in states[0]['text']
assert 'gl100' not in states[1]['text']
assert 'gl100' in states[2]['text']
assert any(n == 'persistent' for n, _ in states[1]['clipped'])
# Regression: preserve world labels, widen the camera, and constrain oversized/off-edge HUDs.
stage.fit_text(cam, [visible, label, other])
probe.update()
assert shotcheck.box_in_safe(probe.text_box(visible))
assert visible.scale.x == 1
hud = stage.hud_text(a, 'readout', 'CALCIUM CARBONATE', .3, None, 2, .5, None)
hud_states = []
for lens in (24, 85):
    cam.set((0, -10, 0), (0, 0, 0), lens=lens)
    stage.hud(cam, hud, 3, .33, 1, 2)
    probe.update()
    assert shotcheck.box_in_safe(probe.text_box(hud))
    assert not shotcheck.readout_too_wide(probe.text_box(hud))
    assert hud.scale.x > 0
    hud_states.append({'lens': lens, 'box': list(probe.text_box(hud)), 'scale': hud.scale.x})
# A too-small plate must not conceal glyph clipping from QA.
tight = stage.hud_text(a, 'tight_plate', 'LONG GLYPHS', .3, None, .01, .01, None)
stage.hud(cam, tight, 0, 0, 5, 1)
probe.update()
from bpy_extras.object_utils import world_to_camera_view
plate = next(iter(tight.children))
xs = [world_to_camera_view(scene, cam.obj, plate.matrix_world @ v.co).x for v in plate.data.vertices]
box = probe.text_box(tight)
assert box[1] - box[0] > max(xs) - min(xs)
assert shotcheck.box_in_safe(box)
# A visible label deliberately moved out of bounds must still fail strict QA.
visible.location.x = 100
probe.update()
assert not shotcheck.box_in_safe(probe.text_box(visible))
out = {'blender': bpy.app.version_string, 'kit': shotcheck.__file__,
       'kit_sha256': hashlib.sha256(Path(shotcheck.__file__).read_bytes()).hexdigest(),
       'stage_sha256': hashlib.sha256(Path(stage.__file__).read_bytes()).hexdigest(),
       'states': states, 'hud_fitted': hud_states}
Path('/job/work/visibility.json').write_text(json.dumps(out, indent=2))

# Replay only scene setup and a few poses INSIDE the fence, never the QA/render tail.
# Keep name/frame/collection pairs rather than the lossy union in the failure message.
import ast
for name in ('m2', 'm4'):
    source = Path('/job/build/' + name + '.py').read_text()
    tree = ast.parse(source)
    boundary = next(i for i, node in enumerate(tree.body)
                    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                    and ast.unparse(node.value.func) == 'shotcheck.run_qa')
    tree.body = tree.body[:boundary]
    ns = {'__name__': '__probe__'}
    exec(compile(tree, name, 'exec'), ns)
    p = shotcheck.BlenderProbe(ns['scene'], ns['cam'])
    frames = sorted(set([0, 290, 319, 338] + [int(t * 30) + 1 for t in ns['SHOT_STARTS']]
                        + [int((a + b) * 15) for a, b in zip(ns['SHOT_STARTS'], ns['SHOT_STARTS'][1:])]))
    rows, fitted, lenses = [], [], []
    for f in frames:
        ns['apply'](f)
        p.update()
        for obj in p.text_objects():
            box = p.text_box(obj)
            if not shotcheck.box_in_safe(box):
                rows.append({'frame': f, 'name': obj.name, 'box': list(box),
                             'scale': list(obj.matrix_world.to_scale()),
                             'collections': [(c.name, c.hide_render) for c in obj.users_collection]})
        world_labels = [obj for obj in p.text_objects() if not obj.get('codebuilt_readout', False)]
        stage.fit_text(ns['cam'], world_labels)
        p.update()
        lenses.append(ns['cam'].data.lens)
        fitted.extend({'frame': f, 'name': obj.name, 'box': list(p.text_box(obj))}
                      for obj in p.text_objects() if not shotcheck.box_in_safe(p.text_box(obj)))
    out[name] = {'source_sha256': hashlib.sha256(source.encode()).hexdigest(), 'failures': rows,
                 'after_fit_failures': fitted, 'lens_range': [min(lenses), max(lenses)]}
    Path('/job/work/visibility.json').write_text(json.dumps(out, indent=2))
    assert not fitted, (name, fitted)
