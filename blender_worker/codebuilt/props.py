"""Ready-made scenery and props for places a build makes itself (runs inside Blender).

The eight sets in `sets/` are fixed places. Most topics need a place that is not among them (a beach at night, a
desert, the Moon's surface, deep space). These builders make the common pieces of such a place in one call each, in the
same toy look as the sets, so a custom place costs a dozen lines instead of a hundred.

Every builder takes the collection `c` first and returns ONE object: a mesh, or an empty that parents the pieces. Move,
rotate, scale or hide that object per frame. Sizes are in metres; a person from `figures` is 1.8 tall. Nothing here is
keyframed and nothing reads the clock.
"""
import math

import numpy as np

from . import materials, meshes, stage
from .geometry import Path, grid_faces


def _rng(seed):
    return np.random.default_rng(int(seed))


def _parent(root, *objs):
    for o in objs:
        o.parent = root
    return root


# ---------------------------------------------------------------- sky, ground, water
def sky(c, top=(0.12, 0.42, 0.95), horizon=(0.75, 0.9, 1.0), radius=230.0, loc=(0, 0, 0)):
    """Emissive sky dome all the way round (a full hemisphere, so the camera may look in any direction). Marked as scenery,
    casts no shadow. Night: top=(0.0, 0.0, 0.03), horizon=(0.03, 0.05, 0.16). Sunset: top=(0.2, 0.2, 0.5), horizon=(1.0, 0.55, 0.3)."""
    m = bpy_gradient_z("sky", horizon, top)
    o = meshes.ball("sky", radius, m, c, loc=loc, nu=48, nv=16, lat0=-12.0, lat1=89.6)
    try:
        o.visible_shadow = False
    except Exception as ex:  # property differs across Blender versions
        print("shadow flag skipped:", ex)
    return stage.mark_scenery(o)


def bpy_gradient_z(name, low, high):
    """Emissive vertical gradient in object space (low colour at the horizon, high colour at the zenith)."""
    import bpy
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*low, 1)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (*high, 1)
    e = nt.nodes.new('ShaderNodeEmission')
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], e.inputs[0])
    nt.links.new(e.outputs[0], o.inputs[0])
    return m


def ground(c, color=(0.36, 0.62, 0.3), color2=None, size=220.0, loc=(0, 0, 0), rough=0.9, scale=0.35):
    """Flat ground square of half-size `size` at z = loc.z, two-tone noise (grass, sand, snow, rock, moon dust). Scenery.
    Grass (0.36,0.62,0.3); sand (0.86,0.74,0.5); snow (0.93,0.95,1.0); moon dust (0.55,0.55,0.58); asphalt (0.1,0.1,0.11)."""
    c2 = color2 or tuple(v * 0.8 for v in color)
    m = materials.noise_mat("ground", color, c2, rough=rough, scale=scale, bump=0.15, sss=0.0, coat=0.0)
    o = meshes.mk("ground", [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [(0, 1, 2, 3)], m, c, smooth=False)
    o.scale = (size, size, 1)
    o.location = loc
    return stage.mark_scenery(o)


def hills(c, color=(0.3, 0.55, 0.28), loc=(0, 60, 0), width=160.0, height=14.0, n=7, seed=3):
    """A row of soft rounded hills along X at loc (a horizon line behind the action). Returns the parent empty."""
    r = _rng(seed)
    root = meshes.empty(c, "hills", loc=loc)
    m = materials.col(color, 0.9)
    for k in range(n):
        x = (k / max(n - 1, 1) - 0.5) * width + float(r.uniform(-6, 6))
        w, h = float(r.uniform(0.8, 1.4)) * width / n, float(r.uniform(0.6, 1.0)) * height
        _parent(root, meshes.ball("hill", 1.0, m, c, loc=(x, float(r.uniform(-8, 8)), -h * 0.15), scale=(w, w * 0.6, h), nu=24, nv=10))
    return root


def water(c, loc=(0, 0, 0.05), size=120.0, color=(0.05, 0.35, 0.7)):
    """Opaque glossy water surface (alpha water renders as grey stipple). A 40x40 grid, so a shot can wave it with meshes.set_verts.
    The rest shape is flat at z = loc.z. Returns the mesh; `o["grid"] = 40`."""
    m = materials.pbr("water", color, 0.08, Coat_Weight=1.0, Coat_Roughness=0.05)
    o = meshes.grid("water", 40, 40, lambda u, v: ((u - 0.5) * 2 * size, (v - 0.5) * 2 * size, 0.0), m, c)
    o.location = loc
    o["grid"] = 40
    return o


# ---------------------------------------------------------------- plants, rocks, weather
def tree(c, loc=(0, 0, 0), h=5.0, kind="round", seed=0):
    """A tree of height h. kind: 'round' (leafy ball crown), 'pine' (stacked cones), 'palm' (curved trunk and fronds), 'dead' (bare)."""
    r = _rng(seed)
    root = meshes.empty(c, "tree", loc=loc)
    wood = materials.col((0.42, 0.26, 0.13), 0.7)
    if kind == "palm":
        tp = Path([(0, 0, 0), (0.03 * h, 0, 0.36 * h), (0.02 * h, 0, 0.72 * h), (0.06 * h, 0, h)], [0.04 * h, 0.033 * h, 0.027 * h, 0.022 * h], 12)
        _parent(root, meshes.mk("trunk", tp.verts(tp.R, 10), grid_faces(10, 12, True), wood, c))
        leaf = materials.col((0.10, 0.45, 0.14), 0.4, Coat_Weight=0.3)
        for k in range(8):
            a = k * 2 * math.pi / 8
            fr = meshes.ball("frond", 1.0, leaf, c, loc=(0.06 * h + 0.22 * h * math.cos(a), 0.22 * h * math.sin(a), 0.97 * h),
                             scale=(0.27 * h, 0.055 * h, 0.013 * h), nu=12, nv=6)
            fr.rotation_euler = (0, 0.45, a)
            _parent(root, fr)
        return root
    _parent(root, meshes.lathe("trunk", [(0.001, 0), (0.07 * h, 0), (0.05 * h, 0.5 * h), (0.001, 0.52 * h)], wood, c, n=12, subsurf=0))
    if kind == "pine":
        leaf = materials.col((0.07, 0.36, 0.16), 0.8)
        for k in range(3):
            z0, rad = (0.28 + 0.2 * k) * h, (0.3 - 0.07 * k) * h
            _parent(root, meshes.lathe("cone", [(0.001, z0), (rad, z0), (0.001, z0 + 0.34 * h)], leaf, c, n=16, subsurf=0))
    elif kind == "round":
        leaf = materials.col((0.16, 0.52, 0.18), 0.8)
        for k in range(5):
            a = k * 2.4 + float(r.uniform(0, 1))
            d = 0.0 if k == 0 else 0.17 * h
            _parent(root, meshes.ball("crown", 1.0, leaf, c, loc=(d * math.cos(a), d * math.sin(a), (0.66 + 0.06 * (k % 2)) * h),
                                      scale=(0.27 * h, 0.27 * h, 0.24 * h), nu=16, nv=10))
    else:  # dead: a few bare branches
        for k in range(4):
            a = k * 1.7
            br = meshes.ball("branch", 1.0, wood, c, loc=(0.1 * h * math.cos(a), 0.1 * h * math.sin(a), (0.5 + 0.08 * k) * h),
                             scale=(0.02 * h, 0.02 * h, 0.18 * h), nu=8, nv=6)
            br.rotation_euler = (0.7 * math.sin(a), 0.7 * math.cos(a), 0)
            _parent(root, br)
    return root


def bush(c, loc=(0, 0, 0), s=1.0, color=(0.18, 0.5, 0.2)):
    """Low leafy bush about s metres across."""
    root = meshes.empty(c, "bush", loc=loc)
    m = materials.col(color, 0.8)
    for k, (dx, dy, dz, r) in enumerate([(0, 0, 0.3, 0.5), (0.4, 0.1, 0.25, 0.38), (-0.38, -0.05, 0.25, 0.4), (0.05, 0.3, 0.4, 0.36)]):
        _parent(root, meshes.ball("bush", r * s, m, c, loc=(dx * s, dy * s, dz * s), nu=14, nv=8))
    return root


def rock(c, loc=(0, 0, 0), s=1.0, color=(0.45, 0.44, 0.46), seed=0):
    """A boulder about s metres across (a squashed, tilted ball with noise bump)."""
    r = _rng(seed)
    m = materials.noise_mat("rock", color, tuple(v * 0.7 for v in color), rough=0.95, scale=2.5, bump=0.8, sss=0.0, coat=0.0)
    o = meshes.ball("rock", 1.0, m, c, loc=(loc[0], loc[1], loc[2] + 0.3 * s),
                    scale=(s * float(r.uniform(0.5, 0.75)), s * float(r.uniform(0.4, 0.6)), s * float(r.uniform(0.3, 0.5))), nu=14, nv=8)
    o.rotation_euler = (float(r.uniform(-0.3, 0.3)), float(r.uniform(-0.3, 0.3)), float(r.uniform(0, 3)))
    return o


def mountain(c, loc=(0, 40, 0), r=18.0, h=22.0, color=(0.42, 0.4, 0.45), snow=True):
    """A cone mountain of base radius r and height h with an optional snow cap. Returns the parent empty."""
    root = meshes.empty(c, "mountain", loc=loc)
    m = materials.noise_mat("mtn", color, tuple(v * 0.75 for v in color), rough=0.95, scale=0.6, bump=0.5, sss=0.0, coat=0.0)
    _parent(root, meshes.lathe("mtn", [(0.001, 0), (r, 0), (r * 0.62, h * 0.38), (r * 0.3, h * 0.72), (0.001, h)], m, c, n=20, subsurf=1))
    if snow:
        _parent(root, meshes.lathe("snow", [(r * 0.33, h * 0.69), (r * 0.31, h * 0.73), (0.001, h * 1.01)], materials.col((0.96, 0.97, 1.0), 0.6), c, n=20, subsurf=1))
    return root


def cloud(c, loc=(0, 40, 30), s=6.0, color=(1, 1, 1)):
    """A puffy cloud about 3*s wide. Slightly emissive so it stays white in shade."""
    root = meshes.empty(c, "cloud", loc=loc)
    m = materials.col(color, 0.9, Emission_Color=(*color, 1), Emission_Strength=0.35)
    for k in range(4):
        _parent(root, meshes.ball("puff", 1.0, m, c, loc=(k * s * 0.7 - s, 0, (k % 2) * s * 0.25), scale=(s, s * 0.6, s * 0.5), nu=14, nv=8))
    return root


# ---------------------------------------------------------------- buildings and street furniture
def building(c, loc=(0, 0, 0), w=8.0, d=8.0, h=16.0, color=(0.93, 0.62, 0.45), windows=True):
    """Box building standing on loc (its base centre), front face towards -Y, with a grid of lit windows and a door."""
    root = meshes.empty(c, "building", loc=loc)
    _parent(root, meshes.box("bld", c, materials.col(color, 0.8), (0, 0, h / 2), (w / 2, d / 2, h / 2), 0.1))
    _parent(root, meshes.box("door", c, materials.col((0.25, 0.16, 0.1), 0.6), (0, -d / 2 - 0.02, 1.1), (0.55, 0.05, 1.05), 0.02))
    if windows:
        wv, wf = [], []
        nc, nr = max(1, int((w - 1.4) / 1.7)), max(0, int((h - 4.2) / 2.5))
        for a in range(nc):
            for r in range(nr):
                cx, cz, y = (a - (nc - 1) / 2) * 1.7, 4.6 + r * 2.5, -d / 2 - 0.03
                k = len(wv)
                wv += [(cx - 0.5, y, cz - 0.7), (cx + 0.5, y, cz - 0.7), (cx + 0.5, y, cz + 0.7), (cx - 0.5, y, cz + 0.7)]
                wf.append((k, k + 1, k + 2, k + 3))
        if wf:
            glass = materials.col((0.2, 0.45, 0.7), 0.08, Coat_Weight=1.0, Emission_Color=(0.4, 0.75, 1.0, 1), Emission_Strength=0.35)
            _parent(root, meshes.mk("windows", wv, wf, glass, c, smooth=False))
    return root


def house(c, loc=(0, 0, 0), w=6.0, d=5.0, h=3.2, color=(0.95, 0.88, 0.7), roof=(0.75, 0.25, 0.2)):
    """Small house with a pitched roof, door and two lit windows; front towards -Y."""
    root = meshes.empty(c, "house", loc=loc)
    _parent(root, meshes.box("walls", c, materials.col(color, 0.85), (0, 0, h / 2), (w / 2, d / 2, h / 2), 0.05))
    rv = [(-w / 2 - 0.3, -d / 2 - 0.3, h), (w / 2 + 0.3, -d / 2 - 0.3, h), (w / 2 + 0.3, d / 2 + 0.3, h), (-w / 2 - 0.3, d / 2 + 0.3, h),
          (-w / 2 - 0.3, 0, h + 0.45 * d), (w / 2 + 0.3, 0, h + 0.45 * d)]
    _parent(root, meshes.mk("roof", rv, [(0, 1, 5, 4), (2, 3, 4, 5), (0, 4, 3), (1, 2, 5), (0, 3, 2, 1)], materials.col(roof, 0.7), c, smooth=False))
    _parent(root, meshes.box("door", c, materials.col((0.35, 0.2, 0.12), 0.6), (0, -d / 2 - 0.02, 1.0), (0.5, 0.05, 1.0), 0.02))
    glass = materials.col((0.95, 0.85, 0.5), 0.2, Emission_Color=(1.0, 0.85, 0.5, 1), Emission_Strength=0.8)
    for sx in (-1, 1):
        _parent(root, meshes.box("win", c, glass, (sx * w * 0.3, -d / 2 - 0.02, h * 0.55), (0.5, 0.04, 0.5), 0.02))
    return root


def car(c, loc=(0, 0, 0), yaw=0.0, color=(0.85, 0.15, 0.12)):
    """Toy car 4.2 long, nose along +X before yaw, wheels on z = loc.z."""
    root = meshes.empty(c, "car", loc=loc)
    root.rotation_euler = (0, 0, yaw)
    body = materials.col(color, 0.2, Coat_Weight=0.8)
    glass = materials.col((0.1, 0.16, 0.22), 0.1)
    lamp = materials.emit("headlight", (1, 1, 1), 6.0)
    parts = [meshes.box("body", c, body, (0, 0, 0.62), (2.1, 0.9, 0.36), 0.14),
             meshes.box("cabin", c, glass, (-0.15, 0, 1.2), (1.05, 0.78, 0.3), 0.12),
             meshes.box("roof", c, body, (-0.15, 0, 1.5), (0.95, 0.74, 0.04), 0.03)]
    for sy in (-0.55, 0.55):
        parts.append(meshes.ball("hl", 1.0, lamp, c, loc=(2.1, sy, 0.68), scale=(0.05, 0.16, 0.1), nu=8, nv=6))
    tire = materials.col((0.03, 0.03, 0.035), 0.8)
    for sx in (-1.3, 1.3):
        for sy in (-0.88, 0.88):
            parts.append(meshes.ball("wheel", 1.0, tire, c, loc=(sx, sy, 0.37), scale=(0.37, 0.17, 0.37), nu=16, nv=8))
    return _parent(root, *parts)


def street_lamp(c, loc=(0, 0, 0), h=5.0):
    """Lamp post with a glowing bulb on an arm pointing -Y."""
    root = meshes.empty(c, "lamp", loc=loc)
    metal = materials.col((0.2, 0.22, 0.25), 0.4)
    _parent(root, meshes.box("post", c, metal, (0, 0, h / 2), (0.06, 0.06, h / 2), 0.02),
            meshes.box("arm", c, metal, (0, -0.5, h), (0.05, 0.5, 0.05), 0.02),
            meshes.ball("bulb", 0.18, materials.emit("bulb", (1.0, 0.95, 0.8), 8.0), c, loc=(0, -0.95, h - 0.07), nu=10, nv=6))
    return root


# ---------------------------------------------------------------- space
def _self_lit(m, glow):
    """Feed a material's own base colour into its emission, so the object shows in a dark scene without a light."""
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if b is None or "Emission Strength" not in b.inputs:
        return
    base = b.inputs["Base Color"]
    if base.links:
        nt.links.new(base.links[0].from_socket, b.inputs["Emission Color"])
    else:
        b.inputs["Emission Color"].default_value = base.default_value
    b.inputs["Emission Strength"].default_value = glow


def planet(c, loc=(0, 0, 0), r=5.0, kind="earth", ring=False, glow=0.0):
    """A planet or moon of radius r. kind: 'earth' (ocean, land, white clouds), 'moon' (grey, cratered noise), 'mars' (rust),
    'gas' (banded tan), 'ice' (pale blue), 'sun' (emissive, lights nothing by itself: add a point light), 'lava' (dark with glow).
    glow > 0 makes the surface shine by itself (a Moon in a night sky: glow=1.0), so it reads without a light aimed at it.
    Returns an empty; spin it with rotation_euler.z. The surface mesh is root["surface"]."""
    from .sets.common import earth_mat
    root = meshes.empty(c, "planet", loc=loc)
    if kind == "earth":
        m = earth_mat()
    elif kind == "sun":
        m = materials.emit("sunm", (1.0, 0.72, 0.2), 6.0)
    else:
        two = {"moon": ((0.62, 0.62, 0.64), (0.36, 0.36, 0.4), 3.0, 0.9), "mars": ((0.72, 0.36, 0.2), (0.45, 0.2, 0.12), 1.2, 0.5),
               "gas": ((0.85, 0.7, 0.5), (0.6, 0.42, 0.3), 0.5, 0.2), "ice": ((0.8, 0.92, 1.0), (0.5, 0.72, 0.95), 1.0, 0.3),
               "lava": ((0.1, 0.07, 0.07), (0.9, 0.25, 0.05), 1.4, 0.6)}.get(kind, ((0.6, 0.6, 0.6), (0.4, 0.4, 0.4), 1.0, 0.4))
        m = materials.noise_mat("planet_" + kind, two[0], two[1], rough=0.9, scale=two[2] / max(r, 0.01) * 5.0, bump=two[3], sss=0.0, coat=0.0)
    if glow and kind != "sun":
        _self_lit(m, glow)
    surface = meshes.ball("surface", r, m, c, nu=64, nv=32)
    _parent(root, surface)
    root["surface"] = surface.name
    if kind == "earth":
        rng = _rng(7)
        cm = materials.col((1, 1, 1), 0.9, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.5)
        for _ in range(22):
            a, la, s_ = float(rng.uniform(0, 2 * np.pi)), float(rng.uniform(-1.0, 1.0)), float(rng.uniform(0.1, 0.26)) * r
            cl = meshes.ball("pcloud", 1.0, cm, c, loc=(1.016 * r * math.cos(la) * math.cos(a), 1.016 * r * math.cos(la) * math.sin(a), 1.016 * r * math.sin(la)),
                             scale=(s_ * 0.8, s_ * 0.45, 0.01 * r), nu=10, nv=6)
            cl.rotation_euler = (0, math.pi / 2 - la, a)
            cl.parent = surface
    if ring:
        ringm = materials.col((0.8, 0.72, 0.55), 0.6)
        rv, rf, n = [], [], 64
        for k in range(n):
            a = 2 * math.pi * k / n
            rv += [(1.4 * r * math.cos(a), 1.4 * r * math.sin(a), 0), (2.1 * r * math.cos(a), 2.1 * r * math.sin(a), 0)]
            rf.append((2 * k, 2 * k + 1, (2 * k + 3) % (2 * n), (2 * k + 2) % (2 * n)))
        _parent(root, meshes.mk("ring", rv, rf, ringm, c))
    return root


def stars(c, center=(0, 0, 0), radius=180.0, n=500, size=(0.25, 0.9), seed=11):
    """Stars on a sphere shell around center: visible in every direction, unlike a card behind the set. One mesh, scenery."""
    r = _rng(seed)
    sv, sf = [], []
    for _ in range(n):
        v = r.normal(size=3)
        v /= np.linalg.norm(v)
        a = np.cross(v, (0.0, 0.0, 1.0) if abs(v[2]) < 0.9 else (1.0, 0.0, 0.0))
        a /= np.linalg.norm(a)
        b = np.cross(v, a)
        p, s = v * radius + np.array(center), float(r.uniform(*size))
        k = len(sv)
        sv += [tuple(p - a * s), tuple(p - b * s), tuple(p + a * s), tuple(p + b * s)]
        sf.append((k, k + 1, k + 2, k + 3))
    return stage.mark_scenery(meshes.mk("stars", sv, sf, materials.emit("starm", (1, 1, 1), 6.0), c, smooth=False))


# ---------------------------------------------------------------- explainer marks and effects
def arrow(c, length=2.0, color=(0.2, 0.85, 1.0), thick=0.12):
    """Glowing arrow along +X from its origin (shaft plus cone head). Rotate and scale the returned empty; scale.x stretches it."""
    root = meshes.empty(c, "arrow")
    m = materials.emit("arrow", color, 2.5)
    shaft = meshes.box("shaft", c, m, (length * 0.4, 0, 0), (length * 0.4, thick, thick), 0.02)
    head = meshes.lathe("head", [(0.001, 0), (thick * 3.2, 0), (0.001, length * 0.24)], m, c, n=16, subsurf=0)
    head.rotation_euler = (0, math.pi / 2, 0)
    head.location = (length * 0.78, 0, 0)
    return _parent(root, shaft, head)


def ring(c, r=1.0, thick=0.05, color=(1.0, 0.8, 0.1), strength=3.0):
    """Glowing flat ring of radius r in the XY plane (orbits, shock waves, highlights). Scale it to grow."""
    prof = [(r + thick * math.cos(a), thick * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 7)]
    return meshes.lathe("ring", prof, materials.emit("ringm", color, strength), c, n=72, subsurf=0)


def puffs(c, n=14, r=0.5, color=(0.85, 0.8, 0.72), seed=5):
    """n soft balls for dust, smoke, steam, snow or debris: a list, all at the origin at scale 0 (hidden). In the shot function
    place each one from t (position, scale growing then shrinking). Each has ["phase"] in 0..1 and ["dir"] (a unit vector) to spread them."""
    rr = _rng(seed)
    m = materials.col(color, 0.95)
    out = []
    for k in range(n):
        o = meshes.ball("puff", r, m, c, nu=12, nv=8)
        o.scale = (0, 0, 0)
        v = rr.normal(size=3)
        v /= np.linalg.norm(v)
        o["phase"] = float(k / max(n, 1))
        o["dir"] = [float(x) for x in v]
        out.append(o)
    return out


def streaks(c, n=24, length=3.0, color=(1, 1, 1), spread=6.0, seed=9):
    """n thin glowing streaks along +X (speed lines, wind, rain when rotated). A list; each has ["home"] (y, z offsets) and
    ["phase"] in 0..1. Slide them along X modulo a distance in the shot function to show speed."""
    rr = _rng(seed)
    m = materials.emit("streak", color, 2.0)
    out = []
    for k in range(n):
        o = meshes.box("streak", c, m, (0, 0, 0), (length * float(rr.uniform(0.4, 1.0)), 0.02, 0.02), 0)
        o["home"] = [float(rr.uniform(-spread, spread)), float(rr.uniform(-spread, spread))]
        o["phase"] = float(rr.uniform(0, 1))
        out.append(o)
    return out


def creature(c, kind="penguin", loc=(0, 0, 0), s=1.0):
    """A simple animal about s metres tall, facing -Y. kind: 'penguin', 'bird', 'fish', 'dog', 'cat', 'beetle'. Returns the root
    empty; root["head"] is the head object (nod or turn it), root["wings"] or root["legs"] a list of limbs where the animal has them."""
    root = meshes.empty(c, "creature", loc=loc)
    col = materials.col
    black, white, orange = col((0.03, 0.03, 0.04), 0.5), col((0.96, 0.96, 0.96), 0.6), col((1.0, 0.55, 0.1), 0.5)
    eye = col((0.01, 0.01, 0.01), 0.2)
    limbs = []
    if kind == "penguin":
        _parent(root, meshes.ball("body", 1.0, black, c, loc=(0, 0, 0.42 * s), scale=(0.27 * s, 0.25 * s, 0.42 * s), nu=20, nv=12),
                meshes.ball("belly", 1.0, white, c, loc=(0, -0.06 * s, 0.4 * s), scale=(0.21 * s, 0.21 * s, 0.34 * s), nu=20, nv=12))
        head = meshes.ball("head", 0.19 * s, black, c, loc=(0, 0, 0.86 * s), nu=18, nv=10)
        beak = meshes.lathe("beak", [(0.001, 0), (0.05 * s, 0), (0.001, 0.12 * s)], orange, c, n=10, subsurf=0)
        beak.rotation_euler = (math.pi / 2, 0, 0)
        beak.location = (0, -0.16 * s, 0)
        beak.parent = head
        for sx in (-1, 1):
            e = meshes.ball("eye", 0.03 * s, white, c, loc=(sx * 0.08 * s, -0.15 * s, 0.05 * s), nu=8, nv=6)
            e.parent = head
            w = meshes.ball("wing", 1.0, black, c, loc=(sx * 0.27 * s, 0, 0.48 * s), scale=(0.05 * s, 0.12 * s, 0.26 * s), nu=12, nv=8)
            f = meshes.ball("foot", 1.0, orange, c, loc=(sx * 0.11 * s, -0.08 * s, 0.03 * s), scale=(0.09 * s, 0.14 * s, 0.03 * s), nu=10, nv=6)
            _parent(root, w, f)
            limbs.append(w)
        _parent(root, head)
        root["wings"] = [w.name for w in limbs]
    elif kind in ("bird", "fish"):
        bodyc = col((0.95, 0.75, 0.15), 0.5) if kind == "bird" else col((1.0, 0.45, 0.1), 0.3, Coat_Weight=0.6)
        _parent(root, meshes.ball("body", 1.0, bodyc, c, loc=(0, 0, 0.5 * s), scale=(0.22 * s, 0.42 * s, 0.24 * s), nu=18, nv=10))
        head = meshes.ball("head", 0.17 * s, bodyc, c, loc=(0, -0.38 * s, 0.6 * s), nu=16, nv=10)
        for sx in (-1, 1):
            e = meshes.ball("eye", 0.035 * s, eye, c, loc=(sx * 0.1 * s, -0.11 * s, 0.04 * s), nu=8, nv=6)
            e.parent = head
            w = meshes.ball("wing", 1.0, bodyc, c, loc=(sx * 0.24 * s, 0.02 * s, 0.55 * s), scale=(0.3 * s, 0.16 * s, 0.03 * s), nu=12, nv=6)
            _parent(root, w)
            limbs.append(w)
        tail = meshes.ball("tail", 1.0, bodyc, c, loc=(0, 0.5 * s, 0.52 * s), scale=(0.03 * s if kind == "fish" else 0.14 * s, 0.2 * s, 0.2 * s if kind == "fish" else 0.03 * s), nu=10, nv=6)
        if kind == "bird":
            beak = meshes.lathe("beak", [(0.001, 0), (0.05 * s, 0), (0.001, 0.14 * s)], orange, c, n=10, subsurf=0)
            beak.rotation_euler = (math.pi / 2, 0, 0)
            beak.location = (0, -0.15 * s, 0)
            beak.parent = head
        _parent(root, head, tail)
        root["wings"] = [w.name for w in limbs]
    elif kind == "beetle":
        shell = col((0.1, 0.35, 0.2), 0.15, Coat_Weight=1.0)
        _parent(root, meshes.ball("body", 1.0, shell, c, loc=(0, 0, 0.3 * s), scale=(0.38 * s, 0.5 * s, 0.28 * s), nu=20, nv=10))
        head = meshes.ball("head", 0.2 * s, black, c, loc=(0, -0.52 * s, 0.24 * s), nu=14, nv=8)
        for sx in (-1, 1):
            for k in range(3):
                l = meshes.ball("leg", 1.0, black, c, loc=(sx * 0.42 * s, (k - 1) * 0.28 * s, 0.14 * s), scale=(0.22 * s, 0.03 * s, 0.03 * s), nu=8, nv=6)
                l.rotation_euler = (0, sx * 0.5, 0)
                _parent(root, l)
                limbs.append(l)
        _parent(root, head)
        root["legs"] = [l.name for l in limbs]
    else:  # dog or cat: four legs, a tail, ears
        fur = col((0.72, 0.5, 0.3), 0.8) if kind == "dog" else col((0.45, 0.45, 0.5), 0.8)
        _parent(root, meshes.ball("body", 1.0, fur, c, loc=(0, 0.05 * s, 0.5 * s), scale=(0.2 * s, 0.42 * s, 0.2 * s), nu=18, nv=10))
        head = meshes.ball("head", 0.2 * s, fur, c, loc=(0, -0.42 * s, 0.74 * s), nu=16, nv=10)
        snout = meshes.ball("snout", 1.0, fur, c, loc=(0, -0.17 * s, -0.04 * s), scale=(0.09 * s, 0.13 * s if kind == "dog" else 0.07 * s, 0.07 * s), nu=10, nv=6)
        snout.parent = head
        nose = meshes.ball("nose", 0.03 * s, black, c, loc=(0, -0.29 * s if kind == "dog" else -0.23 * s, -0.02 * s), nu=8, nv=6)
        nose.parent = head
        for sx in (-1, 1):
            e = meshes.ball("eye", 0.03 * s, eye, c, loc=(sx * 0.08 * s, -0.17 * s, 0.06 * s), nu=8, nv=6)
            e.parent = head
            ear = meshes.ball("ear", 1.0, fur, c, loc=(sx * 0.13 * s, 0.0, 0.17 * s), scale=(0.05 * s, 0.03 * s, 0.1 * s), nu=8, nv=6)
            ear.rotation_euler = (0, sx * (0.9 if kind == "dog" else 0.2), 0)
            ear.parent = head
            for sy in (-0.25, 0.3):
                l = meshes.ball("leg", 1.0, fur, c, loc=(sx * 0.12 * s, sy * s, 0.18 * s), scale=(0.055 * s, 0.055 * s, 0.2 * s), nu=10, nv=6)
                _parent(root, l)
                limbs.append(l)
        tail = meshes.ball("tail", 1.0, fur, c, loc=(0, 0.5 * s, 0.66 * s), scale=(0.03 * s, 0.05 * s, 0.2 * s), nu=8, nv=6)
        tail.rotation_euler = (-0.6, 0, 0)
        _parent(root, head, tail)
        root["legs"] = [l.name for l in limbs]
    root["head"] = head.name
    return root
