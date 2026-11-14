# Map data

Natural Earth admin-0 countries (public domain, no credit needed; `licenses/register.json`, id `naturalearth:admin_0_countries`),
converted to a compact form for `maps.py`. About 0.6 MB in total.

| File | Content |
|---|---|
| `countries_110m.json` / `.bin` | 177 countries, coarse coasts (10 306 points) |
| `countries_50m.json` / `.bin` | 242 countries incl. small ones (97 866 points) |
| `convert_naturalearth.py` | GeoJSON to these files; standard library only. Source: `natural-earth-vector/geojson` on GitHub, files `ne_110m_admin_0_countries.geojson` and `ne_50m_admin_0_countries.geojson` |
| `proof_scenes.py` | Blender script for the visual check: `blender -b --factory-startup -P proof_scenes.py -- --out <abs dir> [--scale 50] [--cpu-cycles]` |

The `.bin` is little-endian int16 pairs (lon, lat times 100), no ring closure point; the `.json` holds names, ISO codes, areas, centroids and per-polygon
ring offsets. `maps.load()` reads both with `np.fromfile`, so loading takes milliseconds. Boundaries are Natural Earth's default view and are not edited.
