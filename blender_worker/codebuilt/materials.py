"""Materials (runs inside Blender 5.2; Principled BSDF input names are the 5.x ones)."""
import bpy


def _principled(mat):
    return next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def set_inputs(node, **kw):
    """Set node inputs by keyword; underscores become spaces (Coat_Weight -> 'Coat Weight').
    Unknown inputs are ignored so one recipe works across Blender versions."""
    for k, v in kw.items():
        key = k.replace("_", " ")
        if key in node.inputs:
            node.inputs[key].default_value = v


def pbr(name, color, rough=0.5, alpha=1.0, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = _principled(m)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    set_inputs(b, **kw)
    if alpha < 1:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            m.blend_method = 'BLEND'
        m.use_backface_culling = True
    return m


def emit(name, color, strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission')
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    e.inputs[0].default_value = (*color, 1)
    e.inputs[1].default_value = strength
    nt.links.new(e.outputs[0], o.inputs[0])
    return m


def backdrop_mat(name, center, edge):
    """Emissive radial gradient for a studio backdrop card."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    g = nt.nodes.new('ShaderNodeTexGradient')
    g.gradient_type = 'SPHERICAL'
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = (*edge, 1)
    ramp.color_ramp.elements[1].color = (*center, 1)
    ramp.color_ramp.elements[1].position = 0.75
    e = nt.nodes.new('ShaderNodeEmission')
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tc.outputs["Object"], g.inputs[0])
    nt.links.new(g.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], e.inputs[0])
    nt.links.new(e.outputs[0], o.inputs[0])
    return m


def noise_mat(name, c1, c2, rough=0.3, scale=7.0, bump=0.35, sss=0.25, coat=0.3):
    """Two-colour noise surface with bump: skin, flesh, rock (set sss=coat=0, rough high)."""
    m = pbr(name, c1, rough, Subsurface_Weight=sss, Subsurface_Radius=(1.0, 0.3, 0.2),
            Subsurface_Scale=0.08, Coat_Weight=coat, Coat_Roughness=0.15)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 5.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[0].color = (*c2, 1)
    ramp.color_ramp.elements[1].color = (*c1, 1)
    bp = nt.nodes.new('ShaderNodeBump')
    bp.inputs["Strength"].default_value = bump
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    nt.links.new(no.outputs[0], bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    return m


_cache = {}


def col(rgb, rough=0.6, **kw):
    """Cached plain colour material, so a crowd of figures shares a handful of materials."""
    k = (tuple(round(x, 3) for x in rgb), rough, tuple(sorted(kw.items())))
    if k not in _cache:
        _cache[k] = pbr("c%d" % len(_cache), rgb, rough, **kw)
    return _cache[k]


def reset_cache():
    _cache.clear()
