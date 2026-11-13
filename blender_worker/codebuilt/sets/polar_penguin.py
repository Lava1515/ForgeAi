"""Set: polar penguin (KAN-911). Ported from the chat pole set; runs inside Blender.

Snow field, icebergs, a striped pole with a spin ring and arrow head, a penguin rig, a warm sky
card and a low sun. Handles: penguin (empty), head (empty), wings (two pivots), ring, pole, bergs.
"""
import math

import numpy as np

from .. import materials, meshes
from ..geometry import grid_faces
from .common import SetBuilder, rockmat, text_mats

NAME = "polar_penguin"


def _arrow(c, mat):
    from ..geometry import Path
    pts = [(0, 0, 0), (0.6, 0, 0), (1.2, 0, 0), (1.25, 0, 0), (1.3, 0, 0), (1.7, 0, 0), (2.0, 0, 0)]
    ap = Path(pts, [0.09, 0.09, 0.09, 0.16, 0.26, 0.12, 0.01], 40)
    return meshes.mk("arrow", ap.verts(ap.R, 12), grid_faces(12, 40, True), mat, c)


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, col = b.c, b.p, materials.col
    # snow field: rings that grow geometrically, gently rolling beyond r=6
    rs = 0.05 * np.exp(np.linspace(0, math.log(3000), 34))
    ang = np.linspace(0, 2 * np.pi, 72, endpoint=False)
    Rg, Ag = np.meshgrid(rs, ang, indexing="ij")
    Xg, Yg = Rg * np.cos(Ag), Rg * np.sin(Ag)
    Zg = 0.6 * np.clip((Rg - 6) / 12, 0, 1) * (np.sin(Xg * 0.23) * np.cos(Yg * 0.19) + 0.5 * np.sin(Xg * 0.07 + 2))
    snow = meshes.mk("snow", np.stack([Xg, Yg, Zg], -1), grid_faces(72, 34, True),
                     rockmat("snowm", (0.95, 0.97, 1.0), (0.78, 0.86, 0.97), 0.5, 0.35, 0.6), c)
    snow.location = P((0, 0, 0))
    bergs = []
    for i in range(16):
        a, r = i * 1.9 + 0.3, 14 + (i % 5) * 7
        o = meshes.lathe("berg", [(0.02, 0.0), (2.2, 0.0), (1.4, 2.6 + 1.2 * (i % 3)), (0.02, 4.2 + 1.5 * (i % 3))],
                         materials.pbr("ice%d" % (i % 2), (0.75, 0.9, 1.0), 0.15, Coat_Weight=0.6), c, n=6, subsurf=0)
        o.location = P((r * math.cos(a), abs(r * math.sin(a)) + 6, 0))
        o.scale = (1 + 0.5 * (i % 3),) * 3
        o.rotation_euler = (0, 0, i)
        bergs.append(o)
    # the pole: post, red stripes, chrome ball, spin ring with arrow head
    white, red = col((0.95, 0.95, 0.95), 0.4), col((0.85, 0.08, 0.06), 0.4)
    pole = meshes.lathe("polepost", [(0.02, 0), (0.13, 0), (0.13, 2.7), (0.02, 2.7)], white, c, n=16, subsurf=0)
    pole.location = P((0, 0, 0))
    for k in range(6):
        s = meshes.lathe("stripe", [(0.135, 0.25 + k * 0.42), (0.135, 0.45 + k * 0.42)], red, c, n=16, subsurf=0)
        s.location = P((0, 0, 0))
    chrome = materials.pbr("chrome", (0.8, 0.82, 0.85), 0.12, Metallic=1.0)
    meshes.ball("poleball", 0.24, chrome, c, loc=P((0, 0, 2.9)))
    arrow_mat = materials.emit("arrowm", (0.1, 0.9, 1.0), 3.0)
    ring = meshes.lathe("spinring", [(2.6 + 0.06 * math.cos(a), 0.12 + 0.03 * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 7)],
                        arrow_mat, c, n=64, subsurf=0)
    ring.location = P((0, 0, 0))
    head = _arrow(c, arrow_mat)
    head.parent = ring
    head.location = (2.6, -1.0, 0.12)
    head.rotation_euler = (0, 0, math.pi / 2)
    head.scale = (0.5, 1.1, 1.1)
    # penguin
    black = materials.pbr("pblack", (0.03, 0.035, 0.05), 0.45, Coat_Weight=0.3)
    orange = materials.pbr("porange", (1.0, 0.5, 0.05), 0.4)
    white_m = materials.pbr("eyewhite", (0.95, 0.95, 0.95), 0.12)
    eye_black = materials.pbr("eyeblack", (0.004, 0.004, 0.004), 0.15)
    spark = materials.emit("spark", (1, 1, 1), 6.0)
    peng = meshes.empty(c, "penguin", loc=P((1.6, -0.6, 0.0)))

    def PG(o, par=None):
        o.parent = par or peng
        return o

    PG(meshes.ball("pbody", 1.0, black, c, loc=(0, 0, 0.62), scale=(0.42, 0.38, 0.62)))
    PG(meshes.ball("pbelly", 1.0, white_m, c, loc=(0, -0.09, 0.58), scale=(0.34, 0.32, 0.52)))
    phead = meshes.empty(c, "phead", peng, (0, 0, 1.22))
    PG(meshes.ball("phd", 0.27, black, c), phead)
    PG(meshes.ball("pface", 1.0, white_m, c, loc=(0, -0.1, -0.02), scale=(0.2, 0.19, 0.19)), phead)
    beak = PG(meshes.lathe("beak", [(0.02, 0.0), (0.075, 0.0), (0.02, 0.2)], orange, c, n=12, sy=0.7, subsurf=0), phead)
    beak.location = (0, -0.24, -0.03)
    beak.rotation_euler = (math.pi / 2, 0, 0)
    for sx in (-1, 1):
        PG(meshes.ball("peye", 0.04, eye_black, c, loc=(sx * 0.1, -0.235, 0.06), nu=10, nv=6), phead)
        PG(meshes.ball("peyehl", 0.014, spark, c, loc=(sx * 0.1 - 0.012, -0.27, 0.075), nu=6, nv=4), phead)
        PG(meshes.ball("pfoot", 1.0, orange, c, loc=(sx * 0.17, -0.12, 0.04), scale=(0.14, 0.22, 0.05)))
    wings = []
    for sx in (-1, 1):
        wp = meshes.empty(c, "wingpiv", peng, (sx * 0.4, 0, 0.95))
        PG(meshes.ball("wing", 1.0, black, c, loc=(sx * 0.04, 0, -0.33), scale=(0.07, 0.17, 0.36)), wp)
        wings.append(wp)
    # sky, low sun, lights, readout
    b.backdrop(materials.backdrop_mat("polesky", (0.85, 0.81, 0.72), (0.3, 0.55, 0.85)), (0, 160, 0), 380)
    meshes.ball("lowsun", 6.0, materials.emit("lowsunm", (1.0, 0.95, 0.75), 3.0), c, loc=P((-40, 150, 22)))
    b.sun("LGT-sunP", (-30, -20, 22), (0, 0, 0), 0.72, (1.0, 0.95, 0.85))
    b.area("LGT-fillP", (12, -12, 4), (0, 0, 1), 1800, 12, (0.7, 0.85, 1.0))
    from .. import stage
    readout = stage.hud_text(c, "txtP0", "0 KM/H", 0.34, text_mats()["y"], 0.8, 0.27, materials.pbr("plate", (0.01, 0.01, 0.03), 0.6))
    readout.location = P((0, 0, 0))  # hidden (scale 0) until a shot pins it to the camera
    return b.handles((1.6, -0.6, 0.9), penguin=peng, head=phead, wings=wings, ring=ring, pole=pole, bergs=bergs,
                     snow=snow, readout=readout)
