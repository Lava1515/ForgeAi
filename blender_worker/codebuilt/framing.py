"""Every-frame framing check: is the subject inside the safe middle zone."""
DEFAULT_ZONE = (0.2, 0.8, 0.22, 0.9)  # xmin, xmax, ymin, ymax in camera-view 0..1
MIN_DEPTH = 0.05


def in_zone(x, y, z, zone=DEFAULT_ZONE, min_depth=MIN_DEPTH):
    x0, x1, y0, y1 = zone
    return x0 <= x <= x1 and y0 <= y <= y1 and z > min_depth


def find_bad(samples, zone=DEFAULT_ZONE, min_depth=MIN_DEPTH):
    """samples: iterable of (frame, x, y, z). Returns rounded entries outside the zone."""
    return [(f, round(x, 2), round(y, 2), round(z, 2)) for f, x, y, z in samples
            if not in_zone(x, y, z, zone, min_depth)]


def check_scene(scene, cam, apply, subject, nframes, zone=DEFAULT_ZONE):
    """In Blender: pose every frame and project subject() (a world point) through cam."""
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    samples = []
    for f in range(nframes):
        apply(f)
        bpy.context.view_layer.update()
        v = world_to_camera_view(scene, cam, Vector(subject()))
        samples.append((f, v.x, v.y, v.z))
    return find_bad(samples, zone)
