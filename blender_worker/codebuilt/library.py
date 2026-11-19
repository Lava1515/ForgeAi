"""Asset library: real CC0 lighting, models and people for a scene (the loaders run inside Blender).

Everything here is read from `assets/` next to this file, which the job fence already mounts read-only. Nothing is
downloaded at render time: `tools/asset_library.py` fetches assets on the host and writes `assets/catalog.json`.

    from blender_worker.codebuilt import library
    library.find("sunset", kind="hdri")            # pure Python: catalog entries, best match first
    library.hdri(scene, "some_hdri_id", strength=1.0, rotation_deg=40, visible=False)
    drill = library.model(c, "Drill_01", loc=(0, 0, 0), height=0.3)   # root empty; children are the real meshes
    person = library.model(c, "person_adult_f_01", loc=(2, 0, 0), height=1.7)
    library.pose_person(person, arms=(0.4, -0.4), legs=(-0.4, 0.4))   # every frame, from t

`catalog()`, `find()` and `picker_text()` need no Blender. Author: claude-pro · claude-fable-5-2, 2026-11-19.
"""
import json
import math
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("CODEBUILT_ASSETS") or Path(__file__).resolve().parent / "assets")
KINDS = ("hdri", "model", "person")


class LibraryError(ValueError):
    """An asset that is not in the local library was asked for, or its file is missing."""


def catalog(root=None):
    """All local assets as a list of dicts (id, kind, name, file, category, tags, ...). Empty when nothing is fetched."""
    p = Path(root or ROOT) / "catalog.json"
    if not p.is_file():
        return []
    return [e for e in json.loads(p.read_text(encoding="utf-8")).get("assets", [])
            if not str(e.get("category", "")).lower().split("/")[0] == "weapons"
            and not re.search(r"rifle|sword|katana|cannon", e["id"], re.I)]


def _text(e):
    attrs = " ".join(str(v) for v in (e.get("attributes") or {}).values())
    return " ".join([e["id"], e.get("name", ""), e.get("category", ""), " ".join(e.get("tags", [])), attrs]).lower().replace("_", " ")


def find(words, kind=None, root=None):
    """Entries matching the words (a string or a list), most matched words first. kind: 'hdri', 'model' or 'person'."""
    if kind is not None and kind not in KINDS:
        raise LibraryError(f"kind must be one of {KINDS}, got {kind!r}")
    ws = [w for w in (words.lower().split() if isinstance(words, str) else [str(w).lower() for w in words]) if w]
    scored = []
    for e in catalog(root):
        if kind and e["kind"] != kind:
            continue
        t = _text(e)
        n = sum(1 for w in ws if w in t)
        if n or not ws:
            scored.append((-n, e["id"].lower(), e))
    return [e for _, _, e in sorted(scored, key=lambda s: s[:2])]


def get(asset_id, root=None):
    """The catalog entry and the absolute file path of one asset. Raises LibraryError with the nearest ids if unknown."""
    base = Path(root or ROOT)
    for e in catalog(base):
        if e["id"] == asset_id:
            f = (base / e["file"]).resolve()
            if base.resolve() not in f.parents or not f.is_file():
                raise LibraryError(f"asset file is missing for {asset_id!r}: {e['file']}")
            return e, f
    near = [e["id"] for e in find(asset_id.replace("_", " "), root=base)[:5]]
    raise LibraryError(f"no asset {asset_id!r} in the local library; nearest: {near or 'none'}")


def picker_text(root=None, limit=400):
    """One line per asset for a prompt: kind, id, real size, what it is."""
    lines = []
    for e in catalog(root)[:limit]:
        if e["kind"] == "hdri":
            a = e.get("attributes") or {}
            what = ", ".join(str(a[k]) for k in ("environment", "time_of_day", "weather", "light_type") if a.get(k))
            lines.append(f"hdri   {e['id']}: {what or e.get('category', '')}")
        else:
            d = e.get("dimensions_m") or []
            size = " x ".join(f"{v:.2f}" for v in d) + " m" if len(d) == 3 else "size unknown"
            lines.append(f"{e['kind']:6s} {e['id']}: {e.get('name', '')} ({size}) {e.get('category', '')}")
    return "\n".join(lines)


# ---------------------------------------------------------------- inside Blender
def hdri(scene, asset_id, strength=1.0, rotation_deg=0.0, visible=False, background=(0.05, 0.05, 0.06)):
    """Light the scene with a real photographed sky or room.

    visible=False (default) keeps the camera background a plain colour while objects are lit and reflect the real
    environment: the look of a studio shot. visible=True shows the photograph behind the scene. rotation_deg turns the
    light around the vertical axis; turn it until the sun or key light comes from where the shot needs it.
    Replaces the world's nodes. Returns the world.
    """
    import bpy

    e, path = get(asset_id)
    if e["kind"] != "hdri":
        raise LibraryError(f"{asset_id!r} is a {e['kind']}, not an hdri")
    world = scene.world or bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Rotation"].default_value = (0.0, 0.0, math.radians(rotation_deg))
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(path), check_existing=True)
    light = nt.nodes.new("ShaderNodeBackground")
    light.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(coord.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], light.inputs["Color"])
    if visible:
        nt.links.new(light.outputs["Background"], out.inputs["Surface"])
        return world
    plain = nt.nodes.new("ShaderNodeBackground")
    plain.inputs["Color"].default_value = (*background, 1.0)
    plain.inputs["Strength"].default_value = 1.0
    path_node = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(path_node.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(light.outputs["Background"], mix.inputs[1])
    nt.links.new(plain.outputs["Background"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    return world


def _bounds(objs):
    from mathutils import Vector

    lo, hi = Vector((1e18,) * 3), Vector((-1e18,) * 3)
    seen = False
    for o in objs:
        if o.type != 'MESH':
            continue
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            lo = Vector(min(a, b) for a, b in zip(lo, w))
            hi = Vector(max(a, b) for a, b in zip(hi, w))
            seen = True
    return (lo, hi) if seen else (Vector((0, 0, 0)), Vector((0, 0, 0)))


def model(c, asset_id, loc=(0.0, 0.0, 0.0), height=None, scale=1.0, yaw_deg=0.0, name=None):
    """Append a real model (or a person) into collection `c` and return its root empty.

    The model stands on `loc` (its lowest point at loc z, centred in x and y). `height` in scene units rescales it so
    its tallest side is that high; otherwise `scale` multiplies the authored real-world size (metres). Parts keep
    their names and materials, so they can be found with `parts(root)` and animated one by one. Move, turn and scale
    the returned root; do not re-parent its children.
    """
    import bpy
    from mathutils import Vector

    e, path = get(asset_id)
    if e["kind"] not in ("model", "person"):
        raise LibraryError(f"{asset_id!r} is a {e['kind']}, not a model")
    with bpy.data.libraries.load(str(path), link=False) as (src, dst):
        dst.objects = list(src.objects)
    objs = [o for o in dst.objects if o is not None and o.type in ('MESH', 'EMPTY', 'ARMATURE', 'CURVE')]
    for o in dst.objects:
        if o is not None and o not in objs:
            bpy.data.objects.remove(o)
    if not objs:
        raise LibraryError(f"{asset_id!r} has no usable objects")
    for o in objs:
        c.objects.link(o)
    bpy.context.view_layer.update()
    lo, hi = _bounds(objs)
    root = bpy.data.objects.new(name or asset_id, None)
    root.empty_display_size = 0.2
    c.objects.link(root)
    # Root sits under the model's centre at its lowest point, so `loc` is where the model stands.
    root.location = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    bpy.context.view_layer.update()
    for o in objs:
        if o.parent is None:
            world = o.matrix_world.copy()
            o.parent = root
            o.matrix_parent_inverse = root.matrix_world.inverted()
            o.matrix_world = world
    tall = max(hi.z - lo.z, 1e-9)
    s = (height / tall) if height else scale
    root.scale = (s, s, s)
    root.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
    root.location = Vector(loc)
    root["asset_id"] = asset_id
    root["asset_licence"] = e.get("licence", "")
    if e["kind"] == "person":
        pose_person(root)
    return root


def _rig(root):
    for o in root.children:
        if o.type == 'ARMATURE':
            return o
    raise LibraryError(f"{root.name!r} is not a library person (no armature under the root)")


def pose_person(root, arms_down=1.0, arms=(0.0, 0.0), legs=(0.0, 0.0), head_yaw=0.0):
    """Pose a library person; a pure function of its arguments, so call it every frame with values computed from t.

    The person faces -Y, like `figures`. arms_down: 0 is the authored pose with the arms held out, 1 (default, set by
    `model`) lets them hang by the sides. arms=(left, right) and legs=(left, right) swing forward (+) or back (-) in
    radians; a walk is legs=(0.5*sin(t*8), -0.5*sin(t*8)) with arms=(-0.4*sin(t*8), 0.4*sin(t*8)). head_yaw turns
    the head, + to the person's left. Move, turn and scale the person with the root.
    """
    from mathutils import Matrix

    rig = _rig(root)

    def turn(name, rot):
        pb = rig.pose.bones.get(name)
        if pb is None:
            return
        rest = pb.bone.matrix_local
        head = Matrix.Translation(rest.to_translation())
        pb.matrix = head @ rot @ head.inverted() @ rest

    hang = math.radians(30.0) * arms_down
    for side, sign, i in ((".L", 1.0, 0), (".R", -1.0, 1)):
        turn("upperarm01" + side, Matrix.Rotation(-arms[i], 4, 'X') @ Matrix.Rotation(sign * hang, 4, 'Y'))
        turn("upperleg01" + side, Matrix.Rotation(-legs[i], 4, 'X'))
    turn("neck01", Matrix.Rotation(head_yaw, 4, 'Z'))
    return root


def parts(root):
    """Every mesh under a model root, by name: {name: object}."""
    out = {}
    stack = list(root.children)
    while stack:
        o = stack.pop()
        if o.type == 'MESH':
            out[o.name] = o
        stack.extend(o.children)
    return out


def used(scene):
    """Ids of library assets present in the scene (for the credits and the making-of)."""
    ids = {o["asset_id"] for o in scene.objects if "asset_id" in o}
    w = scene.world
    if w and w.use_nodes:
        for n in w.node_tree.nodes:
            if n.type == 'TEX_ENVIRONMENT' and n.image:
                stem = Path(n.image.filepath).stem
                ids.update(e["id"] for e in catalog() if e["kind"] == "hdri" and Path(e["file"]).stem == stem)
    return sorted(ids)
