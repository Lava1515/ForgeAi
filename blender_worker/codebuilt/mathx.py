"""Easing and spline helpers (pure Python + numpy)."""
import numpy as np


def clamp(x, a=0.0, b=1.0):
    return max(a, min(b, x))


def lerp(a, b, u):
    return a + (b - a) * u


def ss(a, b, x):
    """Smoothstep of x between a and b."""
    u = clamp((x - a) / (b - a)) if b != a else float(x >= b)
    return u * u * (3 - 2 * u)


def out_back(u, s=1.9):
    u = clamp(u) - 1
    return 1 + u * u * ((s + 1) * u + s)


def vlerp(a, b, u):
    return tuple(lerp(x, y, u) for x, y in zip(a, b))


def gauss(x, w):
    return np.exp(-(x / w) ** 2)


def catmull_rom(pts, n):
    """Sample n points along a Catmull-Rom spline through pts (at least 2 rows)."""
    P = np.array(pts, float)
    if P.ndim == 1:
        P = P[:, None]
    k = len(P)
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for t in np.linspace(0, k - 1, n):
        i = min(int(t), k - 2)
        u = t - i
        p0, p1, p2, p3 = ext[i], ext[i + 1], ext[i + 2], ext[i + 3]
        out.append(0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                          + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3))
    return np.array(out)
