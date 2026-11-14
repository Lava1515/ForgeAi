"""Map kit: a flat world or region map of real country shapes (runs inside Blender; the data and projection math need only numpy).

Shapes come from Natural Earth admin-0 countries (public domain, default boundaries), converted by mapdata/convert_naturalearth.py
into a small JSON + int16 file per detail (110m: 177 countries, 50m: 242). Loading takes milliseconds; nothing is parsed at render time.

    from blender_worker.codebuilt import maps
    wm = maps.WorldMap(c, detail="50m", palette="muted")          # one mesh object per country, in collection c
    hit = wm.highlight("BRA", color=(1.0, 0.55, 0.1), lift=0.25)   # lift + colour; a small country also gets a marker ring
    wm.label("Brazil", "BRA", size=0.9, tilt=70)
    mv = wm.moving("BRA", to="RUS")                                # Brazil at true size on top of Russia
    mv.pose(t)                                                     # t 0..1, call per frame
    cam.set(*maps.fly(wm.view("BRA"), wm.view("RUS"), t))          # camera flight between two views

Units: one world unit is 1/scale of the unit-sphere radius; the default scale 4.0 puts 1 km at 4/6371 unit and the whole Equal Earth world at
21.7 wide. Every projection returns unit-sphere coordinates, so "true size" means the same thing on every map: km / 6371 * scale.
Projections: "equal_earth" (default, keeps areas honest), "equirectangular", "mercator" (latitude clipped at 85 degrees; the classic
distortion for a size comparison). True-size moves use a Lambert azimuthal equal-area projection around the country's own centre (area exact,
shape error small up to a hemisphere), then place that shape at the target in the map plane at the scale above.
Antarctica is skipped by default (hide=("ATA",)). Natural Earth marks some places as disputed (Country.disputed); do not feature them.
"""
import functools
import json
import math
import os

import numpy as np

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mapdata")
R_KM = 6371.0088
PROJECTIONS = ("equal_earth", "equirectangular", "mercator")
SENSOR = 36.0
ASPECT = 1080 / 1920

# ------------------------------------------------------------------------------------------------ data
_ALIASES = {"usa": "USA", "us": "USA", "united states": "USA", "america": "USA", "uk": "GBR", "britain": "GBR", "great britain": "GBR",
            "england": "GBR", "russian federation": "RUS", "south korea": "KOR", "north korea": "PRK", "czech republic": "CZE",
            "ivory coast": "CIV", "burma": "MMR", "holland": "NLD", "uae": "ARE", "drc": "COD", "congo": "COD", "swaziland": "SWZ"}


class Country:
    """One country: iso (ISO 3166 alpha-3, or Natural Earth's code for France, Norway, Kosovo ...), iso2, name, continent, subregion, pop,
    disputed, area_km2 (from the generalised shape, about +-10 percent), centroid (lon, lat of the largest polygon), bbox, and polygons."""

    def __init__(self, rec, pts):
        self.__dict__.update(rec)
        self._pts = pts

    def __repr__(self):
        return f"<Country {self.iso} {self.name} {self.area_km2:.0f} km2>"

    def parts(self, mode="auto"):
        """Indices of the polygons to use. "all"; "main" (the largest one); "auto" (default): the main polygon plus every polygon that has
        at least 3 percent of the area and lies within 5000 km of it, so France is the mainland without French Guiana, Indonesia keeps its
        big islands and Hawaii or Svalbard-sized pieces are dropped."""
        n = len(self.polys)
        if mode == "all":
            return list(range(n))
        main = int(np.argmax(self.parea))
        if mode == "main":
            return [main]
        if mode != "auto":
            raise ValueError("parts must be 'auto', 'main' or 'all'")
        total = float(sum(self.parea)) or 1.0
        keep = [main]
        for i in range(n):
            if i != main and self.parea[i] >= 0.03 * total and _gc_km(self.pc[i], self.pc[main]) <= 5000:
                keep.append(i)
        return sorted(keep)

    def polygons(self, parts="auto"):
        """[[ring (N,2) float array of lon, lat degrees, ...] per polygon]; the first ring of a polygon is its outer ring, the rest holes."""
        out = []
        for i in self.parts(parts):
            out.append([self._pts[s:s + n].astype(float) / self._q for s, n in self.polys[i]])
        return out

    def center(self, parts="auto"):
        """(lon, lat) centre of the chosen parts: area-weighted mean direction of the polygon centroids."""
        idx = self.parts(parts)
        v = np.zeros(3)
        for i in idx:
            lo, la = math.radians(self.pc[i][0]), math.radians(self.pc[i][1])
            v += self.parea[i] * np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
        n = np.linalg.norm(v)
        if n < 1e-9:
            return tuple(self.centroid)
        v /= n
        return math.degrees(math.atan2(v[1], v[0])), math.degrees(math.asin(max(-1.0, min(1.0, v[2]))))

    @property
    def tiny(self):
        return self.area_km2 < 20000


def _gc_km(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    d = math.sin(la1) * math.sin(la2) + math.cos(la1) * math.cos(la2) * math.cos(math.radians(a[0] - b[0]))
    return R_KM * math.acos(max(-1.0, min(1.0, d)))


class MapData:
    def __init__(self, detail):
        with open(os.path.join(DATA_DIR, f"countries_{detail}.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        pts = np.fromfile(os.path.join(DATA_DIR, f"countries_{detail}.bin"), dtype="<i2").reshape(-1, 2)
        self.detail = detail
        self.countries = {}
        for rec in doc["countries"]:
            c = Country(rec, pts)
            c._q = float(doc["quant"])
            self.countries[c.iso] = c
        self._names = {}
        for c in self.countries.values():
            self._names[c.name.casefold()] = c.iso
            if c.iso2:
                self._names.setdefault(c.iso2.casefold(), c.iso)

    def __iter__(self):
        return iter(self.countries.values())

    def find(self, key):
        """Country by ISO alpha-3 ("FRA"), ISO alpha-2 ("FR"), English name ("France") or a common alias ("USA", "UK")."""
        if isinstance(key, Country):
            return key
        k = str(key).strip()
        if k.upper() in self.countries:
            return self.countries[k.upper()]
        iso = _ALIASES.get(k.casefold()) or self._names.get(k.casefold())
        if iso in self.countries:
            return self.countries[iso]
        near = sorted(n for n in (c.name for c in self.countries.values()) if k.casefold()[:4] in n.casefold())[:6]
        raise KeyError(f"unknown country {key!r} in the {self.detail} data" + (f"; did you mean {near}" if near else ""))


@functools.lru_cache(maxsize=2)
def load(detail="50m"):
    """The country data for "110m" (177 countries, coarse) or "50m" (242 countries incl. small ones such as Singapore, Malta, Monaco)."""
    if detail not in ("110m", "50m"):
        raise ValueError("detail must be '110m' or '50m'")
    return MapData(detail)


# ------------------------------------------------------------------------------------------------ projections
_A1, _A2, _A3, _A4 = 1.340264, -0.081106, 0.000893, 0.003796


def project(name, lon, lat):
    """Degrees -> unit-sphere map coordinates (x east, y north) for a named projection. Arrays or scalars."""
    lam, phi = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    if name == "equal_earth":
        th = np.arcsin(np.sqrt(3) / 2 * np.sin(phi))
        t2, t6 = th ** 2, th ** 6
        x = 2 * np.sqrt(3) * lam * np.cos(th) / (3 * (9 * _A4 * t6 * t2 + 7 * _A3 * t6 + 3 * _A2 * t2 + _A1))
        y = th * (_A1 + _A2 * t2 + _A3 * t6 + _A4 * t6 * t2)
        return x, y
    if name == "equirectangular":
        return lam, phi
    if name == "mercator":
        p = np.clip(phi, -math.radians(85), math.radians(85))
        return lam, np.log(np.tan(math.pi / 4 + p / 2))
    raise ValueError(f"projection must be one of {PROJECTIONS}")


def laea_km(lon, lat, lon0, lat0):
    """Lambert azimuthal equal-area about (lon0, lat0): kilometres east and north of that point. Area is exact."""
    lam, phi = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    l0, p0 = math.radians(lon0), math.radians(lat0)
    dl = lam - l0
    den = 1 + math.sin(p0) * np.sin(phi) + math.cos(p0) * np.cos(phi) * np.cos(dl)
    k = np.sqrt(2.0 / np.maximum(den, 1e-9))
    x = R_KM * k * np.cos(phi) * np.sin(dl)
    y = R_KM * k * (math.cos(p0) * np.sin(phi) - math.sin(p0) * np.cos(phi) * np.cos(dl))
    return x, y


def polygon_area_xy(xy):
    x, y = xy[:, 0], xy[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


# ------------------------------------------------------------------------------------------------ geometry
def _orient(ring, ccw):
    """Return (ring, flipped) with the wanted winding."""
    if (polygon_area_xy(ring) > 0) != ccw:
        return ring[::-1], True
    return ring, False


def _inner_ring(ring, w):
    """Ring moved inward (to the left of travel for a counter-clockwise outer ring or a clockwise hole) by w, with a mitre clamp."""
    e = np.roll(ring, -1, axis=0) - ring
    ln = np.maximum(np.linalg.norm(e, axis=1), 1e-12)
    u = e / ln[:, None]
    left = np.stack([-u[:, 1], u[:, 0]], axis=1)
    nrm = left + np.roll(left, 1, axis=0)
    nl = np.maximum(np.linalg.norm(nrm, axis=1), 1e-9)
    nrm = nrm / nl[:, None]
    scale = 1.0 / np.maximum((nrm * left).sum(axis=1), 0.5)
    return ring + nrm * (w * scale)[:, None]


def _tessellate(rings):
    """Triangle indices (into the concatenation of rings) of a polygon with holes. Needs Blender's mathutils."""
    from mathutils import Vector, geometry
    loops = [[Vector((float(x), float(y), 0.0)) for x, y in r] for r in rings]
    return [tuple(t) for t in geometry.tessellate_polygon(loops)]


class Shape:
    """Vertex/face arrays of one country (top face, side walls, border ribbon). Vertex layout, N ring points in all:
    [0,N) top, [N,2N) bottom, [2N,3N) ribbon outer edge, [3N,4N) ribbon inner edge. Material slots: 0 top, 1 side, 2 border."""

    def __init__(self, faces, mat, n, rings):
        self.faces, self.mat, self.n, self.rings = faces, mat, n, rings

    def verts(self, rings_xy, top_z, border_w, eps):
        """4N x 3 vertex array for ring positions rings_xy (same structure as at construction, already flipped to match)."""
        n = self.n
        pts = np.concatenate(rings_xy) if rings_xy else np.zeros((0, 2))
        inner = np.empty_like(pts)
        k = 0
        for r in rings_xy:
            inner[k:k + len(r)] = _inner_ring(r, self._bw(r, border_w))
            k += len(r)
        z = lambda v: np.full((n, 1), float(v))  # noqa: E731
        return np.concatenate([np.hstack([pts, z(top_z)]), np.hstack([pts, z(0.0)]),
                               np.hstack([pts, z(top_z + eps)]), np.hstack([inner, z(top_z + eps)])])

    @staticmethod
    def _bw(ring, w):
        return min(w, 0.2 * math.sqrt(abs(polygon_area_xy(ring))))


def _assemble(polys_a, sides=True):
    """Topology from polygons polys_a (list of polygons, each a list of (N,2) rings). Returns (Shape, rings_a, flips, kept): every ring wound
    outer counter-clockwise / holes clockwise, the flip flag of each kept ring (so a second set of rings with the same structure can be
    wound alike) and the indices of the polygons kept. A polygon the tessellator cannot fill (area off by more than 5 percent: a sliver, a
    self-touching ring) is left out, the rest of the country stays."""
    parts = []
    for pi, poly in enumerate(polys_a):
        wound, fl = [], []
        for k, r in enumerate(poly):
            rr, f = _orient(np.asarray(r, float), ccw=(k == 0))
            wound.append(rr)
            fl.append(f)
        want = abs(polygon_area_xy(wound[0])) - sum(abs(polygon_area_xy(h)) for h in wound[1:])
        if want <= 1e-12:
            continue
        flat = np.concatenate(wound)
        tris, got = [], 0.0
        for t in _tessellate(wound):
            a, b, c = flat[t[0]], flat[t[1]], flat[t[2]]
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            got += abs(cross) / 2
            tris.append(t if cross >= 0 else (t[0], t[2], t[1]))
        if abs(got - want) > 0.05 * want:
            continue
        parts.append((pi, wound, fl, tris))
    rings_a, flips, faces, mat, meta, kept = [], [], [], [], [], []
    ntot = sum(len(r) for _, w, _, _ in parts for r in w)
    start = 0
    for pi, wound, fl, tris in parts:
        kept.append(pi)
        base = start
        for t in tris:
            faces.append((base + t[0], base + t[1], base + t[2]))
            mat.append(0)
        for rr, f in zip(wound, fl):
            meta.append((start, len(rr)))
            rings_a.append(rr)
            flips.append(f)
            start += len(rr)
    for s0, n in meta:
        i = np.arange(n)
        j = (i + 1) % n
        if sides:
            for q in np.stack([ntot + s0 + i, ntot + s0 + j, s0 + j, s0 + i], axis=1).tolist():
                faces.append(tuple(q))
                mat.append(1)
        for q in np.stack([2 * ntot + s0 + i, 2 * ntot + s0 + j, 3 * ntot + s0 + j, 3 * ntot + s0 + i], axis=1).tolist():
            faces.append(tuple(q))
            mat.append(2)
    return Shape(faces, mat, ntot, meta), rings_a, flips, kept


def _wind_like(polys_b, flips):
    out, k = [], 0
    for poly in polys_b:
        wound = []
        for r in poly:
            r = np.asarray(r, float)
            wound.append(r[::-1] if flips[k] else r)
            k += 1
        out.append(wound)
    return out


def _poly_flat(polys):
    return [np.asarray(r, float) for p in polys for r in p]


# ------------------------------------------------------------------------------------------------ palette
_CONTINENT = {"Africa": (0.93, 0.72, 0.33), "Asia": (0.52, 0.78, 0.42), "Europe": (0.42, 0.62, 0.92), "North America": (0.92, 0.52, 0.42),
              "South America": (0.78, 0.46, 0.82), "Oceania": (0.30, 0.78, 0.72)}
HIGHLIGHT = (1.0, 0.55, 0.08)


def _shade(iso):
    return 0.86 + 0.14 * ((sum(ord(ch) for ch in iso) * 7) % 4) / 3.0


def country_color(c, palette):
    if palette == "continents":
        base = _CONTINENT.get(c.continent, (0.75, 0.8, 0.85))
        f = _shade(c.iso)
        return tuple(min(1.0, v * f) for v in base)
    if palette == "muted":
        f = 0.9 + 0.1 * ((sum(ord(ch) for ch in c.iso) * 7) % 4) / 3.0
        return tuple(v * f for v in (0.30, 0.38, 0.47))
    if palette == "flat":
        return (0.34, 0.42, 0.52)
    raise ValueError("palette must be 'continents', 'muted' or 'flat'")


# ------------------------------------------------------------------------------------------------ the map
class WorldMap:
    """Flat map in the XY plane, north = +Y, centred on `origin` (the projection of 0 E / 0 N sits at the origin plus `shift`).

    c           collection that receives the objects
    detail      "110m" (fast, coarse) or "50m" (small countries, smoother coasts; use it when you zoom in)
    projection  one of PROJECTIONS
    scale       world units per unit-sphere radius (4.0: the world is 21.7 wide)
    thickness   height of the country slabs; border: ribbon width (default 0.009 * scale); sides=False drops the walls
    palette     "continents", "muted" (calm blue-grey, for a map where one country should pop) or "flat"
    hide        ISO codes to leave out (default Antarctica); only: ISO codes to build and nothing else (faster close-ups);
                bbox=(lon0, lat0, lon1, lat1) keeps countries whose box touches it
    Handles: .objs {iso: object}, .sea, .collection, .scale, .origin, .data.
    """

    def __init__(self, c, detail="50m", projection="equal_earth", scale=4.0, origin=(0.0, 0.0, 0.0), thickness=0.08, border=None,
                 sides=True, palette="continents", hide=("ATA",), only=None, bbox=None, sea_color=(0.05, 0.16, 0.30), sea_margin=4.0):
        from . import materials, meshes
        if projection not in PROJECTIONS:
            raise ValueError(f"projection must be one of {PROJECTIONS}")
        self.c, self.projection, self.scale = c, projection, float(scale)
        self.origin = tuple(float(v) for v in origin)
        self.thickness = float(thickness)
        self.border = float(border) if border is not None else 0.0065 * self.scale
        self.eps = max(0.004, 0.0015 * self.scale)
        self.sides, self.palette = sides, palette
        self.data = load(detail)
        self.objs, self._shape, self._info = {}, {}, {}
        self._border_mat = materials.pbr("map_border", (0.04, 0.06, 0.09), 0.9)
        want = {self.data.find(k).iso for k in only} if only else None
        skip = {self.data.find(k).iso for k in hide} if hide else set()
        for cty in self.data:
            if cty.iso in skip or (want is not None and cty.iso not in want):
                continue
            if bbox is not None and not (cty.bbox[0] <= bbox[2] and cty.bbox[2] >= bbox[0] and cty.bbox[1] <= bbox[3] and cty.bbox[3] >= bbox[1]):
                continue
            self._add(cty, materials, meshes)
        sx0, sy0, sx1, sy1 = self.extent()
        mx, my = (sx1 - sx0) * sea_margin, (sy1 - sy0) * sea_margin
        sea_mat = materials.pbr("map_sea", sea_color, 0.95, Emission_Color=(*sea_color, 1), Emission_Strength=0.12)
        cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        hx, hy = (sx1 - sx0) / 2 + mx, (sy1 - sy0) / 2 + my
        self.sea = meshes.mk("map_sea", [(cx - hx, cy - hy, -0.02), (cx + hx, cy - hy, -0.02), (cx + hx, cy + hy, -0.02), (cx - hx, cy + hy, -0.02)],
                             [(0, 1, 2, 3)], sea_mat, c, smooth=False)
        from . import stage
        stage.mark_scenery(self.sea)

    # ---- coordinates
    def xy(self, lon, lat):
        """World (x, y) of lon/lat degrees (arrays allowed)."""
        px, py = project(self.projection, lon, lat)
        return self.origin[0] + px * self.scale, self.origin[1] + py * self.scale

    def point(self, lon, lat, z=0.0):
        """World (x, y, z) of a lon/lat, z above the map surface."""
        x, y = self.xy(lon, lat)
        return (float(x), float(y), self.origin[2] + self.thickness + float(z))

    def extent(self):
        """(x0, y0, x1, y1) world box of everything built."""
        x0 = y0 = 1e18
        x1 = y1 = -1e18
        for iso in self.objs:
            a, b, c2, d = self._info[iso]["box"]
            x0, y0, x1, y1 = min(x0, a), min(y0, b), max(x1, c2), max(y1, d)
        return x0, y0, x1, y1

    def _rings_world(self, cty, parts):
        return [[np.stack(self.xy(r[:, 0], r[:, 1]), axis=1) for r in poly] for poly in cty.polygons(parts)]

    def _add(self, cty, materials, meshes):
        polys = self._rings_world(cty, "all")
        polys = [p for p in polys if len(p[0]) >= 3]
        polys = [[r for r in p if len(r) >= 3] for p in polys]
        if not polys:
            return
        shape, rings, _, _ = _assemble(polys, self.sides)
        if not rings:
            return
        col = country_color(cty, self.palette)
        verts = shape.verts(rings, self.thickness, self.border, self.eps)
        verts[:, 2] += self.origin[2]
        cen = np.concatenate(rings).mean(axis=0)
        ob = self._mesh(cty.iso, verts, shape, col, (float(cen[0]), float(cen[1]), self.origin[2]), meshes, materials)
        self.objs[cty.iso] = ob
        self._shape[cty.iso] = shape
        flat = np.concatenate(rings)
        self._info[cty.iso] = dict(box=(flat[:, 0].min(), flat[:, 1].min(), flat[:, 0].max(), flat[:, 1].max()), n=shape.n,
                                   top_z=self.thickness, rings=rings)

    def _mesh(self, name, verts, shape, col, origin, meshes, materials):
        top = materials.pbr(f"map_{name}", col, 0.6, Emission_Color=(*col, 1), Emission_Strength=0.05)
        side = materials.pbr(f"map_{name}_side", tuple(v * 0.55 for v in col), 0.7)
        ob = meshes.mk(f"map_{name}", verts, shape.faces, top, self.c, smooth=False, origin=origin)
        ob.data.materials.append(side)
        ob.data.materials.append(self._border_mat)
        ob.data.polygons.foreach_set("material_index", shape.mat)
        ob.data.update()
        return ob

    # ---- styling
    def country(self, key):
        """The mesh object of a country (by ISO code or name)."""
        iso = self.data.find(key).iso
        if iso not in self.objs:
            raise KeyError(f"{iso} was not built in this map (hide/only/bbox)")
        return self.objs[iso]

    def set_color(self, key, rgb, emission=0.05):
        """Colour a country (top face and a darker side). emission raises the glow so it pops in a dim map."""
        from . import materials
        ob = self.country(key)
        top, side = ob.data.materials[0], ob.data.materials[1]
        materials.set_inputs(next(n for n in top.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'),
                             Base_Color=(*rgb, 1), Emission_Color=(*rgb, 1), Emission_Strength=emission)
        materials.set_inputs(next(n for n in side.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), Base_Color=(*[v * 0.55 for v in rgb], 1))
        return ob

    def restyle(self, palette):
        """Recolour every country with another palette."""
        self.palette = palette
        for iso in self.objs:
            self.set_color(iso, country_color(self.data.countries[iso], palette), emission=0.05)

    def set_lift(self, key, height):
        """Raise a country's top face (and its border) to thickness + height; the walls stretch. Absolute, so call it per frame."""
        iso = self.data.find(key).iso
        ob = self.country(iso)
        info = self._info[iso]
        me = ob.data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        n = info["n"]
        base = info["top_z"] + float(height)
        co[:n, 2] = base
        co[2 * n:4 * n, 2] = base + self.eps
        me.vertices.foreach_set("co", co.ravel())
        me.update()
        return ob

    def set_border(self, width):
        """Change the border line width (world units) of every country. Borders are drawn as ribbons inside each outline, so a width that
        suits the world view (the default) is far too thick in a close-up: set about 0.002 * the visible width of the shot."""
        self.border = float(width)
        for iso, info in self._info.items():
            me = self.objs[iso].data
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            n, k = info["n"], 0
            org = np.array(self.objs[iso]["origin"][:2])
            for r in info["rings"]:
                co[3 * n + k:3 * n + k + len(r), :2] = _inner_ring(r, Shape._bw(r, self.border)) - org
                k += len(r)
            me.vertices.foreach_set("co", co.ravel())
            me.update()

    def project_size_km(self, key, parts="auto"):
        """Width and height in km of the country's bounding box on the map (parts as in Country.parts)."""
        x0, y0, x1, y1 = self.bounds(key, parts)
        k = R_KM / self.scale
        return (x1 - x0) * k, (y1 - y0) * k

    def bounds(self, key, parts="auto"):
        """World (x0, y0, x1, y1) box of the chosen parts."""
        cty = self.data.find(key)
        pts = np.concatenate([r for poly in self._rings_world(cty, parts) for r in poly])
        return float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max())

    def highlight(self, key, color=HIGHLIGHT, lift=0.25, emission=0.25, marker_below_km=900, parts="auto", marker_radius=None):
        """Colour and lift a country. A country whose box is smaller than marker_below_km on the map also gets a marker ring and pin so it
        stays visible in a world view (marker_radius in world units; the default suits the world view, use about 0.05 to 0.1 for a close-up).
        Returns dict(obj, marker or None)."""
        cty = self.data.find(key)
        self.set_color(cty.iso, color, emission=emission)
        self.set_lift(cty.iso, lift)
        w, h = self.project_size_km(cty.iso, parts)
        mk = self.marker(cty.iso, color, radius=marker_radius) if max(w, h) < marker_below_km else None
        return dict(obj=self.objs[cty.iso], marker=mk)

    def marker(self, key, color=HIGHLIGHT, radius=None, height=None):
        """Pin with a flat ring at a country (or a (lon, lat)): for small countries and islands. radius defaults to 7 percent of the
        map width; height of the pin to twice that. Returns a Marker (.root, .ring, .pin; .ping(t) pulses the ring)."""
        from . import materials, meshes
        if isinstance(key, (tuple, list)):
            lon, lat = key
            name = f"{lon:.1f}_{lat:.1f}"
        else:
            cty = self.data.find(key)
            lon, lat = cty.center("auto")
            name = cty.iso
        x0, _, x1, _ = self.extent()
        r = radius if radius is not None else 0.07 * (x1 - x0) / 2
        ht = height if height is not None else 2.0 * r
        px, py, pz = self.point(lon, lat, 0.0)
        m = materials.emit(f"mk_{name}", color, 1.0)
        root = meshes.empty(self.c, f"marker_{name}", loc=(px, py, pz))
        prof = [(0.0, 0.0), (0.18 * r, 0.0), (0.04 * r, ht * 0.92), (0.0, ht)]
        pin = meshes.lathe(f"pin_{name}", prof, m, self.c, n=16, subsurf=0)
        pin.parent = root
        head = meshes.ball(f"pinhead_{name}", 0.34 * r, m, self.c, loc=(0, 0, ht), nu=20, nv=10)
        head.parent = root
        ring = meshes.lathe(f"ring_{name}", [(r * 0.86, 0.0), (r, 0.0), (r, 0.03 * r + 0.01), (r * 0.86, 0.03 * r + 0.01)], m, self.c, n=48, subsurf=0)
        ring.parent = root
        return Marker(root, ring, pin, head, r)

    def label(self, text, at, size=None, span=None, color=(1, 1, 1), tilt=70.0, lift=0.5, plate=True, plate_color=(0.02, 0.05, 0.1)):
        """Flat white text on a dark plate, tilted `tilt` degrees up from lying flat (0) to standing (90) toward a camera on the south side.
        `at` is a country key or (lon, lat). Its lower edge floats `lift` above the surface. size is the letter height in world units; give span (the
        width of the frame in world units, see view_span) instead and the size is 10 percent of it: capital letters about 70 px tall in the 1080 px wide frame."""
        from . import materials, meshes, stage
        if size is None:
            if span is None:
                x0, _, x1, _ = self.extent()
                span = x1 - x0
            size = 0.10 * span
        if isinstance(at, (tuple, list)):
            lon, lat = at
        else:
            lon, lat = self.data.find(at).center("auto")
        px, py, pz = self.point(lon, lat, lift + 0.75 * size * math.sin(math.radians(tilt)))
        mat = materials.emit("lbl_" + text[:12], color, 1.2)
        t = stage.text(self.c, "label_" + text[:24], text, size, mat, (px, py, pz), extrude=0.0)
        t.data.bevel_depth = 0.0
        t.rotation_euler = (math.radians(tilt), 0.0, 0.0)
        _no_shadow(t)
        if plate:
            import bpy
            bpy.context.view_layer.update()
            w, h = t.dimensions.x / 2 + size * 0.35, t.dimensions.y / 2 + size * 0.25
            pm = materials.pbr("lbl_plate", plate_color, 0.8)
            pl = meshes.mk("label_plate_" + text[:24], [(-w, -h, -0.05 * size), (w, -h, -0.05 * size), (w, h, -0.05 * size), (-w, h, -0.05 * size)],
                           [(0, 1, 2, 3)], pm, self.c, smooth=False)
            pl.parent = t
            _no_shadow(pl)
        return t

    # ---- true size
    def moving(self, key, to, parts="auto", rotation=0.0, name=None, color=HIGHLIGHT, emission=0.25, lift=0.25):
        """A copy of a country that can slide from its home onto another place at true size. `to` is a country key or (lon, lat).
        The copy is rebuilt around the country's own centre in an equal-area projection, so its size stays honest wherever it lands,
        even on a map (like mercator) that stretches the real thing. Returns a Mover; call .pose(t) per frame (0 = home, 1 = arrived)."""
        from . import materials, meshes
        cty = self.data.find(key)
        lon0, lat0 = cty.center(parts)
        polys = cty.polygons(parts)
        if isinstance(to, (tuple, list)):
            tlon, tlat = to
        else:
            tlon, tlat = self.data.find(to).center("auto")
        home = [[np.stack(self.xy(r[:, 0], r[:, 1]), axis=1) for r in poly] for poly in polys]
        tx, ty = self.xy(tlon, tlat)
        ca, sa = math.cos(math.radians(rotation)), math.sin(math.radians(rotation))
        k = self.scale / R_KM
        dest = []
        for poly in polys:
            rr = []
            for r in poly:
                x, y = laea_km(r[:, 0], r[:, 1], lon0, lat0)
                rr.append(np.stack([tx + (x * ca - y * sa) * k, ty + (x * sa + y * ca) * k], axis=1))
            dest.append(rr)
        shape, rings_d, flips, kept = _assemble(dest, self.sides)
        rings_h = _poly_flat(_wind_like([home[i] for i in kept], flips))
        vd = shape.verts(rings_d, self.thickness, self.border, self.eps)
        vh = shape.verts(rings_h, self.thickness, self.border, self.eps)
        for v in (vd, vh):
            v[:, 2] += self.origin[2]
        hx, hy = self.xy(lon0, lat0)
        nm = name or f"mv_{cty.iso}"
        ob = self._mesh(nm, vh, shape, color, (float(hx), float(hy), self.origin[2]), meshes, materials)
        self.set_material_glow(ob, color, emission)
        return Mover(ob, vh, vd, self.thickness + lift, (float(hx), float(hy)), (float(tx), float(ty)), shape.n)

    @staticmethod
    def set_material_glow(ob, color, emission):
        from . import materials
        materials.set_inputs(next(n for n in ob.data.materials[0].node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), Emission_Strength=emission)

    # ---- camera
    def view(self, at, tilt=72.0, azimuth=0.0, lens=35.0, margin=1.3, min_span=1.5, span=None, parts="auto", up=0.0, center=None):
        """Camera pose (pos, target, lens) that frames a country (key) or a (lon, lat) in the 1080x1920 frame.
        tilt: degrees above the horizon (90 = straight down); azimuth: 0 looks north from the south, 90 from the east.
        The country's box (parts as in Country.parts) is fitted with `margin`; a small country is framed at least min_span wide so
        its neighbours are visible. span: force the visible width in world units. up: moves the target north, in world units."""
        if center is not None:
            cx, cy = center
            w = h = 0.0
        elif isinstance(at, (tuple, list)):
            cx, cy = self.xy(*at)
            w = h = 0.0
        else:
            x0, y0, x1, y1 = self.bounds(at, parts)
            cx, cy, w, h = (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0
        hv = math.tan(math.atan(18.0 / lens))          # tan(half vertical field)
        hh = hv * ASPECT                              # tan(half horizontal field)
        el = math.radians(tilt)
        if span is not None:
            need_w, need_h = span, 0.0
        else:
            need_w, need_h = max(w * margin, min_span), h * margin
        d = max(need_w / 2 / hh, need_h / 2 * math.sin(el) / hv, min_span / 2 / hh)
        tgt = (cx, cy + up, self.origin[2] + self.thickness)
        az = math.radians(azimuth)
        pos = (tgt[0] + d * math.cos(el) * math.sin(az), tgt[1] - d * math.cos(el) * math.cos(az), tgt[2] + d * math.sin(el))
        return pos, tgt, lens

    def world_view(self, tilt=82.0, lens=35.0, margin=1.08):
        """Pose that fits the whole map width in the frame."""
        x0, y0, x1, y1 = self.extent()
        return self.view(None, tilt=tilt, lens=lens, span=(x1 - x0) * margin, center=((x0 + x1) / 2, (y0 + y1) / 2))


def _no_shadow(ob):
    try:
        ob.visible_shadow = False
    except Exception as ex:  # property differs across Blender versions
        print("shadow flag skipped:", ex)


def view_span(pose):
    """Width in world units of the 1080 px frame at the target of a view() pose (use it for label size and border width)."""
    pos, tgt, lens = np.array(pose[0], float), np.array(pose[1], float), pose[2]
    return 2.0 * float(np.linalg.norm(pos - tgt)) * math.tan(math.atan(18.0 / lens)) * ASPECT


class Marker:
    """Pin with a flat ring. ping(t) grows the ring from its size to 3x and shrinks it away: t is seconds-free, 0..1 per pulse."""

    def __init__(self, root, ring, pin, head, radius):
        self.root, self.ring, self.pin, self.head, self.radius = root, ring, pin, head, radius

    def ping(self, t):
        t = t % 1.0
        s = 1.0 + 2.0 * t
        self.ring.scale = (s, s, max(0.0, 1.0 - t))
        return self.ring

    def show(self, on=True):
        for o in (self.root, self.ring, self.pin, self.head):
            o.hide_render = not on
            o.hide_viewport = not on


class Mover:
    """A country copy moving between its home place on the map and a target at true size. pose(t): t 0 at home, 1 arrived."""

    def __init__(self, obj, home, dest, float_z, home_xy, dest_xy, n):
        self.obj, self.home, self.dest, self.float_z = obj, home, dest, float_z
        self.home_xy, self.dest_xy, self.n = home_xy, dest_xy, n

    def pose(self, t, arc=0.6, hold_lift=0.0):
        """Place the copy at progress t (smoothstep eased). It rises by arc * sin(pi * e) on the way and rests hold_lift above the map."""
        from . import meshes
        e = min(1.0, max(0.0, t))
        e = e * e * (3 - 2 * e)
        v = self.home + (self.dest - self.home) * e
        v[:, 2] += arc * math.sin(math.pi * e) + hold_lift
        meshes.set_verts(self.obj, v)
        return self.obj


# ------------------------------------------------------------------------------------------------ camera flight
def fly(pose_a, pose_b, t, arc=0.35):
    """Camera pose between two view() poses at t 0..1 (smoothstep). Position and target blend; mid-flight the camera rises by arc times the
    longer of the two camera distances, so a hop from one country to another pulls back and then dives in. Returns (pos, target, lens)."""
    e = min(1.0, max(0.0, t))
    e = e * e * (3 - 2 * e)
    pa, ta, la = (np.array(pose_a[0], float), np.array(pose_a[1], float), pose_a[2])
    pb, tb, lb = (np.array(pose_b[0], float), np.array(pose_b[1], float), pose_b[2])
    pos = pa + (pb - pa) * e
    tgt = ta + (tb - ta) * e
    dist = max(np.linalg.norm(pa - ta), np.linalg.norm(pb - tb))
    pos = pos + np.array([0.0, 0.0, arc * dist * math.sin(math.pi * e)])
    return tuple(pos.tolist()), tuple(tgt.tolist()), la + (lb - la) * e


def facts(a, b=None, detail="50m"):
    """Narration facts from the data: name, area in km2 (rounded to 2 significant digits, the shapes are generalised), and for two countries
    the ratio. Say 'about'; the numbers are from simplified outlines."""
    d = load(detail)
    ca = d.find(a)
    out = dict(name=ca.name, area_km2=_round2(ca.area_km2), continent=ca.continent, disputed=ca.disputed)
    if b is not None:
        cb = d.find(b)
        out.update(other=cb.name, other_area_km2=_round2(cb.area_km2), ratio=round(ca.area_km2 / cb.area_km2, 2))
    return out


def _round2(v):
    if v <= 0:
        return 0
    e = 10 ** (int(math.floor(math.log10(v))) - 1)
    return int(round(v / e) * e)
