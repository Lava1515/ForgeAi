"""Pure mesh geometry: vertex and face arrays, no Blender needed."""
import numpy as np

from .mathx import catmull_rom, clamp


def grid_faces(nu, nv, wrap):
    """Quads for an nu x nv vertex grid; wrap joins the last column to the first."""
    f = []
    for j in range(nv - 1):
        for i in range(nu if wrap else nu - 1):
            i2 = (i + 1) % nu
            f.append((j * nu + i, j * nu + i2, (j + 1) * nu + i2, (j + 1) * nu + i))
    return f


def grid_verts(nu, nv, fn):
    """Vertices of an nu x nv grid; fn(u, v), u and v in [0,1], returns (x, y, z)."""
    return np.array([fn(i / max(nu - 1, 1), j / max(nv - 1, 1))
                     for j in range(nv) for i in range(nu)], float)


def sphere_verts(nu=40, nv=20, lat0=-89.6, lat1=89.6):
    """Unit-sphere vertices, rows from lat1 down to lat0, nu columns around."""
    lat = np.radians(np.linspace(lat1, lat0, nv))
    lon = np.linspace(0, 2 * np.pi, nu, endpoint=False)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1).reshape(-1, 3)


def lathe_verts(profile, n=48, sy=1.0):
    """Revolve a (radius, height) profile around Z; sy stretches the Y axis."""
    prof = np.array(profile, float)
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([prof[:, 0][:, None] * np.cos(ang),
                     prof[:, 0][:, None] * np.sin(ang) * sy,
                     np.repeat(prof[:, 1][:, None], n, 1)], -1).reshape(-1, 3)


def box_geometry(size):
    """Corner vertices and quad faces of a box with half-extents size."""
    sx, sy, sz = size
    corners = [(x, y, z) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    idx = {c: i for i, c in enumerate(corners)}
    v = np.array([(x * sx, y * sy, z * sz) for x, y, z in corners], float)
    f = [
        (idx[-1, -1, -1], idx[-1, -1, 1], idx[-1, 1, 1], idx[-1, 1, -1]),
        (idx[1, -1, -1], idx[1, 1, -1], idx[1, 1, 1], idx[1, -1, 1]),
        (idx[-1, -1, -1], idx[1, -1, -1], idx[1, -1, 1], idx[-1, -1, 1]),
        (idx[-1, 1, -1], idx[-1, 1, 1], idx[1, 1, 1], idx[1, 1, -1]),
        (idx[-1, -1, -1], idx[-1, 1, -1], idx[1, 1, -1], idx[1, -1, -1]),
        (idx[-1, -1, 1], idx[1, -1, 1], idx[1, 1, 1], idx[-1, 1, 1]),
    ]
    return v, f


class Path:
    """Arc-length resampled spline with per-point radius, for sweeping tubes."""

    def __init__(self, pts, radii, n):
        d = catmull_rom(pts, 600)
        r = np.clip(catmull_rom(radii, 600)[:, 0], 0.01, None)
        seg = np.linalg.norm(np.diff(d, axis=0), axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)])
        self.L = float(cum[-1])
        self.s = np.linspace(0, self.L, n)
        self.P = np.stack([np.interp(self.s, cum, d[:, k]) for k in range(3)], 1)
        self.R = np.interp(self.s, cum, r)
        self.n = n
        T = np.gradient(self.P, axis=0)
        self.T = T / np.linalg.norm(T, axis=1)[:, None]
        ref = np.array([0, 1.0, 0]) if abs(self.T[0][1]) < 0.9 else np.array([1.0, 0, 0])
        n1 = ref - (self.T @ ref)[:, None] * self.T
        self.n1 = n1 / np.linalg.norm(n1, axis=1)[:, None]
        self.n2 = np.cross(self.T, self.n1)
        self.asym = np.zeros(n)

    def at(self, s):
        s = clamp(s, 0, self.L)
        return np.array([np.interp(s, self.s, self.P[:, k]) for k in range(3)])

    def r_at(self, s):
        return float(np.interp(clamp(s, 0, self.L), self.s, self.R))

    def verts(self, R, nseg, a0=0.0, a1=2 * np.pi, ripple=0.0, rk=9):
        """Tube vertices (n * nseg, 3) for radius array R; a0..a1 selects an arc."""
        full = abs(a1 - a0 - 2 * np.pi) < 1e-6
        phi = np.linspace(a0, a1, nseg, endpoint=not full)
        rr = (np.asarray(R)[:, None]
              * (1 + ripple * np.sin(rk * phi[None, :] + 4 * np.sin(self.s[:, None] * 5.0)))
              * (1 + self.asym[:, None] * np.cos(phi)[None, :]))
        return (self.P[:, None, :] + rr[:, :, None] * (np.cos(phi)[None, :, None] * self.n2[:, None, :]
                + np.sin(phi)[None, :, None] * self.n1[:, None, :])).reshape(-1, 3)
