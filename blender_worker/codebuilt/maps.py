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

Look (F5, 2026-11-16): dark blue-black sea with the raster's shelves, natural land colours with strengthened hillshading, thin pale
borders. highlight() adds a lighter outline and a soft glow and returns hit["fill"]: call hit["fill"].pose(t) per frame to bring the
fill in (show=0 starts it hidden); color="auto" cycles HIGHLIGHTS; label=True names the country, placed on it or out to sea beside it.
highlight_group(keys, label=...) fills a continent or alliance as one.

Units: one world unit is 1/scale of the unit-sphere radius; the default scale 4.0 puts 1 km at 4/6371 unit and the whole Equal Earth world at
21.7 wide. Every projection returns unit-sphere coordinates, so "true size" means the same thing on every map: km / 6371 * scale.
Projections: "equal_earth" (keeps areas honest; relief=False), "equirectangular" (default; affine raster UVs), "mercator" (latitude clipped at 85 degrees; the classic
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
            "ivory coast": "CIV", "burma": "MMR", "holland": "NLD", "uae": "ARE", "drc": "COD", "congo": "COD", "dr congo": "COD", "d.r. congo": "COD", "democratic republic of congo": "COD", "congo kinshasa": "COD", "czechia": "CZE", "turkey": "TUR", "east timor": "TLS", "swaziland": "SWZ"}


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
# Fill colours for the natural relief map: saturated, far from the land's greens and tans and from the dark sea, and far from each
# other (orange, magenta, cyan, yellow, violet, red). wm.highlight(key, color="auto") takes the next one.
HIGHLIGHTS = ((1.0, 0.42, 0.0), (1.0, 0.08, 0.50), (0.0, 0.78, 1.0), (1.0, 0.86, 0.0), (0.58, 0.22, 1.0), (0.95, 0.04, 0.04))


def _lighter(rgb, k=0.55):
    """rgb moved k of the way to white: the outline colour of a fill."""
    return tuple(v + (1.0 - v) * k for v in rgb)


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
    if palette == "relief":
        _RELIEF_CONTINENT = {
            "Africa": (0.48, 0.44, 0.28),
            "Asia": (0.32, 0.42, 0.26),
            "Europe": (0.28, 0.42, 0.22),
            "North America": (0.32, 0.40, 0.25),
            "South America": (0.22, 0.45, 0.20),
            "Oceania": (0.45, 0.40, 0.25),
        }
        base = _RELIEF_CONTINENT.get(c.continent, (0.32, 0.40, 0.26))
        f = 0.92 + 0.08 * ((sum(ord(ch) for ch in c.iso) * 7) % 4) / 3.0
        return tuple(min(1.0, v * f) for v in base)
    raise ValueError("palette must be 'continents', 'muted', 'flat' or 'relief'")


# ------------------------------------------------------------------------------------------------ the map
class WorldMap:
    """Flat map in the XY plane, north = +Y, centred on `origin` (the projection of 0 E / 0 N sits at the origin plus `shift`).

    c           collection that receives the objects
    detail      "110m" (fast, coarse) or "50m" (small countries, smoother coasts; use it when you zoom in)
    projection  one of PROJECTIONS
    scale       world units per unit-sphere radius (4.0: the world is 21.7 wide)
    thickness   height of the country slabs; border: ribbon width (default 0.009 * scale); sides=False drops the walls
    palette     "relief" (default: the real Natural Earth land colours, graded calm, with strong hillshading), "continents",
                "muted" (calm blue-grey, for a map where one country should pop) or "flat"
    hide        ISO codes to leave out (default Antarctica); only: ISO codes to build and nothing else (faster close-ups);
                bbox=(lon0, lat0, lon1, lat1) keeps countries whose box touches it
    sea_color   deep-water colour (default materials.MAP_SEA, dark blue-black); relief_strength: hillshade boost (0 = raster as is);
                border_color: colour of the thin border lines (default pale)
    Handles: .objs {iso: object}, .sea, .collection, .scale, .origin, .data.
    """

    def __init__(self, c, detail="50m", projection="equirectangular", scale=4.0, origin=(0.0, 0.0, 0.0), thickness=0.04, border=None,
                 sides=True, palette="relief", hide=("ATA",), only=None, bbox=None, sea_color=None, sea_margin=4.0, relief=True,
                 relief_strength=6.0, border_color=None):
        from . import materials, meshes
        if projection not in PROJECTIONS:
            raise ValueError(f"projection must be one of {PROJECTIONS}")
        if relief and projection != "equirectangular":
            raise ValueError("relief requires equirectangular projection; use relief=False for equal_earth/mercator")
        self.relief = relief
        self.relief_strength = float(relief_strength)
        self.c, self.projection, self.scale = c, projection, float(scale)
        self.origin = tuple(float(v) for v in origin)
        self.thickness = float(thickness)
        self.border = float(border) if border is not None else 0.0035 * self.scale
        self._border_set = border is not None      # set_border(0.002 * span) also tells highlight labels the shot width
        self.eps = max(0.004, 0.0015 * self.scale)
        self.sides, self.palette = sides, palette
        self.data = load(detail)
        self.objs, self._shape, self._info = {}, {}, {}
        self._hl, self._labels, self._next_color = {}, [], 0
        self.land_glow = 0.2
        self.border_color = tuple(border_color) if border_color is not None else materials.MAP_BORDER
        self._border_mat = materials.map_outline("map_border", self.border_color, 0.6)
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
        sea_col = tuple(sea_color) if sea_color is not None else materials.MAP_SEA
        sea_mat = materials.map_sea("map_sea", sea_col, geographic=self.relief)
        cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
        hx, hy = (sx1 - sx0) / 2 + mx, (sy1 - sy0) / 2 + my
        sz = self.origin[2] - 0.02
        corners = [(cx - hx, cy - hy, sz), (cx + hx, cy - hy, sz), (cx + hx, cy + hy, sz), (cx - hx, cy + hy, sz)]
        self.sea = meshes.mk("map_sea", corners, [(0, 1, 2, 3)], sea_mat, c, smooth=False)
        if self.relief:
            # Equirectangular is affine, so four corner UVs place the raster's undersea relief exactly under the countries.
            uv = self.sea.data.uv_layers.new(name="earth_lonlat")
            for loop in self.sea.data.loops:
                x, y = corners[loop.vertex_index][:2]
                uv.data[loop.index].uv = self._uv(x, y)
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
        ob = self._mesh(cty.iso, verts, shape, col, (float(cen[0]), float(cen[1]), self.origin[2]), meshes, materials,
                        fill=self.palette != "relief")
        self.objs[cty.iso] = ob
        self._shape[cty.iso] = shape
        flat = np.concatenate(rings)
        self._info[cty.iso] = dict(box=(flat[:, 0].min(), flat[:, 1].min(), flat[:, 0].max(), flat[:, 1].max()), n=shape.n,
                                   top_z=self.thickness, rings=rings, col=col, lift=0.0)

    def _uv(self, x, y):
        """Raster UV of a world (x, y) on an equirectangular map."""
        return ((x - self.origin[0]) / (2 * math.pi * self.scale) + 0.5, (y - self.origin[1]) / (math.pi * self.scale) + 0.5)

    def _mesh(self, name, verts, shape, col, origin, meshes, materials, fill=True):
        """One country mesh. fill: start filled with col (relief map) instead of the natural land colour."""
        if self.relief:
            top = materials.map_land(f"map_{name}", color=col if fill else None, relief=self.relief_strength, glow=self.land_glow)
            side_col = tuple(v * 0.45 for v in col) if fill else (0.10, 0.10, 0.07)
        else:
            top = materials.pbr(f"map_{name}", col, 0.6, Emission_Color=(*col, 1), Emission_Strength=0.05)
            side_col = tuple(v * 0.55 for v in col)
        side = materials.pbr(f"map_{name}_side", side_col, 0.7)
        ob = meshes.mk(f"map_{name}", verts, shape.faces, top, self.c, smooth=False, origin=origin)
        ob.data.materials.append(side)
        ob.data.materials.append(self._border_mat)
        ob.data.polygons.foreach_set("material_index", shape.mat)
        if self.relief:
            # Geographic world coords, never local/object bounds or the sea margin.
            # Equirectangular is affine so UV interpolation is exact even on large triangles.
            uv = ob.data.uv_layers.new(name="earth_lonlat")
            vx, vy = verts[:, 0], verts[:, 1]
            u, v = self._uv(vx, vy)
            idx = np.empty(len(ob.data.loops), dtype=np.int32)
            ob.data.loops.foreach_get("vertex_index", idx)
            uv.data.foreach_set("uv", np.stack([u[idx], v[idx]], axis=1).ravel())
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
        """Colour a country (top face and a darker side). emission raises the glow so it pops in a dim map. On the relief map the
        fill keeps the real hillshading."""
        ob = self.country(key)
        self._paint(ob, rgb, emission, 1.0, self._info[self.data.find(key).iso].get("col"))
        return ob

    def _paint(self, ob, rgb, emission, mix, base=None):
        """Blend a country's top from its plain look (mix 0) to fill rgb (mix 1). Relief land blends in the shader (node hl_mix);
        a plain land colour (relief=False) blends from `base`."""
        from . import materials
        top, side = ob.data.materials[0], ob.data.materials[1]
        nodes = top.node_tree.nodes
        b = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        hl = nodes.get('hl_mix')
        mix = min(1.0, max(0.0, float(mix)))
        if hl is not None:
            nodes['country_tint'].outputs[0].default_value = (*rgb, 1)
            hl.outputs[0].default_value = mix
            materials.set_inputs(b, Emission_Strength=self.land_glow + emission * mix)
            plain = (0.10, 0.10, 0.07)
            sc = tuple(p + (v * 0.45 - p) * mix for p, v in zip(plain, rgb))
        else:
            b0 = tuple(base) if base is not None else tuple(rgb)
            c = tuple(p + (v - p) * mix for p, v in zip(b0, rgb))
            tint = nodes.get('country_tint')
            if tint is not None:
                tint.outputs[0].default_value = (*c, 1)
            materials.set_inputs(b, Base_Color=(*c, 1), Emission_Color=(*c, 1), Emission_Strength=0.05 + (emission - 0.05) * mix)
            sc = tuple(v * 0.55 for v in c)
        materials.set_inputs(next(n for n in side.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), Base_Color=(*sc, 1))

    def restyle(self, palette):
        """Recolour every country with another palette ("relief" on a relief map: back to the natural land colours)."""
        self.palette = palette
        for iso in self.objs:
            col = country_color(self.data.countries[iso], palette)
            self._info[iso]["col"] = col
            if palette == "relief" and self.relief:
                self._paint(self.objs[iso], col, 0.0, 0.0)
            else:
                self.set_color(iso, col, emission=0.05)

    def set_lift(self, key, height):
        """Raise a country's top face (and its border) to thickness + height; the walls stretch. Absolute, so call it per frame.
        A highlight glow follows the face."""
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
        info["lift"] = float(height)
        halo = self._hl.get(iso, {}).get("halo")
        if halo is not None:
            halo.location.z = self.origin[2] + float(height)
        return ob

    def _set_ribbon(self, iso, width):
        """Rewrite one country's border ribbon at `width` (world units)."""
        info = self._info[iso]
        me = self.objs[iso].data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        n, k = info["n"], 0
        org = np.array(self.objs[iso]["origin"][:2])
        for r in info["rings"]:
            co[3 * n + k:3 * n + k + len(r), :2] = _inner_ring(r, Shape._bw(r, width)) - org
            k += len(r)
        me.vertices.foreach_set("co", co.ravel())
        me.update()

    def set_border(self, width):
        """Change the border line width (world units) of every country. Borders are drawn as ribbons inside each outline, so a width that
        suits the world view (the default) is far too thick in a close-up: set about 0.002 * the visible width of the shot.
        Highlight outlines and glows scale with it."""
        self.border = float(width)
        self._border_set = True
        for iso in self._info:
            hl = self._hl.get(iso)
            if hl is None:
                self._set_ribbon(iso, self.border)
            else:
                hl["fill"].pose(hl["fill"].t)

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

    def next_color(self):
        """The next colour of HIGHLIGHTS (cycles), so countries highlighted one after another stay distinguishable."""
        c = HIGHLIGHTS[self._next_color % len(HIGHLIGHTS)]
        self._next_color += 1
        return c

    def highlight(self, key, color=HIGHLIGHT, lift=None, emission=0.25, marker_below_km=900, parts="auto", marker_radius=None,
                  outline=True, glow=True, label=None, label_span=None, show=1.0, outline_width=2.5):
        """Fill, outline, glow and lift a country. On the relief map the fill keeps the hillshading; outline is a crisp ribbon in a lighter
        tint of the fill (2.5x the border width), glow a soft additive halo around it (7x the border width; glow=False drops it, a number
 sets its strength). lift None: min(0.25, 15 x the border width), so a close-up after set_border gets a small step.
        outline_width: outline as a multiple of the border width. color="auto" (or None) takes the next HIGHLIGHTS colour. A country whose box is smaller than marker_below_km on
        the map also gets a marker ring and pin so it stays visible in a world view (marker_radius in world units; the default suits the
        world view, use about 0.05 to 0.1 for a close-up). label: True (the country's name) or a text puts a label on or beside it;
        label_span = maps.view_span(pose) of the shot sizes it (default as in label()). show: start state 0..1 (0 = not shown yet; animate with fill.pose(t)).
        Returns dict(obj, marker or None, fill (Fill: .pose(t) per frame brings it in), label or None, halo or None, color)."""
        from . import materials
        cty = self.data.find(key)
        iso = cty.iso
        if color is None or (isinstance(color, str) and color == "auto"):
            color = self.next_color()
        color = tuple(float(v) for v in color)
        w, h = self.project_size_km(iso, parts)
        mk = self.marker(iso, color, radius=marker_radius) if max(w, h) < marker_below_km else None
        ol_mat = None
        if outline:
            ol_mat = materials.map_outline(f"ol_{iso}", _lighter(color), 2.0)
            self.objs[iso].data.materials[2] = ol_mat
        halo = None
        glow_s = 0.0
        if glow:
            glow_s = 1.6 if glow is True else float(glow)
            halo = self._halo(iso, color)
        lbl = None
        if label:
            text = cty.name if label is True else str(label)
            lbl = self.label(text, iso, span=label_span)
        if lift is None:
            lift = min(0.25, 15.0 * self.border)
        fill = Fill(self, iso, color, lift, emission, ol_mat, halo, glow_s, lbl, mk, outline_width)
        self._hl[iso] = dict(fill=fill, halo=halo, outline=ol_mat)
        fill.pose(show)
        return dict(obj=self.objs[iso], marker=mk, fill=fill, label=lbl, halo=halo, color=color)

    def highlight_group(self, keys, color="auto", lift=None, emission=0.25, label=None, label_at=None, label_span=None, glow=False, show=1.0):
        """One fill for several countries (a continent, an alliance): each gets the fill and a thin lighter outline, no per-country glow
        by default (it would light the inner borders). label: a text placed at label_at (a country key or (lon, lat); default the
        largest country). Returns dict(objs, fills, label, color, pose) where pose(t) brings the whole group in."""
        if color is None or (isinstance(color, str) and color == "auto"):
            color = self.next_color()
        isos = [self.data.find(k).iso for k in keys]
        isos = [i for i in isos if i in self.objs]
        lift = min(0.12, 8.0 * self.border) if lift is None else lift
        hits = [self.highlight(i, color=color, lift=lift, emission=emission, marker_below_km=0, glow=glow, show=show, outline_width=1.0)
                for i in isos]
        for h in hits:      # inner borders of a group: a quiet line in the fill's own tone
            h["fill"].outline_color = _lighter(color, 0.3)
            h["fill"].pose(show)
        lbl = None
        if label:
            at = label_at or max(isos, key=lambda i: self.data.countries[i].area_km2)
            lbl = self.label(str(label), at, span=label_span, side="on")
            lbl.scale = (show,) * 3
        fills = [h["fill"] for h in hits]

        def pose(t):
            for f in fills:
                f.pose(t)
            if lbl is not None:
                lbl.scale = (_pop(t),) * 3
        return dict(objs=[h["obj"] for h in hits], fills=fills, label=lbl, color=color, pose=pose)

    def _halo(self, iso, color):
        """Glow ribbon outside every outer ring of a country (geometry from _halo_verts; width follows the border)."""
        from . import materials, meshes, stage
        verts, faces, vv = self._halo_verts(iso, 7.0 * self.border)
        ob = meshes.mk(f"glow_{iso}", verts, faces, materials.map_glow(f"glow_{iso}", color), self.c, smooth=False,
                       origin=(0.0, 0.0, self.origin[2]))
        uv = ob.data.uv_layers.new(name="glow")
        idx = np.empty(len(ob.data.loops), dtype=np.int32)
        ob.data.loops.foreach_get("vertex_index", idx)
        uv.data.foreach_set("uv", np.stack([np.zeros(len(idx)), vv[idx]], axis=1).ravel())
        _no_shadow(ob)
        stage.mark_scenery(ob)
        ob["glow_n"] = len(verts)
        return ob

    def _halo_verts(self, iso, width):
        info = self._info[iso]
        z = self.origin[2] + info["top_z"] + 2 * self.eps
        vs, faces, vv, k = [], [], [], 0
        for r in info["rings"]:
            if polygon_area_xy(r) <= 0:     # holes (clockwise) get no glow
                continue
            n = len(r)
            out = _inner_ring(r, -width)
            vs.append(np.hstack([r, np.full((n, 1), z)]))
            vs.append(np.hstack([out, np.full((n, 1), z)]))
            vv += [0.0] * n + [1.0] * n
            i = np.arange(n)
            j = (i + 1) % n
            faces += np.stack([k + i, k + j, k + n + j, k + n + i], axis=1).tolist()
            k += 2 * n
        return np.concatenate(vs), [tuple(f) for f in faces], np.array(vv)

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

    def label(self, text, at, size=None, span=None, color=(1, 1, 1), tilt=70.0, lift=None, plate=True, plate_color=(0.02, 0.05, 0.1),
              side="auto"):
        """White text (the kit's display font) on a dark plate, tilted `tilt` degrees up from lying flat (0) to standing (90) toward a camera
        on the south side. `at` is a country key or (lon, lat). Its lower edge floats `lift` above the surface (default 0.3 x size).
        size is the letter height in world units; give span (the width of the frame in world units, see view_span) instead and the size
        is 10 percent of it: capital letters about 70 px tall in the 1080 px wide frame.
        With neither, the span is the one set_border(0.002 * span) was given, else the whole map width.
        side: "on" (the country's centre), "north", "south", "east", "west", or "auto" (default): on the country when the label fits
        inside it and hides little of it, else the side that covers the least: other labels, other highlighted countries, then any
        other land (so labels go out to sea where they can)."""
        from . import materials, meshes, stage
        if size is None:
            if span is None and self._border_set:      # the shot width that set_border(0.002 * span) was given
                span = self.border / 0.002
            if span is None:
                x0, _, x1, _ = self.extent()
                span = x1 - x0
            size = 0.10 * span
        if lift is None:
            lift = 0.3 * size
        box = None
        if isinstance(at, (tuple, list)):
            lon, lat = at
        else:
            cty = self.data.find(at)
            lon, lat = cty.center("auto")
            if cty.iso in self.objs:
                box = self.bounds(cty.iso)
        mat = materials.no_light(materials.emit("lbl_" + text[:12], color, 1.2))
        t = stage.text(self.c, "label_" + text[:24], text, size, mat, (0.0, 0.0, 0.0), extrude=0.0)
        t.data.bevel_depth = 0.0
        t.rotation_euler = (math.radians(tilt), 0.0, 0.0)
        _no_shadow(t)
        import bpy
        bpy.context.view_layer.update()
        pad_x, pad_y = size * 0.35, size * 0.25
        w = t.dimensions.x + 2 * pad_x
        hp = (t.dimensions.y + 2 * pad_y) * max(0.15, math.cos(math.radians(tilt)))   # depth of the label on the map plane
        cx, cy = (float(v) for v in self.xy(lon, lat))
        px, py = self._place_label(cx, cy, w, hp, size, lift, box, side, at)
        z = self.origin[2] + self.thickness + lift + 0.75 * size * math.sin(math.radians(tilt))
        t.location = (px, py, z)
        self._labels.append((px - w / 2, py - hp / 2, px + w / 2, py + hp / 2))
        if plate:
            hw, hh = t.dimensions.x / 2 + pad_x, t.dimensions.y / 2 + pad_y
            pm = materials.no_light(materials.pbr("lbl_plate", plate_color, 0.8, Emission_Color=(*plate_color, 1), Emission_Strength=0.5))
            pl = meshes.mk("label_plate_" + text[:24], [(-hw, -hh, -0.05 * size), (hw, -hh, -0.05 * size), (hw, hh, -0.05 * size), (-hw, hh, -0.05 * size)],
                           [(0, 1, 2, 3)], pm, self.c, smooth=False)
            pl.parent = t
            _no_shadow(pl)
        return t

    def _place_label(self, cx, cy, w, hp, size, lift, box, side, at):
        if box is None or side == "on":
            return cx, cy
        x0, y0, x1, y1 = box
        gap = 0.3 * size
        rise = (lift + size) * 0.4        # a standing label leans north on screen: keep more room on the south side
        spots = {"north": (cx, y1 + gap + hp / 2), "south": (cx, y0 - gap - rise - hp / 2),
                 "east": (x1 + gap + w / 2, cy), "west": (x0 - gap - w / 2, cy)}
        if side in spots:
            return spots[side]
        if side != "auto":
            raise ValueError("side must be 'auto', 'on', 'north', 'south', 'east' or 'west'")
        own = None if isinstance(at, (tuple, list)) else self.data.find(at).iso
        cands = [(cx, cy)] if (w <= 0.6 * (x1 - x0) and hp <= 0.35 * (y1 - y0)) else []   # on it only if it hides little of it
        cands += [spots["north"], spots["south"], spots["east"], spots["west"]]
        best, best_score = cands[0], None
        for k, (px, py) in enumerate(cands):
            rect = (px - w / 2, py - hp / 2, px + w / 2, py + hp / 2)
            lab = sum(_rect_overlap(rect, r) for r in self._labels) / (w * hp)
            land, hl = self._cover(rect, own)
            score = 10.0 * lab + 5.0 * hl + 1.0 * land + 0.02 * k
            if best_score is None or score < best_score:
                best, best_score = (px, py), score
        return best

    def _cover(self, rect, own):
        """Fractions of a 7 x 4 grid of points in rect that fall on another country (any) and on another highlighted country."""
        gx = np.linspace(rect[0], rect[2], 7)
        gy = np.linspace(rect[1], rect[3], 4)
        px, py = [a.ravel() for a in np.meshgrid(gx, gy)]
        on_land = np.zeros(px.shape, bool)
        on_hl = np.zeros(px.shape, bool)
        for iso, info in self._info.items():
            if iso == own:
                continue
            bx = info["box"]
            if bx[0] > rect[2] or bx[2] < rect[0] or bx[1] > rect[3] or bx[3] < rect[1]:
                continue
            inside = np.zeros(px.shape, bool)
            for r in info["rings"]:
                inside ^= _in_ring(px, py, r)
            on_land |= inside
            if iso in self._hl:
                on_hl |= inside
        return float(on_land.mean()), float(on_hl.mean())

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
        self.set_material_glow(ob, color, emission + (self.land_glow if self.relief else 0.0))
        return Mover(ob, vh, vd, lift, (float(hx), float(hy)), (float(tx), float(ty)), shape.n)

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
            if not math.isfinite(span) or span <= 0:
                raise ValueError("span must be finite and positive")
            need_w, need_h = span, 0.0
        else:
            need_w, need_h = max(w * margin, min_span), h * margin
        d = max(need_w / 2 / hh, need_h / 2 * math.sin(el) / hv) if span is not None else max(need_w / 2 / hh, need_h / 2 * math.sin(el) / hv, min_span / 2 / hh)
        tgt = (cx, cy + up, self.origin[2] + self.thickness)
        az = math.radians(azimuth)
        pos = (tgt[0] + d * math.cos(el) * math.sin(az), tgt[1] - d * math.cos(el) * math.cos(az), tgt[2] + d * math.sin(el))
        return pos, tgt, lens

    def world_view(self, tilt=82.0, lens=35.0, margin=1.08):
        """Pose that fits the whole map width in the frame."""
        x0, y0, x1, y1 = self.extent()
        return self.view(None, tilt=tilt, lens=lens, span=(x1 - x0) * margin, center=((x0 + x1) / 2, (y0 + y1) / 2))


def _rect_overlap(a, b):
    return max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))


def _in_ring(px, py, ring):
    """Even-odd point-in-ring test, vectorised over points."""
    x, y = ring[:, 0], ring[:, 1]
    x2, y2 = np.roll(x, -1), np.roll(y, -1)
    X, Y, X2, Y2 = (v[:, None] for v in (x, y, x2, y2))
    cross = (Y > py[None, :]) != (Y2 > py[None, :])
    dy = np.where(np.abs(Y2 - Y) < 1e-12, 1e-12, Y2 - Y)
    xi = X + (py[None, :] - Y) * (X2 - X) / dy
    return (np.count_nonzero(cross & (px[None, :] < xi), axis=0) % 2) == 1


def _no_shadow(ob):
    try:
        ob.visible_shadow = False
    except Exception as ex:  # property differs across Blender versions
        print("shadow flag skipped:", ex)


def view_span(pose):
    """Width in world units of the 1080 px frame at the target of a view() pose (use it for label size and border width)."""
    pos, tgt, lens = np.array(pose[0], float), np.array(pose[1], float), pose[2]
    return 2.0 * float(np.linalg.norm(pos - tgt)) * math.tan(math.atan(18.0 / lens)) * ASPECT


def _smooth(t):
    e = min(1.0, max(0.0, float(t)))
    return e * e * (3 - 2 * e)


def _pop(t):
    """Scale for a label popping in: 0 -> a 12 percent overshoot -> 1 (t 0..1)."""
    e = min(1.0, max(0.0, float(t)))
    return e if e >= 1.0 else _smooth(e) * (1.0 + 0.12 * math.sin(math.pi * e))


class Fill:
    """A highlighted country's reveal, made by WorldMap.highlight. pose(t), t 0..1 (smoothstep): the fill blends in over the natural land,
    the country rises to its lift, the border ribbon widens into the lighter outline, the glow fades in and the label pops in. Absolute:
    call it per frame. .t is the last pose."""

    def __init__(self, wm, iso, color, lift, emission, outline, halo, glow, label, marker, outline_width=2.5):
        self.wm, self.iso, self.color, self.lift, self.emission = wm, iso, color, float(lift), float(emission)
        self.outline_width, self.outline_color = float(outline_width), _lighter(color)
        self.outline, self.halo, self.glow, self.label, self.marker = outline, halo, glow, label, marker
        self.t = None

    def pose(self, t):
        wm = self.wm
        e = _smooth(t)
        self.t = float(t)
        ob = wm.objs[self.iso]
        wm._paint(ob, self.color, self.emission, e, wm._info[self.iso].get("col"))
        wm.set_lift(self.iso, self.lift * e)
        if self.outline is not None:
            em = next(n for n in self.outline.node_tree.nodes if n.type == 'EMISSION')
            oc, bc = self.outline_color, wm.border_color
            em.inputs[0].default_value = (*[b + (o - b) * e for b, o in zip(bc, oc)], 1)
            em.inputs[1].default_value = 0.6 + (2.0 - 0.6) * e
            wm._set_ribbon(self.iso, wm.border * (1.0 + (self.outline_width - 1.0) * e))
        if self.halo is not None:
            from . import meshes
            v, _, _ = wm._halo_verts(self.iso, 7.0 * wm.border)
            if len(v) == self.halo["glow_n"]:
                meshes.set_verts(self.halo, v)
            self.halo.material_slots[0].material.node_tree.nodes["glow_strength"].inputs[1].default_value = self.glow * e
            self.halo.hide_render = e <= 0.0
        if self.label is not None:
            s = _pop(t)
            self.label.scale = (s, s, s)
            self.label.hide_render = s <= 0.0
            for ch in self.label.children:
                ch.hide_render = s <= 0.0
        if self.marker is not None:
            self.marker.show(e > 0.0)
        return ob


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
        """Place the copy at progress t (smoothstep eased). It rises by arc * sin(pi * e) on the way and rests the `lift` given to moving() plus hold_lift above the map surface, so it never lies in the same plane as the country under it."""
        from . import meshes
        e = min(1.0, max(0.0, t))
        e = e * e * (3 - 2 * e)
        v = self.home + (self.dest - self.home) * e
        v[:, 2] += arc * math.sin(math.pi * e) + self.float_z + hold_lift
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
        ratio = round(ca.area_km2 / cb.area_km2, 2) if cb.area_km2 > 0 else None
        out.update(other=cb.name, other_area_km2=_round2(cb.area_km2), ratio=ratio)
    return out


def _round2(v):
    if v <= 0:
        return 0
    e = 10 ** (int(math.floor(math.log10(v))) - 1)
    val = round(v / e) * e
    return int(val) if val >= 10 else round(val, max(0, 1 - int(math.floor(math.log10(v)))))
