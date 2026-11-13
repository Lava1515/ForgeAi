"""Figure rigs: a simple posable person from spheres on pivot empties (runs inside Blender)."""
import math

from mathutils import Euler, Vector

from .materials import col
from .meshes import ball, empty

SKINS = [(0.90, 0.62, 0.48), (0.62, 0.40, 0.27), (0.38, 0.24, 0.16), (0.96, 0.76, 0.62)]
SHIRTS = [(0.9, 0.2, 0.15), (0.15, 0.45, 0.85), (0.95, 0.75, 0.1), (0.2, 0.65, 0.35),
          (0.6, 0.25, 0.7), (0.95, 0.5, 0.1), (0.9, 0.9, 0.9)]
PANTS = [(0.1, 0.15, 0.35), (0.2, 0.2, 0.22), (0.45, 0.33, 0.2), (0.3, 0.35, 0.4)]
HAIRS = [(0.1, 0.05, 0.02), (0.02, 0.02, 0.02), (0.55, 0.35, 0.1), (0.8, 0.7, 0.4)]


def palette(i):
    """Skin, shirt, pants, hair colours for figure number i (deterministic)."""
    return SKINS[i % 4], SHIRTS[i % 7], PANTS[i % 4], HAIRS[(i * 3) % 4]


def make_person(c, i):
    """Figure with torso, hips, head, hair, eyes and arm/leg pivots. Returns the rig dict."""
    skin, shirt, pants, hair = palette(i)
    sk, sh, pa, ha = col(skin, 0.5), col(shirt, 0.75), col(pants, 0.8), col(hair, 0.6)
    black = col((0.02, 0.02, 0.02), 0.5)
    root = empty(c, "person")

    def P(o, par=None):
        o.parent = par or root
        return o

    P(ball("torso", 1.0, sh, c, loc=(0, 0, 1.14), scale=(0.25, 0.17, 0.36), nu=16, nv=10))
    P(ball("hips", 1.0, pa, c, loc=(0, 0, 0.86), scale=(0.23, 0.165, 0.17), nu=16, nv=8))
    P(ball("head", 0.2, sk, c, loc=(0, 0, 1.64), nu=20, nv=12))
    P(ball("hair", 0.212, ha, c, loc=(0, 0.015, 1.655), nu=20, nv=8, lat0=8, lat1=89.6))
    for sx in (-1, 1):
        P(ball("eye", 0.026, black, c, loc=(sx * 0.07, -0.186, 1.66), nu=8, nv=6))
    arms, legs = [], []
    for sx in (-1, 1):
        pv = empty(c, "armpiv", root, (sx * 0.3, 0, 1.4))
        P(ball("arm", 1.0, sh, c, loc=(0, 0, -0.27), scale=(0.075, 0.075, 0.3), nu=12, nv=8), pv)
        P(ball("hand", 0.07, sk, c, loc=(0, 0, -0.56), nu=10, nv=6), pv)
        arms.append(pv)
        pl = empty(c, "legpiv", root, (sx * 0.12, 0, 0.84))
        P(ball("leg", 1.0, pa, c, loc=(0, 0, -0.4), scale=(0.095, 0.095, 0.41), nu=12, nv=8), pl)
        P(ball("shoe", 1.0, black, c, loc=(0, -0.05, -0.79), scale=(0.1, 0.17, 0.07), nu=10, nv=6), pl)
        legs.append(pl)
    return dict(root=root, arms=arms, legs=legs)


def pose(fig, pos, eul, arms=(0, 0.12, 0, 0.12), legs=(0, 0), s=1.0, center=False):
    """Place a person. arms = (left swing, left out, right swing, right out); legs = swings.
    center=True puts pos at the body centre instead of the feet."""
    r = fig["root"]
    r.rotation_euler = eul
    r.scale = (s, s, s)
    r.location = (Vector(pos) - (Euler(eul).to_matrix() @ Vector((0, 0, 1.0))) * s) if center else pos
    fig["arms"][0].rotation_euler = (arms[0], -arms[1], 0)
    fig["arms"][1].rotation_euler = (arms[2], arms[3], 0)
    fig["legs"][0].rotation_euler = (legs[0], 0, 0)
    fig["legs"][1].rotation_euler = (legs[1], 0, 0)


def flail(t, sp=9.0):
    """(arms, legs) tuples for pose(): arms thrown up and flapping, legs kicking."""
    arms = (-2.4 + 0.6 * math.sin(t * sp), 0.6 + 0.3 * math.sin(t * sp * 0.7),
            -2.4 + 0.6 * math.sin(t * sp + 2), 0.6 + 0.3 * math.cos(t * sp * 0.8))
    legs = (0.7 * math.sin(t * sp * 0.8), -0.7 * math.sin(t * sp * 0.8))
    return arms, legs
