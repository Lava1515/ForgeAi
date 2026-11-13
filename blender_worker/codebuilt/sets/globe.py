"""Set: globe (KAN-911). Ported from the chat globe set; runs inside Blender.

Tilted Earth sphere (radius 5) with clouds, a glowing equator ring, an x-ray atmosphere,
a hidden shock ring, a star field and a space card behind. Spin the `axis` child by rotating
`globe` and `equator` about Z. Handles: axis, globe, equator, atmosphere, shock, stars, clouds.
"""
import math

import numpy as np

from .. import materials, meshes
from .common import SetBuilder, earth_mat, ring_profile, star_field, xray_mat

NAME = "globe"


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, rng = b.c, b.p, b.rng
    axis = meshes.empty(c, "axis", loc=P((0, 0, 0)))
    axis.rotation_euler = (0, math.radians(23), 0)
    globe = meshes.ball("globe", 5.0, earth_mat(), c, nu=96, nv=48)
    globe.parent = axis
    cloud_mat = materials.col((1, 1, 1), 0.9, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.7)
    clouds = []
    for _ in range(26):
        a, la, s_ = rng.uniform(0, 2 * np.pi), rng.uniform(-1.0, 1.0), rng.uniform(0.5, 1.3)
        cl = meshes.ball("gcloud", 1.0, cloud_mat, c,
                         loc=(5.08 * math.cos(la) * math.cos(a), 5.08 * math.cos(la) * math.sin(a), 5.08 * math.sin(la)),
                         scale=(s_ * 0.8, s_ * 0.45, 0.05), nu=10, nv=6)
        cl.rotation_euler = (0, math.pi / 2 - la, a)
        cl.parent = globe
        clouds.append(cl)
    equator = meshes.lathe("equator", ring_profile(5.22, 0.06), materials.emit("eq", (1.0, 0.8, 0.1), 3.0), c, n=96, subsurf=0)
    equator.parent = axis
    atmosphere = meshes.ball("gatmo", 5.2, xray_mat("gatmo", (0.3, 0.6, 1.0)), c, loc=P((0, 0, 0)), nu=64, nv=32)
    shock = meshes.lathe("shock", ring_profile(5.4, 0.12), materials.emit("shockm", (1, 1, 1), 5.0), c, n=96, subsurf=0)
    shock.parent = axis
    shock.scale = (1, 1, 0)  # flat until a shot grows it
    stars = star_field(b, 420, 45, 50, 45, (0.04, 0.16), materials.emit("spark", (1, 1, 1), 6.0))
    b.backdrop(materials.backdrop_mat("bd_space", (0.04, 0.05, 0.16), (0.0, 0.0, 0.02)), (0, 46, 0), 70)
    b.area("LGT-sunG", (-14, -16, 10), (0, 0, 0), 21000, 10, (1.0, 0.97, 0.9))
    b.area("LGT-rimG", (12, 6, -6), (0, 0, 0), 6300, 8, (0.4, 0.6, 1.0))
    return b.handles((0.0, -5.0, 0.0), axis=axis, globe=globe, equator=equator, atmosphere=atmosphere,
                     shock=shock, stars=stars, clouds=clouds)
