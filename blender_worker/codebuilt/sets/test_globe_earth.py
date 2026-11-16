"""Fix lane F1 (2026-11-16): the globe must show the real Earth the right way round. Pure Python, no Blender.

Damage guarded: a mirrored or shifted Earth on a map channel (every place in the wrong spot)."""
import os

import numpy as np

from blender_worker.codebuilt import geometry
from blender_worker.codebuilt.sets.common import face_lon, lonlat_point, lonlat_uvs

RASTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mapdata", "ne2_50m_sr_w_4096.jpg")


def _uv(lon, lat):
    return lonlat_uvs([lonlat_point(lon, lat)], [(0,)])[0][0]


def test_globe_uvs_put_longitude_zero_and_known_places_where_the_raster_has_them():
    assert os.path.isfile(RASTER)  # the registered Natural Earth raster the globe uses by default
    # Raster convention (same as maps.WorldMap): u = lon/360 + 0.5, v = lat/180 + 0.5; longitude 0 is the middle column.
    assert np.allclose(_uv(0, 0), (0.5, 0.5))
    assert np.allclose(_uv(-60.0, -3.1), (0.5 - 60 / 360, 0.5 - 3.1 / 180))      # Manaus: west is left, south is down
    assert np.allclose(_uv(139.7, 35.7), (0.5 + 139.7 / 360, 0.5 + 35.7 / 180))  # Tokyo: east is right, north is up
    # East is counter-clockwise seen from the north pole, so the Earth is not mirrored.
    x0, y0, _ = lonlat_point(0, 0)
    x1, y1, _ = lonlat_point(90, 0)
    assert x0 * y1 - y0 * x1 > 0
    # face_lon turns the asked longitude to the camera side (-Y).
    for lon in (0.0, -60.0, 139.7):
        a = face_lon(lon) + np.radians(lon)
        assert np.allclose((np.cos(a), np.sin(a)), (0.0, -1.0), atol=1e-9)


def test_no_face_of_the_globe_stretches_across_the_whole_map_at_the_date_line():
    nu, nv = 128, 64
    uvs = lonlat_uvs(geometry.sphere_verts(nu, nv) * 5.0, geometry.grid_faces(nu, nv, True))
    assert max(float(np.ptp(f[:, 0])) for f in uvs) <= 1.0 / nu + 1e-6
    assert min(float(f[:, 0].min()) for f in uvs) >= 0.0 and max(float(f[:, 0].max()) for f in uvs) <= 1.0
