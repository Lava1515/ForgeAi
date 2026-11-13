"""Set: bathroom (KAN-911). Ported from the chat bathroom set; runs inside Blender.

Tiled floor and back wall (wall at +Y 2.25), a toilet (bowl, seat, water surface, tank, lid, flush
button), a paper roll, bin, bath mat and a potted plant. The water surface is a 26x48 grid at
z=0.66, radius 0.6; deform it with `water_verts(t, t_hit)` and `meshes.set_verts`.
Handles: bowl, seat, water, water_verts, tank, lid, roll, floor, wall, bin, plant_pot, bath_mat.
"""
import math

import numpy as np

from .. import materials, meshes
from ..geometry import Path, grid_faces
from ..mathx import ss
from .common import SetBuilder, tile_mat

NAME = "bathroom"
WATER_Z, WATER_R = 0.66, 0.6
_WR, _WA = np.meshgrid(np.linspace(0.0, 1.0, 26), np.linspace(0, 2 * np.pi, 48, endpoint=False), indexing="ij")


def water_verts(origin, t=0.0, t_hit=1e9):
    """Water-surface vertices (world) for a set at origin; ripples after the time t_hit."""
    r = _WR * WATER_R
    z = np.full_like(r, WATER_Z) + 0.004 * np.sin(_WA * 3 + t * 2)
    age = t - t_hit
    if age > 0:
        z += 0.07 * math.exp(-age * 1.6) * np.sin(r * 22 - age * 13) * np.exp(-r * 1.5) * ss(0, 0.15, age)
    v = np.stack([r * np.cos(_WA), r * np.sin(_WA) * 1.25 - 0.02, z], -1).reshape(-1, 3)
    return v + np.array(origin, float)


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, pbr = b.c, b.p, materials.pbr
    ceramic = pbr("ceramic", (0.86, 0.87, 0.9), 0.15, Coat_Weight=0.8, Coat_Roughness=0.05)
    chrome = pbr("chrome", (0.8, 0.82, 0.85), 0.12, Metallic=1.0)
    paper = pbr("paper", (0.97, 0.97, 0.95), 0.9)
    leaf = pbr("leaf", (0.10, 0.45, 0.14), 0.4, Coat_Weight=0.3)
    bowl = meshes.lathe("bowl", [(0.02, 0.0), (0.58, 0.0), (0.6, 0.06), (0.56, 0.3), (0.7, 0.62), (0.95, 0.92), (1.02, 1.0), (1.02, 1.06),
                                 (0.9, 1.07), (0.84, 1.0), (0.74, 0.8), (0.5, 0.5), (0.25, 0.36), (0.02, 0.33)], ceramic, c, sy=1.25)
    seat = meshes.lathe("seat", [(0.8, 1.08), (1.04, 1.08), (1.07, 1.12), (1.04, 1.16), (0.8, 1.16), (0.77, 1.12), (0.8, 1.08)], ceramic, c, sy=1.25)
    water_mat = pbr("water", (0.15, 0.6, 0.95), 0.03, Emission_Color=(0.1, 0.5, 1.0, 1), Emission_Strength=0.35, Coat_Weight=1.0)
    water = meshes.mk("water", water_verts(b.origin), grid_faces(48, 26, True), water_mat, c, origin=P((0, -1.0, 2.0)))
    bowl.location = seat.location = P((0, 0, 0))
    tank = meshes.box("tank", c, ceramic, P((0, 1.72, 1.75)), (0.95, 0.36, 0.75), 0.08)
    meshes.box("tanklid", c, ceramic, P((0, 1.72, 2.55)), (1.02, 0.42, 0.07), 0.05)
    meshes.box("neckb", c, ceramic, P((0, 1.3, 0.75)), (0.5, 0.45, 0.4), 0.1)
    lid = meshes.ball("lidt", 1.0, ceramic, c, loc=P((0, 1.28, 2.25)), scale=(0.98, 0.06, 1.2))
    meshes.ball("button", 1.0, chrome, c, loc=P((0, 1.72, 2.63)), scale=(0.12, 0.12, 0.04))
    tr = Path([(2.0, 2.2, 1.9), (2.0, 1.9, 1.9), (2.0, 1.6, 1.9)], [0.3, 0.3, 0.3], 6)
    roll = meshes.mk("roll", b.v(tr.verts(tr.R, 28)), grid_faces(28, 6, True), paper, c)
    meshes.ball("rollcap", 1.0, paper, c, loc=P((2.0, 1.6, 1.9)), scale=(0.3, 0.02, 0.3))
    meshes.box("holder", c, chrome, P((2.0, 2.2, 1.9)), (0.06, 0.25, 0.06), 0.02)
    floor = meshes.mk("floor", [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [(0, 1, 2, 3)],
                      tile_mat("tiles", (0.9, 0.9, 0.86), (0.12, 0.3, 0.42), 30), c, smooth=False)
    floor.location = P((0, 0, 0))
    floor.scale = (14, 14, 1)
    wall = meshes.mk("wall", [(-1, 0, 0), (1, 0, 0), (1, 0, 1), (-1, 0, 1)], [(0, 1, 2, 3)],
                     tile_mat("walltiles", (0.10, 0.55, 0.62), (0.07, 0.47, 0.55), 30), c, smooth=False)
    wall.location = P((0, 2.25, 0))
    wall.scale = (14, 1, 12)
    mat_ = meshes.box("bathmat", c, pbr("bathmat", (0.95, 0.55, 0.2), 0.95, Sheen_Weight=0.5), P((0, -2.4, 0.03)), (1.3, 0.75, 0.03), 0.03)
    bin_ = meshes.lathe("bin", [(0.02, 0.0), (0.42, 0.0), (0.5, 1.1), (0.52, 1.1), (0.52, 1.16), (0.02, 1.16)], chrome, c, n=32, subsurf=1)
    bin_.location = P((-2.3, 1.5, 0))
    pot = meshes.lathe("pot2", [(0.02, 0.0), (0.3, 0.0), (0.4, 0.6), (0.44, 0.6), (0.44, 0.68), (0.02, 0.68)],
                       pbr("pot2m", (0.95, 0.9, 0.8), 0.5), c, n=24, subsurf=1)
    pot.location = P((2.35, 1.5, 0))
    for i in range(10):
        a = i * 2.4
        lf = meshes.ball("leaf2", 1.0, leaf, c, loc=P((2.35 + 0.25 * math.cos(a), 1.5 + 0.25 * math.sin(a), 1.25 + 0.1 * (i % 4))),
                         scale=(0.14, 0.04, 0.6))
        lf.rotation_euler = (0.45 * math.sin(a), 0.45 * math.cos(a), a)
    b.area("key", (-4, -5, 7), (0, 0, 1), 300, 5, (1.0, 0.97, 0.92))
    b.area("fill", (5, -6, 3), (0, 0, 1), 76, 6, (0.85, 0.93, 1.0))
    b.area("top", (0, -0.5, 6), (0, 0, 0.8), 70, 3, (1, 1, 1))
    return b.handles((0.0, 0.0, 1.0), bowl=bowl, seat=seat, water=water, water_verts=water_verts, tank=tank, lid=lid, roll=roll,
                     floor=floor, wall=wall, bin=bin_, plant_pot=pot, bath_mat=mat_)
