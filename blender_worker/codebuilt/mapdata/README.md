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

## Real relief raster (codex · gpt-6.1-sol, 2026-11-16 09:45 +02:00)

`ne2_50m_sr_w_4096.jpg`: Natural Earth II shaded relief and water, public domain,
4096x2048 RGB, 1,927,088 bytes. Source: https://naturalearth.s3.amazonaws.com/50m_raster/NE2_50M_SR_W.zip
(source TIFF 10800x5400); official terms https://www.naturalearthdata.com/about/terms-of-use/.
Exact source/archive and derived-file hashes are in `licenses/register.json`, id `naturalearth:raster`.
Converted with Pillow LANCZOS thumbnail 4096x2048, JPEG quality=92 optimize=True.
This is pre-shaded colour, not elevation: never drive bump from the colour image.
WorldMap assigns geographic UVs to country faces; its relief default is equirectangular.
Other projections require relief=False. Ocean stays solid blue; highlight tints modulate
real hillshading. Missing raster raises. No generated-noise Earth fallback.
Render proof: `node tools/codebuilt/probe-x1-surface-render.mjs` (normal fence, CPU only).
