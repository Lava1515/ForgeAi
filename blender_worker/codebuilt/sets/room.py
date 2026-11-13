"""Set: room (KAN-911). Ported from the chat room scenery; runs inside Blender.

A teal back wall 7 units behind the origin (+Y) with wainscot, a window, a shelf with books and a
gumball machine, and a potted plant. The front of the room is open: put a character or prop near
the origin and shoot towards +Y. Lit by five area lights (key, fill, rim, window, wall).
Handles: wall, window_panes, shelf, books, gumball_machine, gumballs, plant_pot, plant_leaves, wall_y.
"""
import math

import numpy as np

from .. import materials, meshes
from .common import SetBuilder

NAME = "room"
WY = 7.0  # wall distance behind the origin


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, rng, pbr = b.c, b.p, b.rng, materials.pbr
    wood = pbr("wood", (0.42, 0.24, 0.12), 0.55, Coat_Weight=0.3)
    leaf = pbr("leaf", (0.10, 0.45, 0.14), 0.4, Coat_Weight=0.3)
    red = pbr("redlac", (0.8, 0.05, 0.04), 0.15, Coat_Weight=0.8, Coat_Roughness=0.05)
    white = pbr("teeth", (0.95, 0.94, 0.9), 0.2)
    wall = meshes.mk("roomwall", [(-1, 0, -1), (1, 0, -1), (1, 0, 1), (-1, 0, 1)], [(0, 1, 2, 3)],
                     pbr("wall", (0.06, 0.36, 0.40), 0.85), c, smooth=False)
    wall.location = P((0, WY, 0))
    wall.scale = (16, 1, 12)
    meshes.box("wainscot", c, wood, P((0, WY - 0.05, -4.6)), (16, 0.06, 1.2), 0.02)
    window = materials.emit("window", (0.75, 0.9, 1.0), 1.0)
    meshes.box("winframe", c, white, P((-2.25, WY - 0.08, 1.0)), (0.95, 0.08, 1.45), 0.03)
    panes = [meshes.box("pane", c, window, P((-2.25 + dx, WY - 0.17, 1.0 + dz)), (0.38, 0.02, 0.6), 0)
             for (dx, dz) in ((-0.43, 0.67), (0.43, 0.67), (-0.43, -0.67), (0.43, -0.67))]
    shelf = meshes.box("shelf", c, wood, P((2.25, WY - 0.4, 0.55)), (1.05, 0.4, 0.06), 0.02)
    books, bx = [], 1.4
    for i, (w_, h_, colr) in enumerate([(0.09, 0.5, (0.8, 0.15, 0.1)), (0.07, 0.42, (0.1, 0.5, 0.3)), (0.1, 0.55, (0.95, 0.75, 0.1)),
                                        (0.08, 0.46, (0.2, 0.3, 0.75)), (0.09, 0.5, (0.6, 0.2, 0.6))]):
        books.append(meshes.box("book", c, pbr("book%d" % i, colr, 0.6), P((bx + w_, WY - 0.4, 0.61 + h_)), (w_, 0.28, h_), 0.015))
        bx += 2 * w_ + 0.02
    # gumball machine: red base, glass globe full of gumballs, red cap
    machine = meshes.lathe("gm_base", [(0.02, 0.61), (0.3, 0.61), (0.3, 0.68), (0.2, 0.75), (0.17, 0.98), (0.26, 1.05), (0.02, 1.05)],
                           red, c, n=32, subsurf=1)
    machine.location = P((2.85, WY - 0.4, 0))
    glass = pbr("glassball", (0.9, 0.97, 1.0), 0.03, alpha=0.28, Coat_Weight=1.0)
    meshes.ball("gm_glass", 0.36, glass, c, loc=P((2.85, WY - 0.4, 1.36)))
    colors = [(1, 0.2, 0.5), (0.2, 0.6, 1), (1, 0.8, 0.1), (0.3, 0.85, 0.3), (1, 0.4, 0.1)]
    gumballs = []
    for i in range(22):
        a, b_, rr = rng.uniform(0, 2 * np.pi), rng.uniform(-1.3, 0.3), rng.uniform(0.05, 0.26)
        gumballs.append(meshes.ball("gb", 0.075, pbr("gb%d" % i, colors[i % 5], 0.2, Coat_Weight=0.6), c,
                                    loc=P((2.85 + rr * math.cos(a), WY - 0.4 + rr * math.sin(a),
                                           1.36 - 0.27 + 0.1 * (1 + math.sin(b_)) * rng.uniform(0.3, 1.2))), nu=12, nv=8))
    meshes.ball("gm_cap", 1.0, red, c, loc=P((2.85, WY - 0.4, 1.74)), scale=(0.2, 0.2, 0.08))
    # potted plant hanging high on the left
    pot = meshes.lathe("pot", [(0.02, -5.0), (0.36, -5.0), (0.46, -4.3), (0.5, -4.3), (0.5, -4.2), (0.02, -4.2)],
                       pbr("potm", (0.85, 0.4, 0.25), 0.7), c, n=24, subsurf=1)
    pot.location = P((-2.7, 5.6, 2.2))
    leaves = []
    for i in range(9):
        a = i * 2.4
        lf = meshes.ball("leaf", 1.0, leaf, c, loc=P((-2.7 + 0.35 * math.cos(a), 5.6 + 0.3 * math.sin(a), -1.55 + 0.12 * (i % 4))),
                         scale=(0.16, 0.05, 0.55))
        lf.rotation_euler = (0.5 * math.sin(a), 0.5 * math.cos(a), a)
        leaves.append(lf)
    # three-point 'skin' profile plus window and wall washes
    b.area("LGT-key", (-4.6, -6.5, 3.6), (0, -0.5, -0.2), 470, 4, (1.0, 0.93, 0.82))
    b.area("LGT-fill", (5, -6, -0.5), (0, 0, -0.5), 117, 6, (0.9, 0.95, 1.0))
    b.area("LGT-rim", (3.2, 4.2, 3.6), (0, 0, 0), 430, 3, (0.92, 0.95, 1.0))
    b.area("LGT-window", (-3.5, 5.5, 2.0), (0, 0, 0), 270, 3, (0.8, 0.9, 1.0))
    b.area("LGT-wall", (0, 1.5, 4.5), (0, WY, 0.5), 470, 8, (1.0, 0.92, 0.8))
    return b.handles((0.5, WY, 0.5), wall=wall, window_panes=panes, shelf=shelf, books=books, gumball_machine=machine,
                     gumballs=gumballs, plant_pot=pot, plant_leaves=leaves, wall_y=WY)
