"""Blender mesh builders on top of the pure geometry (runs inside Blender)."""
import bmesh
import bpy
import numpy as np

from .geometry import Path, box_geometry, grid_faces, grid_verts, lathe_verts, sphere_verts


def coll(scene, name):
    """New collection linked to the scene root."""
    c = bpy.data.collections.new(name)
    scene.collection.children.link(c)
    return c


def mk(name, verts, faces, mat, c, smooth=True, origin=(0, 0, 0)):
    """Mesh object from vertex and face arrays. origin is stored so set_verts can re-pose it."""
    me = bpy.data.meshes.new(name)
    v = np.asarray(verts, dtype=float).reshape(-1, 3) - np.array(origin, dtype=float)
    me.from_pydata(v.tolist(), [], faces)
    me.update()
    if smooth:
        me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    ob = bpy.data.objects.new(name, me)
    ob.location = origin
    c.objects.link(ob)
    if mat:
        me.materials.append(mat)
    ob["origin"] = list(origin)
    return ob


def set_verts(ob, verts):
    """Replace all vertex positions in place (deforming meshes, one call per frame)."""
    v = np.asarray(verts, dtype=float).reshape(-1, 3) - np.array(ob["origin"], dtype=float)
    ob.data.vertices.foreach_set("co", v.ravel())
    ob.data.update()


def grid(name, nu, nv, fn, mat, c, wrap=False, smooth=True):
    """Parametric surface: fn(u, v) -> (x, y, z)."""
    return mk(name, grid_verts(nu, nv, fn), grid_faces(nu, nv, wrap), mat, c, smooth)


def plane(name, mat, c, loc=(0, 0, 0), size=1.0):
    """Flat unit quad in the XZ plane (backdrops, cards), scaled by size."""
    o = mk(name, [(-1, 0, -1), (1, 0, -1), (1, 0, 1), (-1, 0, 1)], [(0, 1, 2, 3)], mat, c, smooth=False)
    o.location = loc
    o.scale = (size, 1, size)
    return o


def ball(name, r, mat, c, loc=(0, 0, 0), scale=(1, 1, 1), nu=32, nv=16, lat0=-89.6, lat1=89.6):
    """UV sphere (or cap, with lat0/lat1) of radius r."""
    ob = mk(name, sphere_verts(nu, nv, lat0, lat1) * r, grid_faces(nu, nv, True), mat, c)
    ob.location = loc
    ob.scale = scale
    return ob


def lathe(name, profile, mat, c, n=48, sy=1.0, subsurf=2):
    """Solid of revolution from a (radius, height) profile, optional subsurf."""
    o = mk(name, lathe_verts(profile, n, sy), grid_faces(n, len(profile), True), mat, c)
    if subsurf:
        m = o.modifiers.new("ss", 'SUBSURF')
        m.levels = subsurf
        m.render_levels = subsurf
    return o


def sweep(name, pts, radii, mat, c, n=80, nseg=24, ripple=0.0, a0=0.0, a1=2 * np.pi):
    """Tube (or arc of a tube) along a spline with per-point radius. Returns (object, Path)."""
    p = Path(pts, radii, n)
    wrap = abs(a1 - a0 - 2 * np.pi) < 1e-6
    o = mk(name, p.verts(p.R, nseg, a0, a1, ripple=ripple), grid_faces(nseg, n, wrap), mat, c)
    return o, p


def box(name, c, mat, loc, size, bevel=0.06):
    """Bevelled box with half-extents size (bevel modifier, weighted normals)."""
    v, f = box_geometry(size)
    o = mk(name, v, f, mat, c, smooth=False)
    o.location = loc
    if bevel:
        b = o.modifiers.new("bv", 'BEVEL')
        b.width = bevel
        b.segments = 4
        o.data.polygons.foreach_set("use_smooth", [True] * len(o.data.polygons))
        try:
            o.modifiers.new("wn", 'WEIGHTED_NORMAL')
        except Exception:
            pass
    return o


def empty(c, name, parent=None, loc=(0, 0, 0)):
    e = bpy.data.objects.new(name, None)
    c.objects.link(e)
    e.location = loc
    if parent:
        e.parent = parent
    return e
