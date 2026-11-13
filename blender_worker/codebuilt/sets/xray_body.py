"""Set: x-ray body with organs (KAN-911). Ported from the chat body set; runs inside Blender.

A transparent blue ghost (head, neck, torso to the hips, arms) with the digestive tract inside:
esophagus, a J-shaped stomach that is cut open on the camera side, a pool of acid with bubbles,
and decorative small intestine below. The ghost faces -Y; Z is up and the stomach sits near z=-4.
Handles: ghost (list), esophagus, stomach, acid, intestine, bubbles, bubble_params, paths
(dict esophagus, stomach), acid_level, acid_light, cut_mat.
"""
import math

import numpy as np

from .. import materials, meshes
from ..geometry import Path, grid_faces, sphere_verts
from ..mathx import catmull_rom, lerp
from .common import SetBuilder, xray_mat

NAME = "xray_body"
ACID_LVL = -4.08  # local z of the acid surface
EX, EZ = 0.37, 0.16


def _g2(x, z, sx, sz):
    return np.exp(-(x / sx) ** 2 - (z / sz) ** 2)


def _face_bumps(X, Z):
    X, Z = np.asarray(X, float), np.asarray(Z, float)
    ax = np.abs(X)
    return (0.075 * _g2(ax - EX, Z - EZ, 0.2, 0.17) - 0.045 * _g2(ax - EX, Z - 0.44, 0.3, 0.075)
            - 0.035 * _g2(ax - 0.45, Z + 0.22, 0.24, 0.2) - 0.05 * _g2(X, Z + 0.86, 0.26, 0.16)
            - 0.03 * _g2(X, Z + 0.5, 0.3, 0.12))


def _head_verts(p):
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    s = np.clip(-z, 0, 1)
    s = s * s * (3 - 2 * s)
    X, Y, Z = x * 0.94 * (1 - 0.27 * s), y * (1 - 0.10 * s), z * 1.12
    f = np.clip(-Y / 0.4, 0, 1)
    f = f * f * (3 - 2 * f)
    return np.stack([X, Y + _face_bumps(X, Z) * f, Z], 1)


def _ghost(b, mat):
    """Head, neck, torso (to the hips) and two arms, all in the x-ray material."""
    c = b.c
    obs = [meshes.mk("head", b.v(_head_verts(sphere_verts(96, 64))), grid_faces(96, 64, True), mat, c)]
    nk = Path([(0, 0.08, -0.6), (0, 0.06, -1.0), (0, 0.05, -1.5)], [0.4, 0.37, 0.4], 8)
    obs.append(meshes.mk("neck", b.v(nk.verts(nk.R, 28)), grid_faces(28, 8, True), mat, c))
    rings = [(-1.22, 0.03, 0.03), (-1.3, 0.44, 0.42), (-1.45, 0.62, 0.47), (-1.65, 1.2, 0.55), (-1.92, 1.5, 0.63),
             (-2.4, 1.46, 0.72), (-3.1, 1.36, 0.74), (-4.0, 1.3, 0.72), (-5.0, 1.3, 0.74),
             (-6.0, 1.4, 0.78), (-6.9, 1.35, 0.74), (-7.4, 0.9, 0.6)]
    rr = catmull_rom(rings, 44)
    ang = np.linspace(0, 2 * np.pi, 40, endpoint=False)
    tv = np.stack([rr[:, 1][:, None] * np.cos(ang), 0.05 + rr[:, 2][:, None] * np.sin(ang),
                   np.repeat(rr[:, 0][:, None], 40, 1)], -1)
    obs.append(meshes.mk("torso", b.v(tv), grid_faces(40, 44, True), mat, c))
    for sx in (-1, 1):
        ap = Path([(sx * 1.4, 0.05, -1.85), (sx * 1.78, 0.05, -2.4), (sx * 1.96, 0.05, -3.4), (sx * 2.0, 0.0, -4.8), (sx * 2.0, -0.1, -5.6)],
                  [0.37, 0.37, 0.33, 0.28, 0.24], 20)
        obs.append(meshes.mk("arm", b.v(ap.verts(ap.R, 20)), grid_faces(20, 20, True), mat, c))
    return obs


def _organ(b, name, path, nseg, mat, cut, ripple):
    """Half tube (cut open towards the camera) with a thickness that shows the cut colour."""
    o = meshes.mk(name, path.verts(path.R, nseg, 0, np.pi, ripple), grid_faces(nseg, path.n, False), mat, b.c)
    o.data.materials.append(cut)
    sm = o.modifiers.new("solid", 'SOLIDIFY')
    sm.thickness, sm.offset, sm.material_offset_rim, sm.use_rim = -0.035, 1.0, 1, True
    return o


def _acid_verts(gi, acid_n, level, origin, t=0.0):
    """Acid pool vertices in world space; all shaping is done in set-local coordinates."""
    R = np.zeros(gi.n)
    R[:acid_n] = gi.R[:acid_n] * 0.94
    R[acid_n:] = 0.01
    v = gi.verts(R, 84)[: acid_n * 84] - np.array(origin, float)
    v[:, 1] = np.maximum(v[:, 1], 0.004)
    near = np.abs(v[:, 2] - level) < 0.04
    if near.any():
        x0, x1 = v[near, 0].min(), v[near, 0].max()
        up = v[:, 2] > level
        v[up, 0] = np.clip(v[up, 0], x0 + 0.01, x1 - 0.01)
        v[up, 1] = np.minimum(v[up, 1], 0.3)
    wave = level + 0.012 * np.sin(v[:, 0] * 14 + t * 5) + 0.008 * np.sin(v[:, 1] * 20 - t * 7)
    v[:, 2] = np.minimum(v[:, 2], wave)
    return v + np.array(origin, float)


def build(origin=(0.0, 0.0, 0.0)):
    b = SetBuilder(NAME, origin, seed=7)
    c, P, rng = b.c, b.p, b.rng
    ghost = _ghost(b, xray_mat("xray", (0.25, 0.75, 1.0)))
    cut = materials.pbr("cut", (1.0, 0.78, 0.74), 0.5)
    eso_mat = materials.noise_mat("eso", (0.93, 0.50, 0.50), (0.80, 0.33, 0.36), scale=10)
    stom_mat = materials.noise_mat("stom", (0.90, 0.36, 0.38), (0.70, 0.20, 0.25), scale=9, bump=0.5)
    gut_mat = materials.noise_mat("gut", (0.96, 0.60, 0.52), (0.84, 0.42, 0.40), scale=10)

    def world(pts):
        return [P(p) for p in pts]

    ESO = Path(world([(0, -0.62, -0.5), (0, -0.2, -0.62), (0, 0.02, -1.0), (0, 0.05, -1.6), (0.0, 0.05, -2.4), (0.06, 0.03, -3.0), (0.2, 0, -3.3)]),
               [0.16, 0.13, 0.115, 0.11, 0.11, 0.11, 0.11], 90)
    GI = Path(world([(0.2, 0, -3.3), (0.42, 0, -3.5), (0.58, 0, -3.85), (0.54, 0, -4.2), (0.32, 0, -4.46), (0.02, 0, -4.58), (-0.24, 0, -4.58),
                     (-0.52, 0, -4.66), (-0.68, 0, -4.95), (-0.58, 0, -5.3), (-0.3, 0, -5.45), (0.05, 0, -5.45)]),
              [0.11, 0.3, 0.42, 0.44, 0.36, 0.22, 0.105, 0.12, 0.12, 0.12, 0.12, 0.12], 150)
    GI.asym = 0.42 * np.clip((GI.R - 0.13) / 0.25, 0, 1)
    s_pyl = float(GI.s[np.argmin(np.where(GI.s > GI.L * 0.3, GI.R, 9))])
    eso = _organ(b, "eso", ESO, 20, eso_mat, cut, 0.0)
    stom = _organ(b, "stom", GI, 48, stom_mat, cut, 0.035)
    acid_n = int(np.searchsorted(GI.s, s_pyl)) - 5
    acid = meshes.mk("acid", _acid_verts(GI, acid_n, ACID_LVL, b.origin), grid_faces(84, acid_n, True),
                     materials.pbr("acid", (0.55, 0.95, 0.08), 0.06, alpha=0.62, Emission_Color=(0.45, 1.0, 0.05, 1), Emission_Strength=0.35),
                     c, origin=P((0, -1.5, -4)))
    es = acid.modifiers.new("es", 'EDGE_SPLIT')
    es.split_angle = math.radians(35)
    # decorative small intestine
    dp = [(0.05, 0.02, -5.45)]
    for k in range(4):
        d, z = (1 if k % 2 == 0 else -1), -5.47 - 0.3 * k
        dp += [(d * 0.45, 0.03, z), (d * 0.82, 0.03, z - 0.02), (d * 0.96, 0.03, z - 0.16), (d * 0.82, 0.03, z - 0.3)]
    dp += [(0.0, 0.03, -6.68), (-0.5, 0.03, -6.8)]
    DEC = Path(world(dp), [0.12] * len(dp), 220)
    intestine = meshes.mk("decor", DEC.verts(DEC.R * (1 + 0.07 * np.sin(DEC.s * 30)), 16), grid_faces(16, DEC.n, True), gut_mat, c)
    # acid bubbles in the pool (rest pose at phase t=0)
    bm = materials.pbr("abub", (0.85, 1.0, 0.45), 0.05, Emission_Color=(0.7, 1.0, 0.2, 1), Emission_Strength=0.6)
    bubbles = [meshes.ball("abub", 1.0, bm, c, nu=14, nv=8) for _ in range(34)]
    ab = dict(x=rng.uniform(0.2, 1.15, 34), y=rng.uniform(0.05, 0.36, 34), ph=rng.uniform(0, 1, 34),
              sp=rng.uniform(0.25, 0.5, 34), r=rng.uniform(0.012, 0.03, 34))
    for i, bb in enumerate(bubbles):
        u = ab["ph"][i] % 1.0
        z = lerp(-4.62, ACID_LVL - 0.01, u)
        x = ab["x"][i]
        inside = abs(x - 0.66) < 0.44 * math.sqrt(max(0, 1 - ((z + 4.08) / 0.56) ** 2)) - 0.05
        k = ab["r"][i] * math.sin(u * math.pi) ** 0.5 if inside else 0.0
        bb.location = P((x, ab["y"][i] * 0.8, z))
        bb.scale = (k, k, k)
    b.backdrop(materials.backdrop_mat("bd_body", (0.03, 0.10, 0.22), (0.004, 0.012, 0.04)), (0, 6, -3.5), 26)
    b.area("key", (-3, -6, -1.5), (0.3, 0, -4.0), 750, 4, (1.0, 0.93, 0.85))
    b.area("top", (1.5, -2.5, 0.5), (0.4, 0.1, -4.0), 450, 3, (1.0, 0.95, 0.9))
    b.area("fill", (4, -5, -5.5), (0.3, 0, -4.2), 250, 5, (0.6, 0.85, 1.0))
    b.area("low", (-1, -3, -7.5), (0, 0, -5.0), 200, 3, (1.0, 0.7, 0.8))
    acid_light = b.point("LGT-acid", (0.65, -0.25, -4.25), 0.75, (0.6, 1.0, 0.2), radius=0.2)
    b.area("LGT-rimc", (2.5, -1.0, -2.5), (0.6, 0.1, -4.0), 80, 2, (0.5, 0.85, 1.0))
    return b.handles((0.7, 0.0, -4.1), ghost=ghost, esophagus=eso, stomach=stom, acid=acid, intestine=intestine,
                     bubbles=bubbles, bubble_params=ab, paths=dict(esophagus=ESO, stomach=GI), acid_level=ACID_LVL + b.origin[2],
                     acid_light=acid_light, cut_mat=cut)
