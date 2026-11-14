"""Convert Natural Earth admin-0 country GeoJSON into the compact files the map kit loads.

Natural Earth is public domain (licenses/register.json, id naturalearth:admin_0_countries). Standard library only.

  python blender_worker/codebuilt/mapdata/convert_naturalearth.py --src <dir holding ne_110m_admin_0_countries.geojson and
         ne_50m_admin_0_countries.geojson> [--out <this folder>]

Source files: https://github.com/nvkelso/natural-earth-vector/tree/master/geojson (the project's own mirror of
naturalearthdata.com; the default boundary view, nothing edited).

Writes, per detail 110m / 50m:
  countries_<detail>.json  one record per country: iso (ISO_A3, or ADM0_A3 where ISO_A3 is -99: France, Norway, Kosovo ...),
                           iso2, name, continent, subregion, pop, type, disputed, area_km2, centroid [lon, lat] of the
                           largest polygon, bbox, polys (per polygon: list of [start, count] rings, outer ring first), parea
                           (per polygon km2) and pc (per polygon centroid).
  countries_<detail>.bin   little-endian int16 pairs (lon*100, lat*100) for every ring point, rings closed implicitly
                           (the repeated last point is dropped). Resolution 0.01 degrees (about 1 km).
"""
import argparse
import json
import math
import os
import struct

R_KM = 6371.0088
Q = 100  # points are stored as degrees * Q in int16 (180*100 = 18000 < 32767)
# Natural Earth's own TYPE says Disputed or Indeterminate for these; the kit adds the other places whose status is contested.
EXTRA_DISPUTED = {"Somaliland", "N. Cyprus", "Taiwan", "Siachen Glacier"}


def ring_area_km2(ring):
    """Absolute area of a lon/lat ring (degrees) on the sphere (Chamberlain-Duquette; edges are short)."""
    s = 0.0
    n = len(ring)
    for i in range(n):
        l1, p1 = math.radians(ring[i][0]), math.radians(ring[i][1])
        l2, p2 = math.radians(ring[(i + 1) % n][0]), math.radians(ring[(i + 1) % n][1])
        d = l2 - l1
        d = (d + math.pi) % (2 * math.pi) - math.pi
        s += d * (2 + math.sin(p1) + math.sin(p2))
    return abs(s) * R_KM * R_KM / 2


def ring_centroid(ring):
    """Planar centroid of a ring in (lon * cos(mid lat), lat), returned as lon, lat."""
    lat0 = (min(p[1] for p in ring) + max(p[1] for p in ring)) / 2
    k = math.cos(math.radians(lat0))
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0] * k, ring[i][1]
        x2, y2 = ring[(i + 1) % n][0] * k, ring[(i + 1) % n][1]
        w = x1 * y2 - x2 * y1
        a += w
        cx += (x1 + x2) * w
        cy += (y1 + y2) * w
    if abs(a) < 1e-12:
        return ring[0][0], ring[0][1]
    return cx / (3 * a) / k, cy / (3 * a)


def quantize(ring):
    out = []
    for lon, lat in ring[:-1] if ring[0] == ring[-1] else ring:
        q = (int(round(lon * Q)), int(round(lat * Q)))
        if not out or out[-1] != q:
            out.append(q)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def convert(src, dst_json, dst_bin):
    with open(src, encoding="utf-8") as fh:
        feats = json.load(fh)["features"]
    blob = bytearray()
    npts = 0
    countries = []
    for f in feats:
        p = f["properties"]
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        iso = p["ISO_A3"] if p["ISO_A3"] not in ("-99", None) else p["ADM0_A3"]
        iso2 = p["ISO_A2"] if p["ISO_A2"] not in ("-99", None) else ""
        recs, parea, pc = [], [], []
        total = 0.0
        lons, lats = [], []
        for poly in polys:
            rings = []
            for ring in poly:
                q = quantize(ring)
                if len(q) < 3:
                    continue
                rings.append([npts, len(q)])
                for x, y in q:
                    blob += struct.pack("<hh", x, y)
                npts += len(q)
            if not rings:
                continue
            outer = [(blob_x, blob_y) for blob_x, blob_y in ((struct.unpack_from("<hh", blob, 4 * (rings[0][0] + i))) for i in range(rings[0][1]))]
            outer = [(x / Q, y / Q) for x, y in outer]
            a = ring_area_km2(outer)
            for r in rings[1:]:
                hole = [struct.unpack_from("<hh", blob, 4 * (r[0] + i)) for i in range(r[1])]
                a -= ring_area_km2([(x / Q, y / Q) for x, y in hole])
            recs.append(rings)
            parea.append(round(a, 1))
            cx, cy = ring_centroid(outer)
            pc.append([round(cx, 2), round(cy, 2)])
            total += a
            lons += [x for x, _ in outer]
            lats += [y for _, y in outer]
        big = max(range(len(parea)), key=lambda i: parea[i])
        disputed = p["TYPE"] in ("Disputed", "Indeterminate") or p["NAME"] in EXTRA_DISPUTED
        countries.append(dict(
            iso=iso, iso2=iso2, name=p["NAME"], continent=p["CONTINENT"], subregion=p["SUBREGION"],
            pop=int(p["POP_EST"] or 0), type=p["TYPE"], disputed=disputed,
            area_km2=round(total, 1), centroid=pc[big], bbox=[min(lons), min(lats), max(lons), max(lats)],
            polys=recs, parea=parea, pc=pc))
    countries.sort(key=lambda c: c["iso"])
    seen = set()
    for c in countries:
        if c["iso"] in seen:
            raise SystemExit(f"duplicate iso {c['iso']}")
        seen.add(c["iso"])
    with open(dst_bin, "wb") as fh:
        fh.write(blob)
    with open(dst_json, "w", encoding="utf-8") as fh:
        json.dump(dict(source="Natural Earth admin-0 countries (public domain), default boundaries", quant=Q, points=npts,
                       countries=countries), fh, separators=(",", ":"), ensure_ascii=False)
    return len(countries), npts


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default=here)
    a = ap.parse_args()
    for detail in ("110m", "50m"):
        src = os.path.join(a.src, f"ne_{detail}_admin_0_countries.geojson")
        n, pts = convert(src, os.path.join(a.out, f"countries_{detail}.json"), os.path.join(a.out, f"countries_{detail}.bin"))
        print(detail, n, "countries", pts, "points")


if __name__ == "__main__":
    main()
