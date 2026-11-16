"""X1 (2026-11-16): procedural surfaces kit and stage render look tests; no Blender required.

Run from repo root:  python -m pytest blender_worker/codebuilt/test_materials.py
"""
import sys
import types
import pytest


class FakeSocket:
    def __init__(self, name=""):
        self.name = name
        self.default_value = None


class FakeElement:
    def __init__(self, pos=0.0, color=(1, 1, 1, 1)):
        self.position = pos
        self.color = color


class FakeColorRamp:
    def __init__(self):
        self.elements = [FakeElement(0.0, (0, 0, 0, 1)), FakeElement(1.0, (1, 1, 1, 1))]

    def new(self, pos):
        el = FakeElement(pos)
        self.elements.append(el)
        return el

    def remove(self, el):
        self.elements.remove(el)


class FakeNode:
    def __init__(self, ntype, name=""):
        self.type = ntype
        self.name = name
        self.inputs = {}
        self.outputs = {}
        for out in ("Color", "Normal", "Fac", "Distance", "Vector", "Height", "Object", "Generated", "UV", 0, 1, 2):
            self.outputs[out] = FakeSocket(str(out))
        for inp in ("Base Color", "Roughness", "Metallic", "IOR", "Alpha", "Normal",
                    "Subsurface Weight", "Subsurface Radius", "Subsurface Scale",
                    "Coat Weight", "Coat Roughness", "Sheen Weight", "Sheen Roughness",
                    "Transmission Weight", "Emission Color", "Emission Strength",
                    "Specular IOR Level", "Anisotropic", "Anisotropic Rotation",
                    "Vector", "Scale", "Detail", "Distortion", "Detail Roughness",
                    "Roughness", "Strength", "Distance", "Height", "Radius", "Samples",
                    "Color", "Fac", 0, 1):
            self.inputs[inp] = FakeSocket(str(inp))
        self.wave_type = 'BANDS'
        self.gradient_type = 'LINEAR'
        self.color_ramp = FakeColorRamp()


_TYPE_MAP = {
    'ShaderNodeTexWave': 'TEX_WAVE',
    'ShaderNodeTexNoise': 'TEX_NOISE',
    'ShaderNodeTexVoronoi': 'TEX_VORONOI',
    'ShaderNodeTexCoord': 'TEX_COORD',
    'ShaderNodeValToRGB': 'VALTORGB',
    'ShaderNodeBump': 'BUMP',
    'ShaderNodeBevel': 'BEVEL',
    'ShaderNodeTexGradient': 'TEX_GRADIENT',
    'ShaderNodeEmission': 'EMISSION',
    'ShaderNodeTexImage': 'TEX_IMAGE',
    'ShaderNodeBsdfPrincipled': 'BSDF_PRINCIPLED',
    'ShaderNodeOutputMaterial': 'OUTPUT_MATERIAL',
    'ShaderNodeBackground': 'BACKGROUND',
}


class FakeNodeList(list):
    def new(self, ntype):
        actual_type = _TYPE_MAP.get(ntype, ntype.replace('ShaderNode', '').upper())
        n = FakeNode(actual_type, ntype)
        self.append(n)
        return n


class FakeLinkList(list):
    def new(self, out_sock, in_sock):
        self.append((out_sock, in_sock))


class FakeNodeTree:
    def __init__(self):
        self.nodes = FakeNodeList([FakeNode('BSDF_PRINCIPLED', 'Principled BSDF'), FakeNode('OUTPUT_MATERIAL', 'Material Output')])
        self.links = FakeLinkList()


class FakeMaterial:
    def __init__(self, name):
        self.name = name
        self.use_nodes = True
        self.node_tree = FakeNodeTree()
        self.blend_method = 'OPAQUE'
        self.surface_render_method = 'DITHERED'
        self.use_backface_culling = False


class FakeBpyData:
    def __init__(self):
        self.materials = types.SimpleNamespace(new=lambda name: FakeMaterial(name))
        self.images = types.SimpleNamespace(load=lambda path: types.SimpleNamespace(filepath=path))
        def new_world(name):
            w = types.SimpleNamespace(use_nodes=True, node_tree=FakeNodeTree())
            w.node_tree.nodes.append(FakeNode('BACKGROUND', 'Background'))
            return w
        self.worlds = types.SimpleNamespace(new=new_world)
        self.lights = types.SimpleNamespace(new=lambda name, kind: types.SimpleNamespace(name=name, type=kind, energy=100.0, color=(1, 1, 1),
                                                                                        size=1.0, angle=0.05, use_contact_shadow=False,
                                                                                        contact_shadow_distance=0.2))
        self.objects = types.SimpleNamespace(new=lambda name, data=None: types.SimpleNamespace(name=name, data=data, location=(0, 0, 0),
                                                                                               modifiers=types.SimpleNamespace(new=lambda n, k: types.SimpleNamespace(name=n, type=k, width=0.02, segments=2))))


class FakeScene:
    def __init__(self):
        self.world = None
        self.render = types.SimpleNamespace(engine='BLENDER_EEVEE', resolution_x=1080, resolution_y=1920,
                                            resolution_percentage=100, image_settings=types.SimpleNamespace())
        self.eevee = types.SimpleNamespace()
        self.view_settings = types.SimpleNamespace(view_transform='Standard', look='None')


class FakeVector(tuple):
    def __new__(cls, val):
        return super().__new__(cls, tuple(val))

    def __sub__(self, other):
        return FakeVector(a - b for a, b in zip(self, other))

    def __add__(self, other):
        return FakeVector(a + b for a, b in zip(self, other))

    def to_track_quat(self, a, b):
        return (1, 0, 0, 0)


class FakeQuaternion(tuple):
    def __new__(cls, *args):
        return super().__new__(cls, (1, 0, 0, 0))

    def __matmul__(self, other):
        return self


@pytest.fixture
def fake_bpy(monkeypatch):
    bpy = types.ModuleType('bpy')
    bpy.data = FakeBpyData()
    bpy.context = types.SimpleNamespace(scene=FakeScene())
    monkeypatch.setitem(sys.modules, 'bpy', bpy)

    bmesh = types.ModuleType('bmesh')
    monkeypatch.setitem(sys.modules, 'bmesh', bmesh)

    mathutils = types.ModuleType('mathutils')
    mathutils.Vector = FakeVector
    mathutils.Quaternion = FakeQuaternion
    monkeypatch.setitem(sys.modules, 'mathutils', mathutils)

    # Patch modules if already loaded
    for mod_name in ('blender_worker.codebuilt.materials', 'blender_worker.codebuilt.stage', 'blender_worker.codebuilt.meshes'):
        if mod_name in sys.modules:
            monkeypatch.setattr(sys.modules[mod_name], 'bpy', bpy)
            if hasattr(sys.modules[mod_name], 'Vector'):
                monkeypatch.setattr(sys.modules[mod_name], 'Vector', FakeVector)
            if hasattr(sys.modules[mod_name], 'Quaternion'):
                monkeypatch.setattr(sys.modules[mod_name], 'Quaternion', FakeQuaternion)
    return bpy


def test_pbr_and_existing_helpers(fake_bpy):
    from blender_worker.codebuilt import materials
    materials.reset_cache()
    m = materials.pbr("test_pbr", (0.8, 0.2, 0.2), rough=0.4, alpha=0.9, Coat_Weight=0.5)
    assert m.name == "test_pbr"
    b = materials._principled(m)
    assert b.inputs["Base Color"].default_value == (0.8, 0.2, 0.2, 1)
    assert b.inputs["Roughness"].default_value == 0.4
    assert b.inputs["Coat Weight"].default_value == 0.5
    assert b.inputs["Alpha"].default_value == 0.9

    em = materials.emit("test_emit", (1, 1, 0), strength=2.5)
    assert em.name == "test_emit"

    c = materials.col((0.2, 0.4, 0.6), rough=0.7)
    assert c is materials.col((0.2, 0.4, 0.6), rough=0.7)  # cached


def test_twelve_procedural_surfaces_exist_and_configure_nodes(fake_bpy):
    from blender_worker.codebuilt import materials

    # 1. Wood
    w = materials.wood("wood_mat", color=(0.4, 0.25, 0.12), rough=0.6, bump=0.25, bevel=0.02)
    b_w = materials._principled(w)
    node_types_w = [n.type for n in w.node_tree.nodes]
    assert 'TEX_WAVE' in node_types_w
    assert 'VALTORGB' in node_types_w
    assert any(k in ('BUMP', 'BEVEL') for k in node_types_w)
    assert b_w.inputs["Roughness"].default_value == 0.6

    # 2. Brushed metal
    bm = materials.brushed_metal("brushed_mat", rough=0.3, bump=0.15, anisotropic=0.85, bevel=0.01)
    b_bm = materials._principled(bm)
    assert b_bm.inputs["Metallic"].default_value == 1.0
    assert b_bm.inputs["Anisotropic"].default_value == 0.85
    assert any(n.type == 'TEX_NOISE' for n in bm.node_tree.nodes)

    # 3. Painted metal (worn edges)
    pm = materials.painted_metal("painted_mat", paint_color=(0.1, 0.3, 0.8), wear=0.35, bump=0.2, bevel=0.015)
    b_pm = materials._principled(pm)
    node_types_pm = [n.type for n in pm.node_tree.nodes]
    assert 'TEX_NOISE' in node_types_pm
    assert node_types_pm.count('VALTORGB') >= 2  # color ramp and metallic ramp

    # 4. Concrete
    con = materials.concrete("concrete_mat", rough=0.9, bump=0.35, bevel=0.02)
    b_con = materials._principled(con)
    assert b_con.inputs["Roughness"].default_value == 0.9
    assert b_con.inputs["Metallic"].default_value == 0.0

    # 5. Rock
    r = materials.rock("rock_mat", rough=0.82, bump=0.65, strata=True, bevel=0.03)
    b_r = materials._principled(r)
    assert b_r.inputs["Roughness"].default_value == 0.82
    assert any(n.type == 'TEX_WAVE' for n in r.node_tree.nodes)

    # 6. Water
    wat = materials.water("water_mat", rough=0.04, bump=0.25)
    b_wat = materials._principled(wat)
    assert b_wat.inputs["Roughness"].default_value == 0.04
    assert b_wat.inputs["IOR"].default_value == 1.333

    # 7. Ice
    ice = materials.ice("ice_mat", rough=0.12, sss=0.4, bump=0.2)
    b_ice = materials._principled(ice)
    assert b_ice.inputs["Roughness"].default_value == 0.12
    assert b_ice.inputs["Subsurface Weight"].default_value == 0.4
    assert any(n.type == 'TEX_VORONOI' for n in ice.node_tree.nodes)

    # 8. Glass
    gl = materials.glass("glass_mat", rough=0.02, ior=1.45, alpha=0.3)
    b_gl = materials._principled(gl)
    assert b_gl.inputs["Transmission Weight"].default_value == 1.0
    assert b_gl.inputs["IOR"].default_value == 1.45

    # 9. Rubber
    rub = materials.rubber("rubber_mat", rough=0.78, bump=0.12, bevel=0.02)
    b_rub = materials._principled(rub)
    assert b_rub.inputs["Roughness"].default_value == 0.78
    assert b_rub.inputs["Metallic"].default_value == 0.0

    # 10. Fabric
    fab = materials.fabric("fabric_mat", rough=0.85, sheen=0.7, bump=0.15)
    b_fab = materials._principled(fab)
    assert b_fab.inputs["Roughness"].default_value == 0.85
    assert b_fab.inputs["Sheen Weight"].default_value == 0.7

    # 11. Soil
    soil = materials.soil("soil_mat", rough=0.94, bump=0.5, wetness=0.2)
    b_soil = materials._principled(soil)
    assert b_soil.inputs["Roughness"].default_value < 0.94  # wetness reduced roughness

    # 12. Grass
    gr = materials.grass("grass_mat", rough=0.72, bump=0.35, sss=0.18)
    b_gr = materials._principled(gr)
    assert b_gr.inputs["Roughness"].default_value == 0.72
    assert b_gr.inputs["Subsurface Weight"].default_value == 0.18


def test_earth_relief_material(fake_bpy):
    from blender_worker.codebuilt import materials
    er = materials.earth_relief("earth_test", bump=0.4, scale=1.0)
    assert er.name == "earth_test"
    node_types = [n.type for n in er.node_tree.nodes]
    assert 'VALTORGB' in node_types
    assert 'TEX_NOISE' in node_types
    assert any(n.type == 'BUMP' for n in er.node_tree.nodes)


def test_worn_edges_and_rounded_edges_modifiers(fake_bpy):
    from blender_worker.codebuilt import materials
    m = materials.pbr("base_for_mods", (0.2, 0.5, 0.8))
    materials.add_rounded_edges(m, radius=0.02)
    assert any(n.type == 'BEVEL' for n in m.node_tree.nodes)

    m2 = materials.pbr("base_for_wear", (0.8, 0.1, 0.1))
    materials.add_worn_edges(m2, wear=0.4)
    assert any(n.type == 'TEX_NOISE' for n in m2.node_tree.nodes)


def test_stage_agx_view_transform_and_contact_shadows(fake_bpy):
    from blender_worker.codebuilt import stage
    scene = FakeScene()
    stage.setup_render(scene, view_transform='AgX', look='Punchy')
    assert scene.view_settings.view_transform == 'AgX'
    assert scene.view_settings.look == 'Punchy'
    assert scene.eevee.use_shadows is True
    assert scene.eevee.use_gtao is True

    coll = types.SimpleNamespace(objects=types.SimpleNamespace(link=lambda o: None))
    a = stage.area(coll, "test_area", (0, 0, 5), (0, 0, 0), 1000, 2.0, contact_shadow=True, shadow_distance=0.25)
    assert a.data.use_contact_shadow is True
    assert a.data.contact_shadow_distance == 0.25

    s = stage.sun(coll, "test_sun", (10, 10, 10), (0, 0, 0), 2.5, contact_shadow=True, shadow_distance=0.3)
    assert s.data.use_contact_shadow is True
    assert s.data.contact_shadow_distance == 0.3

    obj = types.SimpleNamespace(modifiers=types.SimpleNamespace(new=lambda n, k: types.SimpleNamespace(name=n, type=k, width=0.02, segments=2)))
    stage.round_edges(obj, width=0.03, segments=3)


def test_maps_relief_palette_and_world_map_relief(fake_bpy):
    from blender_worker.codebuilt import maps
    cty = types.SimpleNamespace(iso="BRA", continent="South America")
    col_relief = maps.country_color(cty, "relief")
    assert len(col_relief) == 3
    assert 0.0 <= col_relief[0] <= 1.0
    assert 0.0 <= col_relief[1] <= 1.0
    assert 0.0 <= col_relief[2] <= 1.0

    cty_eur = types.SimpleNamespace(iso="FRA", continent="Europe")
    col_eur = maps.country_color(cty_eur, "relief")
    assert col_eur != col_relief
