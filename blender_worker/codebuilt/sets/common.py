"""Shared builder for the set modules (runs inside Blender; `offset` is pure)."""
import math

import numpy as np

REQUIRED_HANDLES = ("collection", "origin", "subject", "lights")


def offset(origin, p):
    """World position of local point p for a set centred on origin."""
    return (origin[0] + p[0], origin[1] + p[1], origin[2] + p[2])


class SetBuilder:
    """One set under construction: its collection, origin offset, seeded random numbers, lights.

    Set modules write local coordinates (centre at 0,0,0) and call p() to place them.
    The random generator is seeded per set, so two builds give identical scenery.
    """

    def __init__(self, name, origin=(0.0, 0.0, 0.0), seed=7):
        import bpy
        from .. import meshes
        self.name = name
        self.origin = tuple(float(v) for v in origin)
        if len(self.origin) != 3:
            raise ValueError("origin must be (x, y, z)")
        self.rng = np.random.default_rng(seed)
        self.c = meshes.coll(bpy.context.scene, name)
        self.lights = []

    def p(self, local):
        return offset(self.origin, local)

    def v(self, verts):
        """Local vertex array moved to world position (for mk)."""
        return np.asarray(verts, dtype=float).reshape(-1, 3) + np.array(self.origin)

    def area(self, name, pos, target, energy, size, color=(1, 1, 1)):
        from .. import stage
        o = stage.area(self.c, name, self.p(pos), self.p(target), energy, size, color)
        self.lights.append(o)
        return o

    def sun(self, name, pos, target, energy, color=(1, 1, 1), angle=3.0):
        from .. import stage
        o = stage.sun(self.c, name, self.p(pos), self.p(target), energy, color, angle)
        self.lights.append(o)
        return o

    def point(self, name, pos, energy, color=(1, 1, 1), radius=0.4):
        o = point_light(self.c, name, self.p(pos), energy, color, radius)
        self.lights.append(o)
        return o

    def backdrop(self, mat, pos, size):
        """Emissive card facing the camera (+Y side of the set)."""
        from .. import meshes
        return meshes.plane("bd_" + self.name, mat, self.c, loc=self.p(pos), size=size)

    def handles(self, subject, **extra):
        h = dict(collection=self.c, origin=self.origin, subject=self.p(subject), lights=list(self.lights))
        h.update(extra)
        return h


def point_light(c, name, pos, energy, color=(1, 1, 1), radius=0.4):
    import bpy
    l = bpy.data.lights.new(name, 'POINT')
    l.energy, l.color, l.shadow_soft_size = energy, color, radius
    o = bpy.data.objects.new(name, l)
    o.location = pos
    c.objects.link(o)
    return o


# ---------------------------------------------------------------- shared materials
def rockmat(name, c1, c2, scale=2.0, bump=0.7, rough=0.9):
    from .. import materials
    return materials.noise_mat(name, c1, c2, rough=rough, scale=scale, bump=bump, sss=0.0, coat=0.0)


def text_mats():
    """Readout text materials: yellow, red, white (emissive)."""
    from .. import materials
    return dict(
        y=materials.pbr("txt_y", (1.0, 0.8, 0.02), 0.35, Emission_Color=(1.0, 0.75, 0.0, 1), Emission_Strength=0.5),
        r=materials.pbr("txt_r", (0.95, 0.03, 0.03), 0.35, Emission_Color=(1.0, 0.0, 0.0, 1), Emission_Strength=0.6),
        w=materials.pbr("txt_w", (1, 1, 1), 0.35, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.5))


def xray_mat(name, color):
    """Transparent shell glowing at the rim (layer-weight facing)."""
    import bpy
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    lw = nt.nodes.new('ShaderNodeLayerWeight')
    lw.inputs[0].default_value = 0.25
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (0.035, 0.035, 0.035, 1)
    ramp.color_ramp.elements[1].position = 0.95
    ramp.color_ramp.elements[1].color = (0.8, 0.8, 0.8, 1)
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs[0].default_value = (*color, 1)
    e.inputs[1].default_value = 1.6
    mix = nt.nodes.new('ShaderNodeMixShader')
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(lw.outputs["Facing"], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(e.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], o.inputs[0])
    try:
        m.surface_render_method = 'BLENDED'
    except Exception:
        m.blend_method = 'BLEND'
    m.use_backface_culling = True
    return m


def tile_mat(name, c1, c2, scale):
    """Checker tiles (bathroom floor and wall)."""
    from .. import materials
    m = materials.pbr(name, c1, 0.25)
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    ch = nt.nodes.new('ShaderNodeTexChecker')
    ch.inputs["Color1"].default_value = (*c1, 1)
    ch.inputs["Color2"].default_value = (*c2, 1)
    ch.inputs["Scale"].default_value = scale
    nt.links.new(tc.outputs["Object"], ch.inputs["Vector"])
    nt.links.new(ch.outputs["Color"], b.inputs["Base Color"])
    return m


def earth_mat(sand=(0.6, 0.5, 0.28)):
    """Ocean, land and desert from one noise ramp, in object space."""
    from .. import materials
    m = materials.pbr("earthsurf", (0.05, 0.25, 0.6), 0.45)
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = 0.42
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    e = ramp.color_ramp.elements
    e[0].position, e[0].color = 0.48, (0.03, 0.2, 0.6, 1)
    e[1].position, e[1].color = 0.52, (0.12, 0.5, 0.14, 1)
    x = ramp.color_ramp.elements.new(0.62)
    x.color = (*sand, 1)
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    return m


def star_field(b, n, spread_x, spread_z, depth, size, mat):
    """Camera-facing diamonds scattered on a plane at +Y depth (one mesh)."""
    from .. import meshes
    sv, sf = [], []
    for _ in range(n):
        x, z, s = b.rng.uniform(-spread_x, spread_x), b.rng.uniform(-spread_z, spread_z), b.rng.uniform(*size)
        k = len(sv)
        sv += [(x - s, depth, z), (x, depth, z - s), (x + s, depth, z), (x, depth, z + s)]
        sf.append((k, k + 1, k + 2, k + 3))
    return meshes.mk("stars", b.v(sv), sf, mat, b.c, smooth=False)


def ring_profile(radius, thickness, n=7):
    """Small circle profile (radius, height) for a lathe torus."""
    return [(radius + thickness * math.cos(a), thickness * math.sin(a)) for a in np.linspace(0, 2 * np.pi, n)]
