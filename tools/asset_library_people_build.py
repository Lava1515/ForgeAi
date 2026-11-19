"""Build clothed CC0 people with MPFB on the host Blender and save each as one .blend for the asset library.
Run: blender -b -P build_people.py -- <mpfb assets dir> <out dir> [only_id]
Author: claude-pro · claude-fable-5-2, 2026-11-19. Not part of the pipeline; the pipeline only reads the saved files.
"""
import importlib, json, os, sys
import bpy
from mathutils import Vector

A, OUT = sys.argv[sys.argv.index("--") + 1], sys.argv[sys.argv.index("--") + 2]
ONLY = sys.argv[sys.argv.index("--") + 3] if len(sys.argv) > sys.argv.index("--") + 3 else None
base = "bl_ext.blender_org.mpfb"
HS = importlib.import_module(base + ".services.humanservice").HumanService
TS = importlib.import_module(base + ".services.targetservice").TargetService

# id, gender (0 f, 1 m), age (0.5 = 25 y, 0.75 = mid, 1 = old), race, weight, muscle, height, skin, suit, shoes, hair, eyes
PEOPLE = [
    ("person_adult_f_01", 0.0, 0.50, "caucasian", 0.50, 0.50, 0.50, "young_caucasian_female", "female_casualsuit01", "shoes01", "long01", "brown"),
    ("person_adult_f_02", 0.0, 0.55, "african", 0.55, 0.50, 0.55, "young_african_female", "female_casualsuit02", "shoes02", "afro01", "brown"),
    ("person_adult_f_03", 0.0, 0.50, "asian", 0.45, 0.50, 0.45, "young_asian_female", "female_elegantsuit01", "shoes03", "bob01", "brown"),
    ("person_adult_m_01", 1.0, 0.50, "caucasian", 0.55, 0.60, 0.55, "young_caucasian_male", "male_casualsuit01", "shoes04", "short01", "blue"),
    ("person_adult_m_02", 1.0, 0.55, "african", 0.55, 0.60, 0.60, "young_african_male", "male_casualsuit02", "shoes05", "short02", "brown"),
    ("person_adult_m_03", 1.0, 0.50, "asian", 0.50, 0.55, 0.50, "young_asian_male", "male_casualsuit04", "shoes06", "short03", "brown"),
    ("person_worker_m_01", 1.0, 0.65, "caucasian", 0.60, 0.65, 0.55, "middleage_caucasian_male", "male_worksuit01", "shoes04", "short04", "green"),
    ("person_old_f_01", 0.0, 0.95, "caucasian", 0.50, 0.40, 0.45, "old_caucasian_female", "female_casualsuit01", "shoes01", "bob02", "grey"),
    ("person_old_m_01", 1.0, 0.95, "african", 0.50, 0.45, 0.50, "old_african_male", "male_elegantsuit01", "shoes05", "short01", "brown"),
]


def one(path_dir, ext):
    f = [x for x in sorted(os.listdir(path_dir)) if x.endswith(ext)]
    if not f:
        raise RuntimeError(f"no {ext} in {path_dir}")
    return os.path.join(path_dir, f[0])


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for _ in range(4):
        bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def build(pid, gender, age, race, weight, muscle, height, skin, suit, shoes, hair, eyes):
    clear()
    m = TS.get_default_macro_info_dict()
    m.update(gender=gender, age=age, weight=weight, muscle=muscle, height=height)
    m["race"] = {k: (1.0 if k == race else 0.0) for k in ("asian", "caucasian", "african")}
    body = HS.create_human(scale=0.1, macro_detail_dict=m)
    body.name = pid + "_body"
    HS.set_character_skin(one(os.path.join(A, "skins", skin), ".mhmat"), body, skin_type="MAKESKIN")
    HS.add_builtin_rig(body, "default_no_toes", import_weights=True)
    for kind, folder in (("Eyes", os.path.join("eyes", "low-poly")), ("Eyebrows", os.path.join("eyebrows", "eyebrow001")),
                         ("Eyelashes", os.path.join("eyelashes", "eyelashes01")), ("Hair", os.path.join("hair", hair)),
                         ("Clothes", os.path.join("clothes", suit)), ("Clothes", os.path.join("clothes", shoes))):
        HS.add_mhclo_asset(one(os.path.join(A, folder), ".mhclo"), body, asset_type=kind, subdiv_levels=0,
                           material_type="MAKESKIN", set_up_rigging=True, interpolate_weights=True, import_subrig=False, import_weights=True)
    objs = list(bpy.context.scene.objects)
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    bpy.context.view_layer.update()
    for o in objs:
        if o.type == 'MESH':
            for c in o.bound_box:
                w = o.matrix_world @ Vector(c)
                lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    bpy.ops.file.pack_all()
    out = os.path.join(OUT, pid + ".blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, compress=True, copy=True)
    return {"id": pid, "kind": "person", "name": pid.replace("_", " "), "file": f"people/{pid}.blend",
            "category": "People/" + ("Male" if gender > 0.5 else "Female"),
            "tags": ["person", "human", "man" if gender > 0.5 else "woman", race, "old" if age > 0.9 else "adult", suit, hair, "rigged"],
            "description": f"Clothed {'man' if gender > 0.5 else 'woman'}, {race}, {suit}, hair {hair}; armature 'default_no_toes' for posing.",
            "dimensions_m": [round(hi.x - lo.x, 3), round(hi.y - lo.y, 3), round(hi.z - lo.z, 3)],
            "polycount": sum(len(o.data.polygons) for o in objs if o.type == 'MESH'),
            "objects": sorted(o.name for o in objs), "authors": ["MakeHuman Community (MPFB 2.0.18 + system assets)"],
            "licence": "CC0-1.0", "source": "https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html"}


os.makedirs(OUT, exist_ok=True)
entries = []
for p in PEOPLE:
    if ONLY and p[0] != ONLY:
        continue
    e = build(*p)
    entries.append(e)
    print("BUILT", json.dumps(e))
with open(os.path.join(OUT, "people.json" if not ONLY else f"people_{ONLY}.json"), "w", encoding="utf-8") as f:
    json.dump(entries, f, indent=1)
