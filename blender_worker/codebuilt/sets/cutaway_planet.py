"""Set: cutaway planet (KAN-911). Ported from the chat Earth cutaway; runs inside Blender.

An Earth of radius 5 with a 270 degree wedge removed, so the cut faces show crust, mantle,
outer core and a bright inner core. A thin shaft line runs pole to pole; a marker, halo and
trail ride it. Handles: earth, atmosphere, core, marker, halo, trail, shaft_line, clock, label,
radii (crust_outer, crust_inner, core_outer, core_inner), stars.
"""
import math

import numpy as np

from .. import materials, meshes, stage
from ..geometry import Path, grid_faces
from .common import SetBuilder, earth_mat, rockmat, star_field, text_mats, xray_mat

NAME = "cutaway_planet"
RE, RM, RC, RI = 5.0, 4.82, 2.73, 0.96  # surface, crust base, outer core top, inner core
L0, L1 = math.radians(-45), math.radians(225)  # the kept longitudes


def _shell(r, nu=96, nv=48):
    lat = np.radians(np.linspace(89.6, -89.6, nv))
    lon = np.linspace(L0, L1, nu)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    return (np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1) * r).reshape(-1, 3)


def _cutface(b, lon, r0, r1, mat, nr):
    lat = np.radians(np.linspace(90, -90, 49))
    rr = np.linspace(r0, r1, nr)
    la, r = np.meshgrid(lat, rr, indexing="ij")
    v = np.stack([r * np.cos(la) * math.cos(lon), r * np.cos(la) * math.sin(lon), r * np.sin(la)], -1).reshape(-1, 3)
    o = meshes.mk("cut", v, grid_faces(nr, 49, False), mat, b.c, smooth=False)
    o.location = b.p((0, 0, 0))
    return o


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P = b.c, b.p
    earth = meshes.mk("earth", _shell(RE), grid_faces(96, 48, False), earth_mat(sand=(0.55, 0.45, 0.25)), c)
    earth.location = P((0, 0, 0))
    atmo = meshes.mk("atmo", _shell(RE * 1.03), grid_faces(96, 48, False), xray_mat("atmo", (0.3, 0.6, 1.0)), c)
    atmo.location = P((0, 0, 0))
    crust = rockmat("crust", (0.45, 0.3, 0.18), (0.3, 0.2, 0.12), 3, 0.5)
    mantle = materials.noise_mat("mantle", (0.85, 0.16, 0.03), (0.42, 0.04, 0.02), rough=0.6, scale=1.4, bump=0.3, sss=0, coat=0)
    materials.set_inputs(next(n for n in mantle.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'),
                         Emission_Color=(0.9, 0.12, 0.02, 1), Emission_Strength=0.45)
    ocore = materials.noise_mat("ocore", (1.0, 0.75, 0.12), (1.0, 0.45, 0.05), rough=0.5, scale=2.5, bump=0.2, sss=0, coat=0)
    materials.set_inputs(next(n for n in ocore.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'),
                         Emission_Color=(1.0, 0.55, 0.05, 1), Emission_Strength=1.1)
    for lon in (L0, L1):
        _cutface(b, lon, RM, RE, crust, 2)
        _cutface(b, lon, RC, RM, mantle, 6)
        _cutface(b, lon, RI * 0.98, RC, ocore, 5)
    core = meshes.ball("icore", RI, materials.emit("icore", (1.0, 0.93, 0.6), 2.6), c, loc=P((0, 0, 0)), nu=48, nv=24)
    b.point("LGT-core", (0, -1.6, 0), 120, (1.0, 0.8, 0.4))
    shp = Path([(0, -0.06, RE + 0.3), (0, -0.06, 0), (0, -0.06, -RE - 0.3)], [0.045] * 3, 12)
    shaft = meshes.mk("shaftline", b.v(shp.verts(shp.R, 10)), grid_faces(10, 12, True), materials.emit("shaftline", (0.55, 0.9, 1.0), 1.2), c)
    tp = Path([(0, 0, 0), (0, 0, 0.5), (0, 0, 1.0)], [0.08] * 3, 6)
    trail = meshes.mk("trail", tp.verts(tp.R, 10), grid_faces(10, 6, True), materials.emit("cyan", (0.2, 0.9, 1.0), 4.0), c)
    trail.location = P((0, -0.08, RE))
    trail.scale = (1, 1, -0.01)  # grows downward from the surface when the marker falls
    marker = meshes.ball("marker", 0.17, materials.emit("marker", (1, 1, 1), 9.0), c, loc=P((0, -0.1, RE)))
    halo = meshes.ball("halo", 0.42, materials.pbr("halo", (0.3, 0.9, 1.0), 0.5, alpha=0.3, Emission_Color=(0.2, 0.9, 1.0, 1), Emission_Strength=3.0),
                       c, loc=P((0, -0.1, RE)))
    stars = star_field(b, 420, 45, 50, 45, (0.04, 0.16), materials.emit("spark", (1, 1, 1), 6.0))
    b.backdrop(materials.backdrop_mat("bd_space", (0.05, 0.03, 0.14), (0.0, 0.0, 0.015)), (0, 46, 0), 70)
    b.area("LGT-sunE", (-14, -16, 10), (0, 0, 0), 26000, 10, (1.0, 0.97, 0.9))
    b.area("LGT-rimE", (12, 6, -6), (0, 0, 0), 9000, 8, (0.4, 0.6, 1.0))
    tm = text_mats()
    clock = stage.text(c, "txtT", "00:00", 1.0, tm["w"], P((0, 0, 6.55)))
    label = stage.text(c, "txtL", "12,742 KM", 0.55, tm["y"], P((0, -6, 5.75)))
    label.scale = (0, 0, 0)  # hidden until a shot shows it
    return b.handles((0.0, 0.0, 0.0), earth=earth, atmosphere=atmo, core=core, marker=marker, halo=halo, trail=trail,
                     shaft_line=shaft, clock=clock, label=label, stars=stars,
                     radii=dict(crust_outer=RE, crust_inner=RM, core_outer=RC, core_inner=RI))
