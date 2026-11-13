"""Set: toy city street (KAN-911). Ported from the chat city set; runs inside Blender.

Road along X from -150 to 150, sidewalks either side, shop buildings at y=+13, palms, lamps,
clouds and an emissive sky dome. Standing cars and people are placed on the road and sidewalks.
Handles: buildings (list of (x, height)), cars, people, palms, hero (person), sky.
"""
import math

import numpy as np

from .. import figures, materials, meshes
from ..geometry import Path, grid_faces
from .common import SetBuilder, rockmat

NAME = "city_street"
CARCOL = [(0.85, 0.15, 0.12), (0.15, 0.4, 0.85), (0.95, 0.75, 0.1), (0.2, 0.65, 0.35), (0.9, 0.9, 0.9), (0.95, 0.5, 0.1)]
BCOL = [(0.93, 0.62, 0.45), (0.55, 0.75, 0.85), (0.95, 0.85, 0.6), (0.75, 0.55, 0.7), (0.6, 0.8, 0.65), (0.85, 0.5, 0.45), (0.9, 0.9, 0.86)]


def _car(b, i, loc, yaw):
    c, col = b.c, materials.col
    root = meshes.empty(c, "car", loc=loc)
    root.rotation_euler = (0, 0, yaw)
    m = col(CARCOL[i % 6], 0.2, Coat_Weight=0.8)
    glass = col((0.1, 0.16, 0.22), 0.1)
    lamp = materials.emit("headlight", (1, 1, 1), 6.0)
    parts = [meshes.box("body", c, m, (0, 0, 0.62), (2.1, 0.9, 0.36), 0.14),
             meshes.box("cabin", c, glass, (-0.15, 0, 1.2), (1.05, 0.78, 0.3), 0.12),
             meshes.box("roof", c, m, (-0.15, 0, 1.5), (0.95, 0.74, 0.04), 0.03),
             meshes.ball("hl", 1.0, lamp, c, loc=(2.1, 0.55, 0.68), scale=(0.05, 0.16, 0.1), nu=8, nv=6),
             meshes.ball("hl", 1.0, lamp, c, loc=(2.1, -0.55, 0.68), scale=(0.05, 0.16, 0.1), nu=8, nv=6)]
    tire = col((0.03, 0.03, 0.035), 0.8)
    for sx in (-1.3, 1.3):
        for sy in (-0.88, 0.88):
            parts.append(meshes.ball("wheel", 1.0, tire, c, loc=(sx, sy, 0.37), scale=(0.37, 0.17, 0.37), nu=16, nv=8))
    for o in parts:
        o.parent = root
    return root


def _palm(b, x, y):
    c = b.c
    root = meshes.empty(c, "palm", loc=b.p((x, y, 0.15)))
    tp = Path([(0, 0, 0), (0.15, 0, 2.0), (0.12, 0, 4.0), (0.32, 0, 5.6)], [0.22, 0.18, 0.15, 0.12], 12)
    trunk = meshes.mk("trunk", tp.verts(tp.R, 10), grid_faces(10, 12, True), materials.pbr("wood", (0.42, 0.24, 0.12), 0.55), c)
    trunk.parent = root
    leaf = materials.pbr("leaf", (0.10, 0.45, 0.14), 0.4, Coat_Weight=0.3)
    for k in range(8):
        a = k * 2 * math.pi / 8
        fr = meshes.ball("frond", 1.0, leaf, c, loc=(0.32 + 1.25 * math.cos(a), 1.25 * math.sin(a), 5.45),
                         scale=(1.5, 0.3, 0.07), nu=12, nv=6)
        fr.rotation_euler = (0, 0.45, a)
        fr.parent = root
    return root


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, col, P, rng = b.c, materials.col, b.p, b.rng
    # ground, road, sidewalks, lane marks
    ground = meshes.mk("ground", [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [(0, 1, 2, 3)],
                       rockmat("pave", (0.42, 0.43, 0.46), (0.34, 0.35, 0.38), 0.6, 0.15, 0.85), c, smooth=False)
    ground.scale = (220, 220, 1)
    ground.location = P((0, 0, 0))
    meshes.box("road", c, col((0.09, 0.09, 0.1), 0.8), P((0, 0, 0.02)), (150, 3.5, 0.03), 0)
    for sy in (-1, 1):
        meshes.box("walk", c, col((0.6, 0.59, 0.56), 0.85), P((0, sy * 5.25, 0.08)), (150, 1.75, 0.08), 0.02)
    dv, df = [], []
    for x in np.arange(-146, 146, 4.0):
        k = len(dv)
        dv += [(x, -0.09, 0.06), (x + 2.0, -0.09, 0.06), (x + 2.0, 0.09, 0.06), (x, 0.09, 0.06)]
        df.append((k, k + 1, k + 2, k + 3))
    for x in np.arange(-3.0, 3.01, 0.75):
        k = len(dv)
        dv += [(8.0, x - 0.22, 0.06), (11.0, x - 0.22, 0.06), (11.0, x + 0.22, 0.06), (8.0, x + 0.22, 0.06)]
        df.append((k, k + 1, k + 2, k + 3))
    meshes.mk("lanes", b.v(dv), df, col((0.95, 0.95, 0.9), 0.7), c, smooth=False)
    # shop buildings with awnings, doors, roof units and a window mesh
    wv, wf, buildings = [], [], []
    x, i = -96.0, 0
    while x < 96:
        w_, h_ = float(rng.uniform(7, 11)), float(rng.uniform(9, 26))
        meshes.box("bld", c, col(BCOL[i % 7], 0.8), P((x + w_ / 2, 13, h_ / 2)), (w_ / 2 - 0.12, 5, h_ / 2), 0.1)
        awn = meshes.box("awn", c, col(figures.SHIRTS[i % 7], 0.7), P((x + w_ / 2, 7.45, 2.75)), (w_ / 2 - 0.6, 0.6, 0.08), 0.03)
        awn.rotation_euler = (0.3, 0, 0)
        meshes.box("door", c, col((0.25, 0.16, 0.1), 0.6), P((x + w_ / 2, 7.96, 1.1)), (0.55, 0.05, 1.05), 0.02)
        meshes.box("ac", c, col((0.7, 0.7, 0.72), 0.5), P((x + w_ / 2 + 1, 12, h_ + 0.5)), (0.9, 0.9, 0.5), 0.05)
        nc, nr = int((w_ - 1.4) / 1.7), int((h_ - 4.2) / 2.5)
        for a in range(nc):
            for r in range(nr):
                cx, cz = x + w_ / 2 + (a - (nc - 1) / 2) * 1.7, 4.6 + r * 2.5
                k = len(wv)
                wv += [(cx - 0.5, 7.97, cz - 0.7), (cx + 0.5, 7.97, cz - 0.7), (cx + 0.5, 7.97, cz + 0.7), (cx - 0.5, 7.97, cz + 0.7)]
                wf.append((k, k + 1, k + 2, k + 3))
        buildings.append((x + w_ / 2, h_))
        x += w_
        i += 1
    meshes.mk("windows", b.v(wv), wf,
              materials.pbr("winglass", (0.2, 0.45, 0.7), 0.08, Coat_Weight=1.0, Emission_Color=(0.4, 0.75, 1.0, 1), Emission_Strength=0.35),
              c, smooth=False)
    # palms, lamps, clouds
    palms = [_palm(b, x, y) for x in np.arange(-90, 91, 12.0) for y in (-6.2, 6.2)]
    metal = col((0.2, 0.22, 0.25), 0.4)
    spark = materials.emit("spark", (1, 1, 1), 6.0)
    for x in np.arange(-84, 85, 12.0):
        meshes.box("lamp", c, metal, P((x, -4.0, 2.6)), (0.06, 0.06, 2.45), 0.02)
        meshes.box("lamparm", c, metal, P((x, -3.5, 5.0)), (0.05, 0.5, 0.05), 0.02)
        meshes.ball("lampb", 0.16, spark, c, loc=P((x, -3.05, 4.93)), nu=10, nv=6)
    cloud = col((1, 1, 1), 0.9, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.35)
    for (cx, cy, cz, s_) in [(-40, 60, 34, 7), (20, 66, 40, 9), (60, 58, 30, 6), (-80, 64, 38, 8)]:
        for k in range(4):
            meshes.ball("cloud", 1.0, cloud, c, loc=P((cx + k * s_ * 0.7, cy, cz + (k % 2) * s_ * 0.25)),
                        scale=(s_, s_ * 0.6, s_ * 0.5), nu=14, nv=8)
    # standing cars and people (a hero on the near sidewalk)
    cars = [_car(b, k, P((-30 + k * 12.0, -1.75 if k % 2 == 0 else 1.75, 0.04)), 0.0 if k % 2 == 0 else math.pi) for k in range(6)]
    people = []
    for k in range(12):
        f = figures.make_person(c, k + 2)
        figures.pose(f, P((float(rng.uniform(-40, 40)), (-5.3 if k % 3 else 5.3) + float(rng.uniform(-0.8, 0.8)), 0.16)),
                     (0, 0, float(rng.choice([-1, 1])) * math.pi / 2))
        people.append(f)
    hero = figures.make_person(c, 1)
    figures.pose(hero, P((0, -5.0, 0.16)), (0, 0, 0))
    # sky dome (emissive gradient) and lights
    sa, sz = np.radians(np.linspace(15, 255, 49)), np.linspace(-0.05, 1.4, 12)
    SA, SZ = np.meshgrid(sa, sz, indexing="xy")
    sky = meshes.mk("skydome", np.stack([0.8 * np.cos(SA), 0.8 * np.sin(SA), SZ], -1), grid_faces(49, 12, False),
                    materials.backdrop_mat("citysky", (0.75, 0.9, 1.0), (0.12, 0.42, 0.95)), c)
    sky.scale = (230, 230, 230)
    sky.location = P((0, 0, 0))
    try:
        sky.visible_shadow = False
    except Exception as ex:  # property differs across Blender versions
        print("shadow flag skipped:", ex)
    b.sun("LGT-sunC", (-30, -40, 60), (0, 0, 0), 3.0, (1.0, 0.96, 0.88))
    b.area("LGT-fillC", (30, -40, 20), (0, 0, 4), 14000, 30, (0.75, 0.87, 1.0))
    return b.handles((0.0, 0.0, 4.0), buildings=buildings, cars=cars, people=people, palms=palms, hero=hero, sky=sky)
