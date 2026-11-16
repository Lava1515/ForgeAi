"""Set: globe (KAN-911). Ported from the chat globe set; runs inside Blender.

Tilted Earth sphere (radius 5) showing the real Earth: the bundled Natural Earth shaded relief raster (public domain) on geographic UVs, so real continents, coasts and seas are where they belong. A few thin clouds, a glowing equator ring, an x-ray atmosphere,
a hidden shock ring, a star field and a space card behind. Spin by rotating `globe` about Z; it starts with longitude 0 (Africa and Europe) facing the camera on the -Y side.
To bring a place to the camera set `globe.rotation_euler.z = h["face_lon"](lon)` (east positive, so the Amazon is about -60 and India about 78), and to put a marker on a real place
parent it to `globe` and place it at `h["lonlat"](lon, lat)` (r=5.0 by default; pass r=5.1 to float it above the surface). `h["real_earth"]` is False only when the raster file is missing; then the old noise-painted Earth is used.
Build options: globe.build(origin, relief=True, clouds=True). Handles: axis, globe, equator, atmosphere, shock, stars, clouds, lonlat, face_lon, real_earth.
"""
import math

import numpy as np

from .. import materials, meshes
from .common import SetBuilder, earth_mat, earth_surface, face_lon, lonlat_point, ring_profile, star_field, xray_mat

NAME = "globe"


RADIUS = 5.0
SUN_REAL = 7000


def build(origin=(0.0, 0.0, 0.0), relief=True, clouds=True):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, rng = b.c, b.p, b.rng
    axis = meshes.empty(c, "axis", loc=P((0, 0, 0)))
    axis.rotation_euler = (0, math.radians(23), 0)
    # The real Earth is the default. The noise Earth stays only for a missing raster (or relief=False).
    globe = meshes.ball("globe", RADIUS, None if relief else earth_mat(), c, nu=128, nv=64)
    globe.parent = axis
    real_earth = bool(relief) and earth_surface(globe)
    globe.rotation_euler = (0, 0, face_lon(0.0))
    cloud_mat = materials.col((1, 1, 1), 0.9, Emission_Color=(1, 1, 1, 1), Emission_Strength=0.7)
    clouds_enabled = clouds
    clouds = []
    # Over the real Earth only a few clouds, so they never hide the place a shot is about.
    for _ in range((8 if real_earth else 26) if clouds_enabled else 0):
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
    # The raster is much lighter than the noise paint: 21 kW burnt the Sahara to white in the Cycles proof still.
    b.area("LGT-sunG", (-14, -16, 10), (0, 0, 0), SUN_REAL if real_earth else 21000, 10, (1.0, 0.97, 0.9))
    b.area("LGT-rimG", (12, 6, -6), (0, 0, 0), 6300, 8, (0.4, 0.6, 1.0))
    return b.handles((0.0, -5.0, 0.0), axis=axis, globe=globe, equator=equator, atmosphere=atmosphere,
                     shock=shock, stars=stars, clouds=clouds, real_earth=real_earth, face_lon=face_lon,
                     lonlat=lambda lon, lat, r=RADIUS: lonlat_point(lon, lat, r))
