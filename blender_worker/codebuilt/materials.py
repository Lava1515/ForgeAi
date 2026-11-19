"""Materials (runs inside Blender 5.2; Principled BSDF input names are the 5.x ones)."""
import os

import bpy


def _principled(mat):
    nt = mat.node_tree
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if not out:
        out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(b.outputs[0], out.inputs[0])
    return b


def set_inputs(node, **kw):
    """Set node inputs by keyword; underscores become spaces (Coat_Weight -> 'Coat Weight').
    Unknown inputs are ignored so one recipe works across Blender versions."""
    for k, v in kw.items():
        key = k.replace("_", " ")
        if key in node.inputs:
            node.inputs[key].default_value = v


def _attach_normal(nt, b, bump_height=None, bump_strength=0.2, bump_dist=0.1, bevel_radius=0.0):
    """Chain ShaderNodeBevel and/or ShaderNodeBump into Principled BSDF Normal input.
    If both bevel and bump are active, Bevel feeds Bump's Normal input, giving rounded edges WITH surface relief."""
    bv = None
    if bevel_radius and bevel_radius > 0:
        try:
            bv = nt.nodes.new('ShaderNodeBevel')
            bv.inputs["Radius"].default_value = bevel_radius
            if "Samples" in bv.inputs:
                bv.inputs["Samples"].default_value = 4
        except Exception:
            bv = None

    if bump_height is not None and bump_strength > 0:
        bp = nt.nodes.new('ShaderNodeBump')
        bp.inputs["Strength"].default_value = bump_strength
        if "Distance" in bp.inputs:
            bp.inputs["Distance"].default_value = bump_dist
        nt.links.new(bump_height, bp.inputs["Height"])
        if bv is not None:
            nt.links.new(bv.outputs["Normal"], bp.inputs["Normal"])
        nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
        return bp
    elif bv is not None:
        nt.links.new(bv.outputs["Normal"], b.inputs["Normal"])
        return bv
    return None


def add_rounded_edges(mat, radius=0.015, samples=4):
    """Attach a ShaderNodeBevel to any material for procedural rounded contact edges."""
    nt = mat.node_tree
    b = _principled(mat)
    try:
        bv = nt.nodes.new('ShaderNodeBevel')
        bv.inputs["Radius"].default_value = radius
        if "Samples" in bv.inputs:
            bv.inputs["Samples"].default_value = samples
        bp = next((n for n in nt.nodes if n.type == 'BUMP'), None)
        if bp is not None:
            nt.links.new(bv.outputs["Normal"], bp.inputs["Normal"])
        else:
            nt.links.new(bv.outputs["Normal"], b.inputs["Normal"])
        return bv
    except Exception as ex:
        print("add_rounded_edges skipped:", ex)
        return None


def add_worn_edges(mat, wear=0.3, metal_color=(0.7, 0.72, 0.75), scale=8.0):
    """Add a procedural worn-edge noise mask exposing bare metal underneath."""
    nt = mat.node_tree
    b = _principled(mat)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 5.0
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])

    wear = max(0.0, min(1.0, wear))
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    edge = nt.nodes.new('ShaderNodeMapRange')
    edge.clamp = True
    edge.inputs['From Min'].default_value = 0.5
    edge.inputs['From Max'].default_value = 0.58
    edge.inputs['To Max'].default_value = wear
    nt.links.new(geo.outputs['Pointiness'], edge.inputs['Value'])
    mask = nt.nodes.new('ShaderNodeMath'); mask.operation = 'MULTIPLY'
    nt.links.new(edge.outputs['Result'], mask.inputs[0])
    nt.links.new(no.outputs[0], mask.inputs[1])
    t = 0.12
    ramp_col = nt.nodes.new('ShaderNodeValToRGB')
    orig_col = list(b.inputs["Base Color"].default_value)[:3]
    ramp_col.color_ramp.elements[0].position = max(0.0, t - 0.05)
    ramp_col.color_ramp.elements[0].color = (*orig_col, 1)
    ramp_col.color_ramp.elements[1].position = min(1.0, t + 0.05)
    ramp_col.color_ramp.elements[1].color = (*metal_color, 1)

    ramp_met = nt.nodes.new('ShaderNodeValToRGB')
    ramp_met.color_ramp.elements[0].position = max(0.0, t - 0.05)
    ramp_met.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp_met.color_ramp.elements[1].position = min(1.0, t + 0.05)
    ramp_met.color_ramp.elements[1].color = (1, 1, 1, 1)

    nt.links.new(mask.outputs[0], ramp_col.inputs[0])
    nt.links.new(ramp_col.outputs[0], b.inputs["Base Color"])
    nt.links.new(mask.outputs[0], ramp_met.inputs[0])
    nt.links.new(ramp_met.outputs[0], b.inputs["Metallic"])
    return mat


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


# ---------------------------------------------------------------- X1 Procedural Surface Kit

def wood(name, color=(0.42, 0.26, 0.13), color_dark=(0.25, 0.14, 0.07), rough=0.55,
         scale=4.0, bump=0.2, rings=8.0, bevel=0.015):
    """Procedural natural wood with directional grain lines, annular growth rings, and bump."""
    m = pbr(name, color, rough=rough)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    wv = nt.nodes.new('ShaderNodeTexWave')
    wv.wave_type = 'BANDS'
    wv.inputs["Scale"].default_value = scale
    wv.inputs["Distortion"].default_value = 4.0
    if "Detail" in wv.inputs:
        wv.inputs["Detail"].default_value = 3.0
    if "Detail Roughness" in wv.inputs:
        wv.inputs["Detail Roughness"].default_value = 0.6
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (*color_dark, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"])
    nt.links.new(wv.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=wv.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def brushed_metal(name, color=(0.75, 0.76, 0.78), rough=0.35, scale=40.0,
                  bump=0.15, anisotropic=0.8, bevel=0.01):
    """Procedural brushed metal with fine micro-scratches, anisotropic highlight, and rounded bevel."""
    m = pbr(name, color, rough=rough, Metallic=1.0)
    nt = m.node_tree
    b = _principled(m)
    set_inputs(b, Anisotropic=anisotropic, Anisotropic_Rotation=0.25)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.7
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bump_dist=0.02, bevel_radius=bevel)
    return m


def painted_metal(name, paint_color=(0.15, 0.35, 0.7), metal_color=(0.7, 0.72, 0.75),
                  rough=0.4, wear=0.3, scale=8.0, bump=0.2, bevel=0.015):
    """Painted metal with procedural edge-wear and chips exposing bare metal underneath."""
    m = pbr(name, paint_color, rough=rough)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 5.0
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])

    wear = max(0.0, min(1.0, wear))
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    edge = nt.nodes.new('ShaderNodeMapRange')
    edge.clamp = True
    edge.inputs['From Min'].default_value = 0.5
    edge.inputs['From Max'].default_value = 0.58
    edge.inputs['To Max'].default_value = wear
    nt.links.new(geo.outputs['Pointiness'], edge.inputs['Value'])
    mask = nt.nodes.new('ShaderNodeMath'); mask.operation = 'MULTIPLY'
    nt.links.new(edge.outputs['Result'], mask.inputs[0])
    nt.links.new(no.outputs[0], mask.inputs[1])
    t = 0.12
    ramp_col = nt.nodes.new('ShaderNodeValToRGB')
    ramp_col.color_ramp.elements[0].position = max(0.0, t - 0.04)
    ramp_col.color_ramp.elements[0].color = (*paint_color, 1)
    ramp_col.color_ramp.elements[1].position = min(1.0, t + 0.04)
    ramp_col.color_ramp.elements[1].color = (*metal_color, 1)

    ramp_met = nt.nodes.new('ShaderNodeValToRGB')
    ramp_met.color_ramp.elements[0].position = max(0.0, t - 0.04)
    ramp_met.color_ramp.elements[0].color = (0, 0, 0, 1)
    ramp_met.color_ramp.elements[1].position = min(1.0, t + 0.04)
    ramp_met.color_ramp.elements[1].color = (1, 1, 1, 1)

    ramp_rough = nt.nodes.new('ShaderNodeValToRGB')
    ramp_rough.color_ramp.elements[0].position = max(0.0, t - 0.04)
    ramp_rough.color_ramp.elements[0].color = (rough, rough, rough, 1)
    ramp_rough.color_ramp.elements[1].position = min(1.0, t + 0.04)
    ramp_rough.color_ramp.elements[1].color = (0.22, 0.22, 0.22, 1)

    nt.links.new(mask.outputs[0], ramp_col.inputs[0])
    nt.links.new(ramp_col.outputs[0], b.inputs["Base Color"])
    nt.links.new(mask.outputs[0], ramp_met.inputs[0])
    nt.links.new(ramp_met.outputs[0], b.inputs["Metallic"])
    nt.links.new(mask.outputs[0], ramp_rough.inputs[0])
    nt.links.new(ramp_rough.outputs[0], b.inputs["Roughness"])

    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def concrete(name, color=(0.52, 0.51, 0.50), color_dark=(0.35, 0.34, 0.33),
             rough=0.88, scale=12.0, bump=0.3, bevel=0.02):
    """Weathered concrete with pore noise, aggregate variation, and matte surface relief."""
    m = pbr(name, color, rough=rough, Metallic=0.0)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.7
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (*color_dark, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def rock(name, color=(0.40, 0.38, 0.36), color_dark=(0.22, 0.20, 0.19),
         rough=0.8, scale=5.0, bump=0.6, strata=True, bevel=0.025):
    """Natural stratified rock with layered fissures, fracture relief, and weathered minerals."""
    m = pbr(name, color, rough=rough, Metallic=0.0)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale * 2.5
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.65
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])

    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (*color_dark, 1)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (*color, 1)

    if strata:
        wv = nt.nodes.new('ShaderNodeTexWave')
        wv.inputs["Scale"].default_value = scale * 1.2
        wv.inputs["Distortion"].default_value = 3.0
        nt.links.new(tc.outputs["Object"], wv.inputs["Vector"])
        nt.links.new(wv.outputs[0], ramp.inputs[0])
    else:
        nt.links.new(no.outputs[0], ramp.inputs[0])

    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def water(name, color=(0.04, 0.28, 0.45), rough=0.05, depth_color=(0.01, 0.12, 0.25),
          scale=6.0, bump=0.25, transparent=False):
    """Procedural water surface with generative wave ripples and glassy specular reflections."""
    m = pbr(name, color, rough=rough)
    nt = m.node_tree
    b = _principled(m)
    set_inputs(b, IOR=1.333, Specular_IOR_Level=0.5)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 3.0
    if "Distortion" in no.inputs:
        no.inputs["Distortion"].default_value = 2.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (*depth_color, 1)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])

    if transparent:
        set_inputs(b, Transmission_Weight=1.0)
        b.inputs["Alpha"].default_value = 0.85
        try:
            m.surface_render_method = 'BLENDED'
        except Exception:
            m.blend_method = 'BLEND'
    else:
        set_inputs(b, Coat_Weight=0.8, Coat_Roughness=0.03)

    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump)
    return m


def ice(name, color=(0.78, 0.88, 0.95), rough=0.15, sss=0.35, scale=8.0, bump=0.2, bevel=0.01):
    """Glacial ice with subsurface scattering, surface frost roughness, and fracture lines."""
    m = pbr(name, color, rough=rough, Subsurface_Weight=sss, Subsurface_Radius=(0.4, 0.7, 1.0),
            Subsurface_Scale=0.06, IOR=1.31)
    nt = m.node_tree
    b = _principled(m)
    set_inputs(b, Transmission_Weight=0.5, Coat_Weight=0.6, Coat_Roughness=0.05)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    vo = nt.nodes.new('ShaderNodeTexVoronoi')
    vo.inputs["Scale"].default_value = scale
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (*color, 1)
    ramp.color_ramp.elements[1].position = 0.85
    ramp.color_ramp.elements[1].color = (0.92, 0.96, 1.0, 1)
    nt.links.new(tc.outputs["Object"], vo.inputs["Vector"])
    nt.links.new(vo.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=vo.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def glass(name, color=(0.95, 0.97, 1.0), rough=0.02, ior=1.45, alpha=1.0, bevel=0.01):
    """Architectural and prop glass with physical transmission, IOR 1.45, and edge bevel."""
    m = pbr(name, color, rough=rough, alpha=alpha, Transmission_Weight=1.0, IOR=ior, Specular_IOR_Level=0.5)
    nt = m.node_tree
    b = _principled(m)
    _attach_normal(nt, b, bevel_radius=bevel)
    return m


def rubber(name, color=(0.08, 0.08, 0.09), rough=0.75, scale=20.0, bump=0.1, bevel=0.02):
    """Industrial rubber: deep matte finish with micro-pore texture and rounded contact edges."""
    m = pbr(name, color, rough=rough, Metallic=0.0)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 4.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.6
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def fabric(name, color=(0.35, 0.22, 0.18), color_weave=(0.28, 0.17, 0.14),
           rough=0.82, sheen=0.6, scale=40.0, bump=0.15):
    """Woven fabric with micro-thread weave pattern, grazing angle sheen, and soft relief."""
    m = pbr(name, color, rough=rough, Metallic=0.0)
    nt = m.node_tree
    b = _principled(m)
    set_inputs(b, Sheen_Weight=sheen, Sheen_Roughness=0.5)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    wv = nt.nodes.new('ShaderNodeTexWave')
    wv.inputs["Scale"].default_value = scale
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = (*color_weave, 1)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"])
    nt.links.new(wv.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=wv.outputs[0], bump_strength=bump)
    return m


def soil(name, color=(0.28, 0.20, 0.13), color_dark=(0.16, 0.11, 0.07),
         rough=0.92, scale=14.0, bump=0.45, wetness=0.0, bevel=0.02):
    """Granular soil/earth with clod textures, organic dark loam variation, and moisture sheen."""
    effective_rough = rough * (1.0 - wetness) + 0.35 * wetness
    m = pbr(name, color, rough=effective_rough, Metallic=0.0)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.8
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.25
    ramp.color_ramp.elements[0].color = (*color_dark, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump, bevel_radius=bevel)
    return m


def grass(name, color=(0.22, 0.45, 0.16), color_dark=(0.14, 0.32, 0.09),
          rough=0.75, scale=16.0, bump=0.35, sss=0.15):
    """Turf and lawn with blade striations, thatch undertone gradient, and foliage translucency."""
    m = pbr(name, color, rough=rough, Subsurface_Weight=sss, Subsurface_Radius=(0.2, 0.8, 0.2),
            Subsurface_Scale=0.04)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 4.0
    wv = nt.nodes.new('ShaderNodeTexWave')
    wv.inputs["Scale"].default_value = scale * 2.0
    wv.inputs["Distortion"].default_value = 4.0
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (*color_dark, 1)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (*color, 1)
    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=wv.outputs[0], bump_strength=bump)
    return m


def earth_relief(name="earth_relief", image_path=None, color=None):
    """Real pre-shaded Natural Earth colour raster; requires geographic UVs.

    This is cartographic hillshading, NOT an elevation grid: no colour-as-height bump.
    Rich colour grade (saturation 1.5, value 0.8), roughness 0.55 and emission 0.06 match the Sonnet short.
    Optional country tint multiplies the relief so bright fills keep geographic detail.
    Missing/corrupt assets raise; no fictional terrain fallback.
    """
    import os
    image_path = image_path or os.path.join(os.path.dirname(__file__), "mapdata", "ne2_50m_sr_w_4096.jpg")
    img = bpy.data.images.load(image_path, check_existing=True)
    m = pbr(name, color or (1, 1, 1), rough=0.55)
    nt, b = m.node_tree, _principled(m)
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image, tex.extension = img, 'EXTEND'
    tc = nt.nodes.new('ShaderNodeTexCoord')
    nt.links.new(tc.outputs['UV'], tex.inputs['Vector'])
    # codex · gpt-6.1-sol · 2026-11-19 20:04 +02:00: match the Sonnet Earth grade.
    hs = nt.nodes.new('ShaderNodeHueSaturation')
    hs.inputs['Saturation'].default_value = 1.5
    hs.inputs['Value'].default_value = 0.8
    nt.links.new(tex.outputs['Color'], hs.inputs['Color'])
    out = hs.outputs['Color']
    if color is not None:
        # Luminance of real hillshading modulates the fill, preserving its hue.
        gray = nt.nodes.new('ShaderNodeRGBToBW')
        nt.links.new(out, gray.inputs[0])
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (0.18, 0.18, 0.18, 1)
        ramp.color_ramp.elements[1].color = (1, 1, 1, 1)
        nt.links.new(gray.outputs[0], ramp.inputs[0])
        mix = nt.nodes.new('ShaderNodeMixRGB')
        mix.blend_type = 'MULTIPLY'
        mix.inputs[0].default_value = 1
        # Base Color stays editable by WorldMap.set_color/highlight.
        rgb = nt.nodes.new('ShaderNodeRGB'); rgb.name = 'country_tint'
        rgb.outputs[0].default_value = (*color, 1)
        nt.links.new(rgb.outputs[0], mix.inputs[1])
        nt.links.new(ramp.outputs[0], mix.inputs[2])
        out = mix.outputs[0]
    nt.links.new(out, b.inputs['Base Color'])
    nt.links.new(out, b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = 0.06
    return no_light(m)


# ---------------------------------------------------------------- F5 map look (dark sea, strong relief, bright fills)
# Same registered Natural Earth II raster as earth_relief; only the grading differs. Values are tuned on Cycles CPU, Standard view.
EARTH_RASTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mapdata", "ne2_50m_sr_w_4096.jpg")
MAP_SEA = (0.010, 0.032, 0.070)          # deep water: dark blue-black
MAP_SHELF = (0.030, 0.100, 0.170)        # shallow water and the raster's undersea relief
MAP_BORDER = (0.82, 0.84, 0.80)          # thin pale border lines between unhighlighted countries
_RASTER_TEXEL = (1.0 / 4096, 1.0 / 2048)


def no_light(m):
    """Keep a self-lit surface (map, label, outline) out of Cycles' light sampling: it still shows its colour but is not treated as a
    lamp, which saves render time and noise. Returns the material."""
    try:
        m.cycles.emission_sampling = 'NONE'
    except Exception as ex:  # older Blender
        print("emission_sampling skipped:", ex)
    return m


def _image(nt, path, uv_socket, offset=None, name=None):
    """Image texture node of the raster, sampled at uv (+ offset in UV units)."""
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(path, check_existing=True)
    tex.extension = 'EXTEND'
    tex.interpolation = 'Linear'
    if name:
        tex.name = name
    if offset is None:
        nt.links.new(uv_socket, tex.inputs['Vector'])
    else:
        add = nt.nodes.new('ShaderNodeVectorMath')
        add.operation = 'ADD'
        add.inputs[1].default_value = (offset[0], offset[1], 0.0)
        nt.links.new(uv_socket, add.inputs[0])
        nt.links.new(add.outputs[0], tex.inputs['Vector'])
    return tex


def _math(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = float(v)
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _relief_shade(nt, uv, image_path, relief, radius=3.0):
    """Hillshade boost: 1 + relief * (lum - local mean of lum), the local mean from two raster samples `radius` texels away
    on the diagonal.
    A local-contrast filter on the real pre-shaded raster: mountain ranges stand out, flat plains stay flat. No invented terrain.
    Returns (colour socket of the centre sample, luminance socket, shade factor socket)."""
    c = _image(nt, image_path, uv, name="relief_center")
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(c.outputs['Color'], bw.inputs[0])
    lum = bw.outputs[0]
    acc = None
    du, dv = _RASTER_TEXEL[0] * radius, _RASTER_TEXEL[1] * radius
    for off in ((du, dv), (-du, -dv)):     # two diagonal taps: enough for a local mean, half the texture reads of four
        t = _image(nt, image_path, uv, offset=off)
        b = nt.nodes.new('ShaderNodeRGBToBW')
        nt.links.new(t.outputs['Color'], b.inputs[0])
        acc = b.outputs[0] if acc is None else _math(nt, 'ADD', acc, b.outputs[0])
    mean = _math(nt, 'MULTIPLY', acc, 0.5)
    high = _math(nt, 'SUBTRACT', lum, mean)
    shade = _math(nt, 'MULTIPLY_ADD', high, float(relief))
    # MULTIPLY_ADD = a * b + c; c = 1
    shade.node.inputs[2].default_value = 1.0
    shade = _math(nt, 'MINIMUM', _math(nt, 'MAXIMUM', shade, 0.35), 1.45)   # no black pits, no white ridges
    return c.outputs['Color'], lum, shade


def map_land(name, color=None, image_path=None, relief=4.5, saturation=1.5, value=0.8, glow=0.2):
    """Land top face for the flat map: the registered Natural Earth II raster graded to a restrained natural tone, with the real
    hillshading strengthened by a local-contrast filter (`relief`, 0 = raster as is). Needs geographic UVs (as earth_relief).

    A fill colour is built in: node 'country_tint' (RGB) holds it and node 'hl_mix' (Value, 0..1) blends from the natural land
    (0) to the fill (1), keeping the hillshading in the fill. With `color` given the material starts filled (hl_mix 1).
    The base colour is also fed to the emission at `glow` strength (Principled Emission Strength), so a pre-shaded map reads
    the same in any light. Missing raster raises."""
    image_path = image_path or EARTH_RASTER
    if not os.path.exists(image_path):
        raise RuntimeError(f"Natural Earth raster missing: {image_path}")
    m = pbr(name, color or (1, 1, 1), rough=0.9)
    nt, b = m.node_tree, _principled(m)
    uv = nt.nodes.new('ShaderNodeTexCoord').outputs['UV']
    col, lum, shade = _relief_shade(nt, uv, image_path, relief)
    hs = nt.nodes.new('ShaderNodeHueSaturation')
    hs.inputs['Saturation'].default_value = saturation
    hs.inputs['Value'].default_value = value
    nt.links.new(col, hs.inputs['Color'])
    # codex · gpt-6.1-sol · 2026-11-19 20:17 +02:00: restore the runtime RGBA Mix API.
    natural = nt.nodes.new('ShaderNodeMix')
    natural.data_type = 'RGBA'
    natural.blend_type = 'MULTIPLY'
    natural.inputs['Factor'].default_value = 1.0
    nt.links.new(hs.outputs['Color'], natural.inputs['A'])
    nt.links.new(shade, natural.inputs['B'])
    # Fill hue stays editable; a wider hillshade range keeps terrain under full fills.
    # codex · gpt-6.1-sol · 2026-11-19 20:04 +02:00
    rgb = nt.nodes.new('ShaderNodeRGB')
    rgb.name = 'country_tint'
    rgb.outputs[0].default_value = (*(color or (1.0, 0.45, 0.05)), 1)
    lit = nt.nodes.new('ShaderNodeMapRange')
    lit.inputs['From Min'].default_value, lit.inputs['From Max'].default_value = 0.35, 0.95
    lit.inputs['To Min'].default_value, lit.inputs['To Max'].default_value = 0.32, 1.05
    nt.links.new(lum, lit.inputs['Value'])
    k = _math(nt, 'MULTIPLY', lit.outputs['Result'], shade)
    fill = nt.nodes.new('ShaderNodeMix')
    fill.data_type = 'RGBA'
    fill.blend_type = 'MULTIPLY'
    fill.inputs['Factor'].default_value = 1.0
    nt.links.new(rgb.outputs[0], fill.inputs['A'])
    nt.links.new(k, fill.inputs['B'])
    mixv = nt.nodes.new('ShaderNodeValue')
    mixv.name = 'hl_mix'
    mixv.outputs[0].default_value = 1.0 if color is not None else 0.0
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    nt.links.new(mixv.outputs[0], mix.inputs['Factor'])
    nt.links.new(natural.outputs['Result'], mix.inputs['A'])
    nt.links.new(fill.outputs['Result'], mix.inputs['B'])
    nt.links.new(mix.outputs['Result'], b.inputs['Base Color'])
    nt.links.new(mix.outputs['Result'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = glow
    return no_light(m)


def map_sea(name, color=MAP_SEA, shelf=MAP_SHELF, image_path=None, geographic=True, glow=1.0):
    """Sea plate: dark blue-black water. With geographic=True (equirectangular UVs, as map_land) the raster's own undersea relief
    and shelves are kept as a faint lighter texture (shelf colour); land, ice and anything outside the raster fall back to `color`.
    geographic=False is plain `color` with a soft noise. Mostly emissive so the sea stays dark blue rather than black in any light."""
    # Nearly all of the sea's colour is emission: lights and their highlights would turn it grey.
    m = pbr(name, color, rough=0.9, Specular_IOR_Level=0.05)
    nt, b = m.node_tree, _principled(m)
    b.inputs['Base Color'].default_value = (*[v * 0.2 for v in color], 1)
    if not geographic:
        no = nt.nodes.new('ShaderNodeTexNoise')
        no.inputs['Scale'].default_value = 0.35
        nt.links.new(nt.nodes.new('ShaderNodeTexCoord').outputs['Object'], no.inputs['Vector'])
        ramp = nt.nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (*[v * 0.8 for v in color], 1)
        ramp.color_ramp.elements[1].color = (*[min(1.0, v * 1.3) for v in color], 1)
        nt.links.new(no.outputs[0], ramp.inputs[0])
        nt.links.new(ramp.outputs[0], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = glow
        return no_light(m)
    image_path = image_path or EARTH_RASTER
    if not os.path.exists(image_path):
        raise RuntimeError(f"Natural Earth raster missing: {image_path}")
    uv = nt.nodes.new('ShaderNodeTexCoord').outputs['UV']
    c = _image(nt, image_path, uv, name="sea_center")        # one sample: the sea needs no relief boost
    col = c.outputs['Color']
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(col, bw.inputs[0])
    lum = bw.outputs[0]
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(col, sep.inputs[0])
    # water mask: the raster's sea is clearly bluer than red; land, ice and the clamped border are not
    bmr = _math(nt, 'SUBTRACT', sep.outputs[2], sep.outputs[0])
    water = _math(nt, 'MULTIPLY', _math(nt, 'SUBTRACT', bmr, 0.16), 10.0, clamp=True)
    # inside the raster only (u, v in 0..1)
    sx = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(uv, sx.inputs[0])
    inside = None
    for comp in (sx.outputs[0], sx.outputs[1]):
        lo = _math(nt, 'GREATER_THAN', comp, 0.0)
        hi = _math(nt, 'LESS_THAN', comp, 1.0)
        both = _math(nt, 'MULTIPLY', lo, hi)
        inside = both if inside is None else _math(nt, 'MULTIPLY', inside, both)
    depth = nt.nodes.new('ShaderNodeMapRange')       # deep water ~0.50 luminance in the raster, shelves ~0.62
    depth.inputs['From Min'].default_value, depth.inputs['From Max'].default_value = 0.50, 0.66
    nt.links.new(lum, depth.inputs['Value'])
    t = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', depth.outputs['Result'], water), inside)
    ramp = nt.nodes.new('ShaderNodeMix')
    ramp.data_type = 'RGBA'
    ramp.inputs['A'].default_value = (*color, 1)
    ramp.inputs['B'].default_value = (*shelf, 1)
    nt.links.new(t, ramp.inputs['Factor'])
    nt.links.new(ramp.outputs['Result'], b.inputs['Base Color'])
    nt.links.new(ramp.outputs['Result'], b.inputs['Emission Color'])
    b.inputs['Emission Strength'].default_value = glow
    return no_light(m)


def map_outline(name, color=MAP_BORDER, strength=0.8):
    """Emissive line colour for country borders and highlight outlines (strength 0 = plain dark line)."""
    return no_light(emit(name, color, strength))


def map_glow(name, color, strength=2.0):
    """Additive soft glow for a ribbon whose UV v runs 0 (at the outline) to 1 (outer edge): emission fading with (1 - v)^2
    added to a fully transparent surface. Node 'glow_strength' (Emission) carries the strength, so it can be animated."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    uv = nt.nodes.new('ShaderNodeTexCoord').outputs['UV']
    sx = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(uv, sx.inputs[0])
    fall = _math(nt, 'POWER', _math(nt, 'SUBTRACT', 1.0, sx.outputs[1], clamp=True), 2.0)
    e = nt.nodes.new('ShaderNodeEmission')
    e.name = 'glow_strength'
    e.inputs[0].default_value = (*color, 1)
    e.inputs[1].default_value = strength
    # scale emission by the falloff through a Mix Shader with a black (zero) emission
    zero = nt.nodes.new('ShaderNodeEmission')
    zero.inputs[1].default_value = 0.0
    mixs = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(fall, mixs.inputs[0])
    nt.links.new(zero.outputs[0], mixs.inputs[1])
    nt.links.new(e.outputs[0], mixs.inputs[2])
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    add = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(mixs.outputs[0], add.inputs[0])
    nt.links.new(tr.outputs[0], add.inputs[1])
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(add.outputs[0], o.inputs[0])
    try:
        m.surface_render_method = 'BLENDED'
    except Exception:
        pass
    return no_light(m)


_cache = {}


def col(rgb, rough=0.6, **kw):
    """Cached plain colour material for background crowds, distant props, or diagram elements."""
    k = (tuple(round(x, 3) for x in rgb), rough, tuple(sorted(kw.items())))
    if k not in _cache:
        _cache[k] = pbr("c%d" % len(_cache), rgb, rough, **kw)
    return _cache[k]


def reset_cache():
    _cache.clear()
