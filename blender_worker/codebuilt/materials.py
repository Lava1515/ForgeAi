"""Materials (runs inside Blender 5.2; Principled BSDF input names are the 5.x ones)."""
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

    t = max(0.01, min(0.99, 1.0 - wear))
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

    nt.links.new(no.outputs[0], ramp_col.inputs[0])
    nt.links.new(ramp_col.outputs[0], b.inputs["Base Color"])
    nt.links.new(no.outputs[0], ramp_met.inputs[0])
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

    t = max(0.01, min(0.99, 1.0 - wear))
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

    nt.links.new(no.outputs[0], ramp_col.inputs[0])
    nt.links.new(ramp_col.outputs[0], b.inputs["Base Color"])
    nt.links.new(no.outputs[0], ramp_met.inputs[0])
    nt.links.new(ramp_met.outputs[0], b.inputs["Metallic"])
    nt.links.new(no.outputs[0], ramp_rough.inputs[0])
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


def glass(name, color=(0.95, 0.97, 1.0), rough=0.02, ior=1.45, alpha=0.3, bevel=0.01):
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


def earth_relief(name="earth_relief", relief_type="hypsometric", bump=0.4, scale=1.0, image_path=None):
    """Shaded-relief and hypsometric Earth base for maps (underneath country fills)."""
    m = pbr(name, (0.05, 0.16, 0.30), rough=0.6)
    nt = m.node_tree
    b = _principled(m)
    tc = nt.nodes.new('ShaderNodeTexCoord')

    if image_path:
        try:
            img = bpy.data.images.load(image_path)
            tex = nt.nodes.new('ShaderNodeTexImage')
            tex.image = img
            nt.links.new(tc.outputs["UV" if "UV" in tc.outputs else "Generated"], tex.inputs["Vector"])
            nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
            _attach_normal(nt, b, bump_height=tex.outputs["Color"], bump_strength=bump)
            return m
        except Exception as ex:
            print("image load skipped, falling back to procedural relief:", ex)

    # Procedural shaded relief terrain / hypsometric tints
    no = nt.nodes.new('ShaderNodeTexNoise')
    no.inputs["Scale"].default_value = 8.0 * scale
    if "Detail" in no.inputs:
        no.inputs["Detail"].default_value = 6.0
    if "Roughness" in no.inputs:
        no.inputs["Roughness"].default_value = 0.7
    wv = nt.nodes.new('ShaderNodeTexWave')
    wv.inputs["Scale"].default_value = 4.0 * scale
    wv.inputs["Distortion"].default_value = 5.0

    ramp = nt.nodes.new('ShaderNodeValToRGB')
    elements = ramp.color_ramp.elements
    # Hypsometric gradient: ocean deep -> shelf -> lowland -> plateau -> mountain -> snow
    elements[0].position = 0.0
    elements[0].color = (0.02, 0.08, 0.20, 1.0)
    elements[1].position = 1.0
    elements[1].color = (0.88, 0.90, 0.94, 1.0)
    for pos, col in [(0.32, (0.06, 0.24, 0.36)), (0.40, (0.18, 0.34, 0.15)),
                     (0.62, (0.50, 0.45, 0.26)), (0.82, (0.40, 0.32, 0.24))]:
        try:
            el = elements.new(pos)
            el.color = (*col, 1.0)
        except Exception:
            pass

    nt.links.new(tc.outputs["Object"], no.inputs["Vector"])
    nt.links.new(tc.outputs["Object"], wv.inputs["Vector"])
    nt.links.new(no.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    _attach_normal(nt, b, bump_height=no.outputs[0], bump_strength=bump)
    return m


_cache = {}


def col(rgb, rough=0.6, **kw):
    """Cached plain colour material for background crowds, distant props, or diagram elements."""
    k = (tuple(round(x, 3) for x in rgb), rough, tuple(sorted(kw.items())))
    if k not in _cache:
        _cache[k] = pbr("c%d" % len(_cache), rgb, rough, **kw)
    return _cache[k]


def reset_cache():
    _cache.clear()
