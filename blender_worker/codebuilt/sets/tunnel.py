"""Set: tunnel (KAN-911). Ported from the chat hole-through-the-Earth tunnel; runs inside Blender.

A 90-unit rocky tube along Z (radius 3, ripple every 2.5 so scrolling it reads as speed), glowing
discs at both ends, floating dust, an astronaut figure and readout text. Scroll `tunnel` along Z
modulo `period`; recolour it through `ramp` (a ColorRamp node: element 1 light, element 0 dark).
Handles: tunnel, period, ramp, rock_mat, deep_mat, deep_discs, figure, dust, dust_params, key, glow, readouts.
"""
import math

import numpy as np

from .. import figures, materials, meshes, stage
from ..geometry import grid_faces
from .common import SetBuilder, rockmat, text_mats

NAME = "tunnel"
PERIOD = 2.5


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, rng = b.c, b.p, b.rng
    zz = np.linspace(-45, 45, 721)
    tun = meshes.lathe("tun", [(3.0 * (1 + 0.045 * math.sin(2 * math.pi * z / PERIOD) + 0.02 * math.sin(z * 1.7)), z) for z in zz],
                       None, c, n=40, subsurf=0)
    rock = rockmat("tunmat", (0.4, 0.26, 0.16), (0.2, 0.13, 0.08), 0.9, 1.0)
    tun.data.materials.append(rock)
    tun.location = P((0, 0, 0))
    ramp = next(n for n in rock.node_tree.nodes if n.type == 'VALTORGB')
    rock["ramp"] = ramp.name
    deep_mat = materials.emit("deep", (1, 0.5, 0.1), 4.0)
    quad = [(-4, -4, 0), (4, -4, 0), (4, 4, 0), (-4, 4, 0)]
    deep = meshes.mk("deepdisc", quad, [(0, 1, 2, 3)], deep_mat, c, smooth=False)
    deep2 = meshes.mk("deepdisc2", quad, [(0, 3, 2, 1)], deep_mat, c, smooth=False)
    deep.location, deep2.location = P((0, 0, -44)), P((0, 0, 44))
    fig = figures.make_person(c, 1)
    figures.pose(fig, P((0, 0, 0)), (math.radians(-68), 0, 0.6), center=True)
    dust_mat = materials.emit("dust", (1, 0.8, 0.5), 3.0)
    dust = [meshes.ball("dust", 1.0, dust_mat, c, nu=6, nv=4) for _ in range(70)]
    dp = dict(a=rng.uniform(0, 2 * np.pi, 70), r=rng.uniform(0.9, 2.8, 70), z=rng.uniform(0, 18, 70), s=rng.uniform(0.012, 0.035, 70))
    for i, d in enumerate(dust):  # rest pose: dust spread through the first 18 units
        d.location = P((dp["r"][i] * math.cos(dp["a"][i]), dp["r"][i] * math.sin(dp["a"][i]), dp["z"][i] - 9))
        d.scale = (dp["s"][i],) * 3
    key = b.point("LGT-tkey", (1, -2, 2), 400, (1, 1, 1))
    glow = b.point("LGT-tglow", (0, 0, -4), 600, (1, 0.5, 0.1))
    tm, plate = text_mats(), materials.pbr("plate", (0.01, 0.01, 0.03), 0.6)
    readouts = [stage.hud_text(c, "txtS", "0 KM/H", 0.3, tm["y"], 0.95, 0.24, plate),
                stage.hud_text(c, "txtBig", "28,000 KM/H", 0.3, tm["y"], 1.1, 0.24, plate),
                stage.hud_text(c, "txt0", "0 KG", 0.4, tm["w"], 0.62, 0.32, plate)]
    for r in readouts:  # hidden (scale 0) until a shot pins them to the camera
        r.location = P((0, 0, 0))
    return b.handles((0.0, 0.0, 0.0), tunnel=tun, period=PERIOD, ramp=ramp, rock_mat=rock, deep_mat=deep_mat,
                     deep_discs=(deep, deep2), figure=fig, dust=dust, dust_params=dp, key=key, glow=glow, readouts=readouts)
