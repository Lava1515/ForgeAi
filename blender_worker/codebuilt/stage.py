"""Scene, lights, camera with depth of field, on-screen readouts (runs inside Blender 5.2)."""
import math
import os

import bpy
from mathutils import Quaternion, Vector

from .meshes import mk
from .paths import require_abs


def reset_scene():
    """Empty the file: objects, collections, and the shared material cache."""
    from . import materials
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    materials.reset_cache()
    return bpy.context.scene


def setup_render(scene, scale=100, samples=24, width=1080, height=1920, background=(0.05, 0.05, 0.06), bg_strength=1.0):
    """EEVEE, Standard view transform, vertical PNG output, plain dark world."""
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs[0].default_value = (*background, 1)
    bg.inputs[1].default_value = bg_strength
    r = scene.render
    r.engine = 'BLENDER_EEVEE'  # Blender 5.x name; 'BLENDER_EEVEE_NEXT' was the 4.2-4.5 name
    r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, scale
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGB'
    r.image_settings.compression = 15
    for k, v in dict(taa_render_samples=samples, use_raytracing=True, use_shadows=True, use_gtao=True).items():
        try:
            setattr(scene.eevee, k, v)
        except Exception as ex:
            print("eevee option skipped:", k, ex)
    scene.view_settings.view_transform = 'Standard'
    try:
        scene.view_settings.look = 'None'
    except Exception as ex:
        print("look skipped:", ex)
    return scene


# ---------------------------------------------------------------- lights
def _aim(o, pos, target):
    o.location = pos
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y')


def area(c, name, pos, target, energy, size, color=(1, 1, 1)):
    l = bpy.data.lights.new(name, 'AREA')
    l.energy, l.size, l.color = energy, size, color
    o = bpy.data.objects.new(name, l)
    _aim(o, pos, target)
    c.objects.link(o)
    return o


def sun(c, name, pos, target, energy, color=(1, 1, 1), angle=3.0):
    l = bpy.data.lights.new(name, 'SUN')
    l.energy, l.color, l.angle = energy, color, math.radians(angle)
    o = bpy.data.objects.new(name, l)
    _aim(o, pos, target)
    c.objects.link(o)
    return o


# ---------------------------------------------------------------- camera
class Camera:
    """One scene camera, re-aimed every frame with set(). fstop enables depth of field."""

    def __init__(self, scene, clip_start=0.05, clip_end=400):
        self.data = bpy.data.cameras.new("cam")
        self.obj = bpy.data.objects.new("cam", self.data)
        scene.collection.objects.link(self.obj)
        scene.camera = self.obj
        self.data.clip_start, self.data.clip_end = clip_start, clip_end
        self.obj.rotation_mode = 'QUATERNION'
        self.target = None

    def set(self, pos, target, lens=50, roll=0.0, fstop=None, focus=None):
        """Place at pos looking at target. focus (a point) defaults to target. The target is recorded (self.target and the
        object property codebuilt_target) so shotcheck.run_qa can judge shot variety from what the camera was aimed at."""
        self.target = tuple(float(v) for v in target)
        self.obj["codebuilt_target"] = list(self.target)
        self.obj.location = pos
        self.data.lens = lens
        self.data.dof.use_dof = fstop is not None
        if fstop is not None:
            self.data.dof.aperture_fstop = fstop
            self.data.dof.focus_distance = (Vector(focus if focus is not None else target) - Vector(pos)).length
        q = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y')
        self.obj.rotation_quaternion = q @ Quaternion((0, 0, 1), roll)


def mark_scenery(*objs):
    """Mark floors, walls, sky or other backdrop objects as scenery (custom property codebuilt_role='scenery'): shotcheck's
    advisory top-third check ignores them. Unmarked meshes count as subject content. Returns its argument (one object) or the tuple."""
    for o in objs:
        o["codebuilt_role"] = "scenery"
    return objs[0] if len(objs) == 1 else objs


# ---------------------------------------------------------------- readouts
_font = [None]


def load_font(path=None):
    """Bold display font. Windows Impact if present; otherwise Blender's built-in font."""
    if path is None:
        path = r"C:\Windows\Fonts\impact.ttf"
    if _font[0] is None or path != getattr(_font[0], "_path", None):
        _font[0] = bpy.data.fonts.load(require_abs(path)) if os.path.exists(path) else bpy.data.fonts["Bfont Regular"]
    return _font[0]


def text(c, name, body, size, mat, loc, extrude=0.06, font=None):
    """3D text standing upright (facing -Y)."""
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body, cu.font, cu.size = body, font or load_font(), size
    cu.align_x = cu.align_y = 'CENTER'
    cu.extrude, cu.bevel_depth = extrude * size, 0.012 * size
    o = bpy.data.objects.new(name, cu)
    o.location = loc
    o.rotation_euler = (math.pi / 2, 0, 0)
    cu.materials.append(mat)
    c.objects.link(o)
    return o


def hud(cam, o, x, y, dist, s):
    """Pin o in front of the camera: x,y offsets at distance dist, scale s."""
    q = cam.obj.rotation_quaternion
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = q
    o.location = cam.obj.location + q @ Vector((x, y, -dist))
    o.scale = (s, s, s)


def hud_text(c, name, body, size, mat, w, h, plate_mat):
    """Readout text on a fitted dark plate, hidden (scale 0) until hud() shows it."""
    t = text(c, name, body, size, mat, (0, 0, 0))
    # Blender's evaluated FONT dimensions reflect the actual loaded font and glyphs.
    bpy.context.view_layer.update()
    pad = size * 0.2
    w, h = min(w, t.dimensions.x / 2 + pad), min(h, t.dimensions.y / 2 + pad)
    t["codebuilt_readout"] = True
    pl = mk(name + "_pl", [(-w, -h, -0.04), (w, -h, -0.04), (w, h, -0.04), (-w, h, -0.04)],
            [(0, 1, 2, 3)], plate_mat, c, smooth=False)
    pl.parent = t
    t.scale = (0, 0, 0)
    return t
