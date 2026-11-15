"""Set: stealth_jet_teardown. Runs inside Blender. Stylized stealth jet explainer set on presentation pedestal.

Faceted stealth jet of 24 procedural parts in 7 subsystems on a dark presentation pedestal, lit by a 3-point studio lighting rig
(overhead key, soft fill, rim light). Disassembly and exploded views are posed per frame with `jet.pose(t, mode='exploded')`
(t 0 assembled, 1 fully exploded). Highlight a part id or subsystem with `jet.highlight('propulsion')`, toggle X-ray with
`jet.set_xray(True)`, and add a shot readout with `jet.callout('exhaust_nozzle', 'TEXT', pose='propulsion_rear')` (a part id, not a
facts key; hide it outside its shot with `jet.set_callout_visible(part_id, False)`). Read the codebuilt-teardown skill for the parts,
the beat time t of each pose and what may be said about them: the parts are illustrative, not a verified F-117.
Handles: jet (the StealthJet instance), pedestal, collection, origin, subject (world point), lights.

The pedestal top sits PEDESTAL_CLEARANCE below the lowest point any part reaches while exploded (landing gear and bombs
drop several meters), so it never hides a part from above. The jet therefore floats above the disc when assembled.
`origin` moves the whole set once (jet root and pedestal); parts are placed relative to the jet root.
Never put a camera below the pedestal top. Exploded, the jet is about 20 m across.
"""
from .. import teardown
from .common import SetBuilder

NAME = "stealth_jet_teardown"
SUBJECT_POINT = (0.0, 0.0, 0.5)
PEDESTAL_RADIUS = 11.0        # exploded wings reach about 10 m out
PEDESTAL_THICKNESS = 0.25
PEDESTAL_CLEARANCE = 0.3


def pedestal_top_z():
    """Local z of the pedestal top (pure): below the lowest point of the whole teardown."""
    return teardown.lowest_point_z() - PEDESTAL_CLEARANCE


def build(origin=(0.0, 0.0, 0.0), scale=1.0, **kw):
    b = SetBuilder(NAME, origin, seed=42)

    # Turntable pedestal (low circular platform below the lowest teardown point). Local vertices; the object is placed once.
    top = pedestal_top_z()
    p_v, p_f = teardown._make_cylinder((0.0, 0.0, top - PEDESTAL_THICKNESS), (0.0, 0.0, top), r=PEDESTAL_RADIUS, n=48)
    import bpy
    p_me = bpy.data.meshes.new("me_pedestal")
    p_me.from_pydata(p_v.tolist(), [], p_f)
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
