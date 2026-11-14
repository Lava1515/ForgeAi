"""Set: stealth_jet_teardown. Runs inside Blender. Stylized stealth jet explainer set on presentation pedestal.

Faceted stealth jet with 17+ procedural subsystems on a dark presentation pedestal, lit by a 3-point studio lighting rig
(overhead key, soft fill, rim light). Disassembly and exploded views are posed per frame with `jet.pose(t, mode='exploded')`.
Highlight subsystems with `jet.highlight('propulsion')` and toggle X-ray transparency with `jet.set_xray(True)`.
Handles: jet (the StealthJet instance), pedestal, collection, origin, subject (world point), lights.
"""
from .. import teardown
from .common import SetBuilder

NAME = "stealth_jet_teardown"
SUBJECT_POINT = (0.0, 0.0, 0.5)


def build(origin=(0.0, 0.0, 0.0), scale=1.0, **kw):
    b = SetBuilder(NAME, origin, seed=42)

    # Turntable pedestal (low circular platform)
    p_v, p_f = teardown._make_cylinder((0.0, 0.0, -0.25), (0.0, 0.0, 0.0), r=7.5, n=48)
    import bpy
    p_me = bpy.data.meshes.new("me_pedestal")
    p_me.from_pydata(b.v(p_v).tolist(), [], p_f)
    p_me.update()
    p_ob = bpy.data.objects.new("turntable_pedestal", p_me)
    p_ob.location = b.origin
    p_mat = teardown._make_pbr_material("pedestal_mat", (0.04, 0.04, 0.05), rough=0.85)
    if p_mat:
        p_me.materials.append(p_mat)
    b.c.objects.link(p_ob)

    # 3-point studio lighting rig (calibrated for dark stealth composite surfaces)
    b.area("LGT-keyJet", (6.0, -8.0, 12.0), (0.0, 0.0, 0.5), energy=4500.0, size=8.0, color=(1.0, 0.98, 0.95))
    b.area("LGT-fillJet", (-8.0, -6.0, 8.0), (0.0, 0.0, 0.5), energy=1800.0, size=12.0, color=(0.75, 0.85, 1.0))
    b.area("LGT-rimJet", (0.0, 12.0, 4.0), (0.0, 0.0, 0.5), energy=6000.0, size=6.0, color=(0.5, 0.8, 1.0))

    # Build procedural stealth jet
    jet = teardown.build(b.c, origin=b.origin, scale=scale)

    return b.handles(SUBJECT_POINT, jet=jet, pedestal=p_ob)
