"""X1 CPU swatch and Earth proof probe: procedural surface kit, worn/rounded edges, AgX look, and relief Earth.

Runs inside the approved CPU executor or headless Blender 5.2.
DO NOT execute Blender/GPU while active batch cleanup is pending.
Usage:
  blender -b -P tools/codebuilt/probe-x1-surface-swatch.py
Output:
  /job/work/x1_swatch_proof.json (or output/temp/x1_swatch_proof.json)
"""
import json
import math
import os
import sys
from pathlib import Path

try:
    import bpy
    from mathutils import Vector
except ImportError:
    print("probe-x1-surface-swatch: bpy not present in host environment. Designed for Blender CPU container.")
    sys.exit(0)

from blender_worker.codebuilt import maps, materials, meshes, stage


def inspect_material(mat):
    """Audit node tree of a material: Principled inputs, bump, bevel, texture nodes."""
    nt = mat.node_tree
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if b is None:
        return dict(name=mat.name, valid=False, error="No BSDF_PRINCIPLED")

    inputs_summary = {}
    for k in ("Base Color", "Roughness", "Metallic", "IOR", "Alpha", "Subsurface Weight",
              "Coat Weight", "Sheen Weight", "Transmission Weight", "Anisotropic"):
        if k in b.inputs:
            val = b.inputs[k].default_value
            if hasattr(val, '__iter__'):
                inputs_summary[k] = [round(float(x), 3) for x in val]
            else:
                inputs_summary[k] = round(float(val), 3)

    node_types = [n.type for n in nt.nodes]
    has_bump = any(n.type == 'BUMP' for n in nt.nodes)
    has_bevel = any(n.type == 'BEVEL' for n in nt.nodes)
    has_noise = any(n.type == 'TEX_NOISE' for n in nt.nodes)
    has_wave = any(n.type == 'TEX_WAVE' for n in nt.nodes)
    has_voronoi = any(n.type == 'TEX_VORONOI' for n in nt.nodes)
    has_ramp = any(n.type == 'VALTORGB' for n in nt.nodes)

    normal_linked = len(b.inputs["Normal"].links) > 0 if "Normal" in b.inputs else False

    return dict(
        name=mat.name,
        valid=True,
        node_count=len(nt.nodes),
        node_types=sorted(set(node_types)),
        has_bump=has_bump,
        has_bevel=has_bevel,
        has_noise=has_noise,
        has_wave=has_wave,
        has_voronoi=has_voronoi,
        has_ramp=has_ramp,
        normal_linked=normal_linked,
        inputs=inputs_summary
    )


def build_swatch_scene():
    """Build a swatch grid with all 12 procedural surfaces plus Earth relief base."""
    scene = stage.reset_scene()
    stage.setup_render(scene, view_transform='AgX', look='Punchy')

    c_swatches = meshes.coll(scene, "swatches")
    c_map = meshes.coll(scene, "map")

    # Lights with contact shadows
    sun = stage.sun(c_swatches, "sun_key", (-15, -20, 30), (0, 0, 0), energy=3.0, contact_shadow=True, shadow_distance=0.2)
    area = stage.area(c_swatches, "area_fill", (15, -15, 20), (0, 0, 0), energy=8000, size=20.0, contact_shadow=True)

    # 12 Procedural Surface Materials
    mats = [
        ("wood", materials.wood("swatch_wood", rough=0.55, bump=0.2, bevel=0.015)),
        ("brushed_metal", materials.brushed_metal("swatch_brushed_metal", rough=0.35, bump=0.15, anisotropic=0.8, bevel=0.01)),
        ("painted_metal", materials.painted_metal("swatch_painted_metal", paint_color=(0.15, 0.35, 0.7), wear=0.3, bump=0.2, bevel=0.015)),
        ("concrete", materials.concrete("swatch_concrete", rough=0.88, bump=0.3, bevel=0.02)),
        ("rock", materials.rock("swatch_rock", rough=0.8, bump=0.6, strata=True, bevel=0.025)),
        ("water", materials.water("swatch_water", rough=0.05, bump=0.25)),
        ("ice", materials.ice("swatch_ice", rough=0.15, sss=0.35, bump=0.2, bevel=0.01)),
        ("glass", materials.glass("swatch_glass", rough=0.02, ior=1.45, alpha=0.3, bevel=0.01)),
        ("rubber", materials.rubber("swatch_rubber", rough=0.75, bump=0.1, bevel=0.02)),
        ("fabric", materials.fabric("swatch_fabric", rough=0.82, sheen=0.6, bump=0.15)),
        ("soil", materials.soil("swatch_soil", rough=0.92, bump=0.45, wetness=0.1, bevel=0.02)),
        ("grass", materials.grass("swatch_grass", rough=0.75, bump=0.35, sss=0.15)),
    ]

    # Grid placement: 4 columns x 3 rows
    objects = []
    for i, (kind, mat) in enumerate(mats):
        col_idx = i % 4
        row_idx = i // 4
        x = (col_idx - 1.5) * 1.8
        y = 0.0
        z = (1.0 - row_idx) * 1.8 + 3.0
        b_cube = meshes.box(f"swatch_{kind}", c_swatches, mat, (x, y, z), (0.6, 0.6, 0.6), bevel=0.04)
        stage.round_edges(b_cube, width=0.02, segments=2)
        objects.append(b_cube)

    # Earth relief map with bright country fills
    wm = maps.WorldMap(c_map, detail="110m", palette="relief", scale=2.5, origin=(0.0, 15.0, 0.0), relief=True)
    wm.highlight("BRA", color=(1.0, 0.55, 0.08), lift=0.3, emission=0.3)
    wm.highlight("EGY", color=(0.1, 0.75, 1.0), lift=0.25, emission=0.25)

    cam = stage.Camera(scene)
    cam.set(pos=(0.0, -12.0, 3.0), target=(0.0, 0.0, 3.0), lens=35)

    # Inspect all created materials
    audits = {name: inspect_material(m) for name, m in mats}
    audits["earth_relief"] = inspect_material(wm.sea.data.materials[0])

    report = dict(
        view_transform=scene.view_settings.view_transform,
        look=getattr(scene.view_settings, 'look', None),
        gtao_enabled=getattr(scene.eevee, 'use_gtao', False),
        shadows_enabled=getattr(scene.eevee, 'use_shadows', False),
        raytracing_enabled=getattr(scene.eevee, 'use_raytracing', False),
        sun_contact_shadow=getattr(sun.data, 'use_contact_shadow', False),
        area_contact_shadow=getattr(area.data, 'use_contact_shadow', False),
        swatch_count=len(mats),
        materials=audits,
        map_countries_count=len(wm.objs),
        all_materials_valid=all(a["valid"] for a in audits.values()),
        all_bump_or_bevel=all(a["has_bump"] or a["has_bevel"] or a.get("normal_linked") for a in audits.values())
    )

    out_dir = Path("/job/work") if Path("/job/work").exists() else Path("output/temp")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "x1_swatch_proof.json"
    out_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"X1 CPU swatch proof written to {out_file}")
    print(json.dumps(dict(
        view_transform=report["view_transform"],
        look=report["look"],
        swatches=report["swatch_count"],
        all_valid=report["all_materials_valid"],
        all_relief=report["all_bump_or_bevel"]
    ), indent=2))
    return report


if __name__ == "__main__":
    build_swatch_scene()
