"""Set: world_map. Runs inside Blender. Optional kit for topics that are about where a country is, how big it is or how it borders.

Flat map of the world made of real country shapes (Natural Earth, public domain), one mesh per country, with real Natural Earth hillshading on country surfaces and dark blue-black sea with bathymetric detail, lit by a low sun that
casts shadows of raised countries. The map is `maps.WorldMap` and sits in the XY plane, north = +Y, camera on the south side. Highlight fills keep the hillshading and animate with `hit["fill"].pose(t)`; `wm.highlight_group(keys, label=...)` fills a set of countries together. Default emission is subtle; no blanket 0.3 limit applies. Highlight, lift, colour, label,
true-size moves and camera flights: see blender_worker/codebuilt/maps.py and the skill codebuilt-maps. Build options: world_map.build(origin, detail="110m"|"50m",
projection="equal_earth"|"equirectangular"|"mercator", palette="relief"|"continents"|"muted"|"flat", highlight="BRA", only=[...], bbox=(lon0, lat0, lon1, lat1), relief=True).
Handles: map (the WorldMap), countries (iso -> object), sea. A regional bbox includes one bbox-width of neighboring context and clips the sea to that padded equirectangular crop; close crops use a lower relief boost.
Default projection is equirectangular with relief=True. Equal Earth and Mercator require relief=False; use Equal Earth without relief for area comparisons.
"""
from .. import maps
from .common import SetBuilder

NAME = "world_map"
SUBJECT_LONLAT = (12.0, 38.0)  # the Mediterranean: stays in frame at every registry angle


def build(origin=(0.0, 0.0, 0.0), detail="110m", projection="equirectangular", palette="relief", highlight=None, scale=4.0, relief=True, **kw):
    b = SetBuilder(NAME, origin, seed=3)
    wm = maps.WorldMap(b.c, detail=detail, projection=projection, palette=palette, scale=scale, origin=b.origin, relief=relief, **kw)
    if highlight:
        if isinstance(highlight, dict):
            wm.highlight(**highlight)
        else:
            wm.highlight(highlight)
    s = wm.scale
    b.sun("LGT-sunMap", (-0.9 * s, -1.6 * s, 3.2 * s), (0, 0, 0), 2.0, (1.0, 0.97, 0.92), angle=2.0)
    b.area("LGT-fillMap", (0.0, -1.2 * s, 5.0 * s), (0, 0, 0), 700 * (s / 4.0) ** 2, 12 * s / 4.0, (0.75, 0.85, 1.0))
    sx, sy = wm.xy(*SUBJECT_LONLAT)
    return b.handles((float(sx) - b.origin[0], float(sy) - b.origin[1], wm.thickness), map=wm, countries=wm.objs, sea=wm.sea)
