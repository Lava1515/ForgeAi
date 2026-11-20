---
name: codebuilt-maps
description: How to use the map kit (real country shapes, highlight, true-size moves, labels, camera flights) in a code-built short whose topic is about where a place is, how big it is or how it borders another. Loaded by topic at the direction and build steps.
---

# Code-built maps

Optional kit. Use it only when the narration is about countries or regions as shapes on a map: where something is, how big it is next to another, a country moved onto another place, a border or shape explained. A topic that only mentions a country in passing does not need it. If it does not fit, ignore this text. The brief and the direction win over it.

Avoid current wars and disputed borders. The shapes are Natural Earth's default boundaries, not anyone's official line. `Country.disputed` is true where Natural Earth marks a place Disputed or Indeterminate (for example Kosovo, Western Sahara, Palestine, Israel, Falkland Is., Siachen Glacier, Antarctica) and for Taiwan, Somaliland and N. Cyprus: do not feature, highlight or compare them. Never claim a border is right or final; say what the picture shows.

## Where the kit is

```python
import sys; sys.path.insert(0, '/kit')
from blender_worker.codebuilt import maps
from blender_worker.codebuilt.sets import world_map
h = world_map.build(origin=(x, y, z), detail="50m", palette="relief")   # a ready, lit map place, like any set
wm = h['map']        # maps.WorldMap; h['countries'] = {ISO code: mesh object}; h['sea']; h['collection']; h['lights']
```

Default: `projection="equirectangular", relief=True`, with real bundled Natural Earth hillshading on country faces. UVs use world longitude/latitude, independent of sea margin and object origin. The sea is dark blue-black with bathymetric detail. Bright highlights retain hillshading. `wm.highlight(...)` returns a fill handle; call `hit["fill"].pose(t)` per frame to animate the fill, and use `wm.highlight_group(keys, label=...)` to highlight several countries together. Missing raster raises; no noise fallback. Equal Earth and Mercator require `relief=False`; equirectangular distorts areas so do not infer area from its apparent size. A regional `bbox` adds one box-width of country context on every side and clips the sea to that padded crop. Its relief boost scales down for close crops.

`world_map.build` returns the usual set handles (`collection`, `origin`, `subject`, `lights`) plus the map. Register `h['collection']` as the place collection like any other set and link your extra objects into it. Options: `detail` "110m" (177 countries, fast, coarse coasts) or "50m" (242 countries, includes small ones such as Singapore, Malta, Monaco; builds in about one second; use it whenever the camera comes close or a small country matters), `projection` "equal_earth" (requires relief=False; areas are honest), "equirectangular" or "mercator", `palette` "relief" (default, bright fills with real hillshading), "continents" (colourful), "muted" (calm blue-grey: use it when one country must pop) or "flat", `highlight` (a country to colour and lift at once), `only=[...]` or `bbox=(lon0, lat0, lon1, lat1)` to build a region only, `hide=("ATA",)` (Antarctica is hidden by default), `scale` (world units per earth radius, default 4: equirectangular world is 25.13 wide, 1 km = 0.00063 units), `thickness`, `sides=False`.

The map lies in the XY plane, north is +Y, the camera sits on the south side. Countries are keyed by ISO alpha-3 ("BRA"), alpha-2 ("BR"), English name ("Brazil") or an alias ("USA", "UK"). `maps.load("50m").find(key)` gives a `Country` (`name`, `iso`, `area_km2`, `continent`, `pop`, `disputed`, `centroid`). An unknown name raises with suggestions.

The 1080x1920 frame is tall and the world is wide: the whole world fills the frame width but only a band across the middle. Use the world view for the first second (where on Earth), then go to a region or a country. Do not leave a world view on screen for long.

## Recipes

For close-ups, choose the camera first, then set the border and add the highlight. The automatic lift is about 2% of the country's width and is recomputed when `set_border` changes it. `label=True` places the country name at the shot's label scale. Keep neighboring countries in the bbox context; do not pass `highlight=` to `build` for a close-up because that happens before the close-up border is chosen.

```python
pose = wm.view("GRC", tilt=64, margin=1.9, up=-0.05)
span = maps.view_span(pose)
wm.set_border(0.002 * span)
hit = wm.highlight("GRC", color=(1.0, 0.55, 0.08), glow=0.6,
                   marker_below_km=0, label=True, label_span=span)
cam.set(*pose)
```

World-view colour and lift (a small one also gets a marker ring and pin automatically):

```python
hit = wm.highlight("BRA", color=(1.0, 0.55, 0.08), lift=0.25)    # hit['obj'], hit['marker']
wm.set_color("ARG", (0.3, 0.8, 0.5)); wm.set_lift("ARG", 0.1)     # absolute: call per frame to animate (lift 0 -> 0.4)
wm.restyle("muted")                                              # repaint everything
```

Camera. `wm.view(key_or_(lon, lat), tilt=72, azimuth=0, lens=35, margin=1.3, min_span=1.5, up=0)` returns `(pos, target, lens)` that frames a country or point in the vertical frame (tilt 90 is straight down; 60 to 75 reads as a table-top map; azimuth 20 to 40 gives a side look). `wm.world_view()` fits the whole map. `maps.fly(pose_a, pose_b, t)` blends two poses with smoothstep and a pull-back arc: `cam.set(*maps.fly(wm.world_view(), wm.view("BRA"), t))`. Use `up=-1` to place the subject higher in the frame (negative moves the target south, so the subject rises). Aim only through `cam.set`.

Labels. `wm.label("BRAZIL", at_key_or_lonlat, span=maps.view_span(pose), tilt=62)`: flat white text on a dark plate, tilted toward the camera, 10 percent of the visible width tall (about 70 px in the frame). Always pass `span` from the pose of the shot the label is seen in; a label made for the world view is far too big up close. A label is an object: show it only in its shots (`obj.hide_render`, and its children). Keep labels out of the top 10 and bottom 20 percent of the frame. Place the label beside or below the subject, not on it; one or two labels per shot.

Borders are drawn as thin ribbons inside each outline. The default width suits the world view and is too thick in a close-up: after you choose the shot, call `wm.set_border(0.002 * maps.view_span(pose))` (about 0.0025 for a very close view).

Small countries and islands. `highlight` adds a pin and ring when the country is under 900 km wide on the map. In a close-up pass `marker_radius=0.05 to 0.12` (the default ring suits the world view and would swallow the screen). `wm.marker(key_or_lonlat, color, radius)` makes one on its own; `marker.ping(t)` pulses the ring (t 0 to 1 per pulse). Frame it with `wm.view("SGP", min_span=0.9, tilt=62)`, so the neighbours stay visible, and fly there from a region view.

True-size move (a country laid on another place at its real size):

```python
mv = wm.moving("COD", to="GRL")                 # to = country key or (lon, lat); optional parts="auto"|"main"|"all", rotation=degrees
mv.pose(t)                                       # t 0 = at home, 1 = arrived; smoothstep, rises by arc * sin(pi t); call per frame
```

The copy is rebuilt around the country's own centre in a Lambert azimuthal equal-area projection (area exact, shape error small) and set down at the target in the map plane at the map's scale (km / 6371 x scale). So its size is honest wherever it lands, even on a Mercator map where the real Greenland is drawn about 16 times too big by area: put `projection="mercator"` and move a country of similar true size onto Greenland to show it. On an Equal Earth map with relief=False every area is already honest, so a move shows overlap, not distortion. `parts="auto"` keeps the mainland and large near islands (France without French Guiana, USA with Alaska but no Hawaii). Say which in the narration when it matters. Facts for the script: `maps.facts("BRA", "RUS")` returns names, areas rounded to two significant figures and the ratio. The shapes are generalised, so areas are about 5 to 10 percent off: say "about", never quote them to the kilometre, and check any figure you use against the facts call.

Dim the rest when one country is the story: use `palette="muted", relief=True` and `highlight` or `set_color` on the subject. Both palettes retain geographic hillshading. A calm map with one bright country is clearer than a rainbow.

## Look and light

`world_map.build` adds a sun and a fill light and uses a dark blue world colour. Standard view transform, exposure 0. Highlights preserve the relief shading and use a restrained default emission. Text and markers are emissive. Production uses Cycles CPU; do not assume EEVEE matches. A world or region map is a table-top: never leave it unchanged for more than about 3 seconds.

The `globe` set uses the bundled Natural Earth relief raster by default, with its default sun and space lighting. Its handles include `h["real_earth"]`, `h["face_lon"](lon)` to rotate a longitude toward the camera, and `h["lonlat"](lon, lat)` to place a marker on the globe (use `r=5.1` to float it above the radius-5 surface).

## One new thing per phrase

Winning map Shorts land something new on the map with every spoken phrase: a country fill (`set_color`, `highlight`), a label, a route segment, a marker (`ping`), or a zoom to the next place (`maps.fly`). Drive each one from the measured time of the word that names it. A held camera on a map where fills and labels keep landing counts as change; a static shot of an unlabelled shape does not.

## Cost

One `WorldMap` is one mesh per country (about 250 objects at 50m, 90 000 faces with walls). Build it once per place, not per shot; per-frame calls are only `pose`, `set_lift`, `ping` and `cam.set`. `set_border` rewrites every ribbon: call it once per shot, not per frame.

## Licence

The shapes are Natural Earth, public domain, no credit required (licenses/register.json). Adding "Map data: Natural Earth" to the video description is optional and polite.

## When text is drawn after the render

This applies only when the job's route is `overlay` or `authored`, where text is drawn after the render. Then the scene carries no text at all: no letters, no numbers, no country names in 3D. The overlay step draws every label, so a text change needs no new render. Where this section differs from the text above (the view transform and the labels), this section wins for those routes.

- Country names and place names are overlay labels, never 3D text. Do not use the map kit's `label` method or the `label` argument of `highlight` and `highlight_group`; the overlay code check refuses them.
- Mark each country's anchor with `WorldMap.anchor_point(key)` when it exists (a plain function that returns three numbers) and pass the point to `anchors.mark`. Use `WorldMap.point(lon, lat, z)` only for a free point that is not a country.
- A running year or distance is the counter, drawn by the overlay. The big payoff number goes on its own word.
- The camera slows at each landmark, arrives before the word that names it and holds about one second after the label is fully on screen, so the label can be read before the camera leaves.
- The render profile line in the build prompt wins; today it is view transform AgX with look `AgX - Medium High Contrast`, Cycles at 16 samples, for these routes. Keep `scene.cycles.device='CPU'` (the fenced executor picks the GPU). In the preview sheets the sea and land must still read under that look.
- Surfaces are written for the shot: large patterns that read on a phone, no plain flat sea or ground where the viewer looks. Keep the subject clear of the place a label will sit.
- A place marker is smaller than the place it marks at the shot's zoom. A ring, pin or disc from `highlight` or `wm.marker` must not cover the lake, island or country it names: at a close-up, set `marker_radius` small enough that the place shows around the marker, or place a dot at its edge. The world-view default is wrong for every close-up and region shot. The preview sheet of that shot must show the place clear of its marker.
- Never replace a country's material. `ob.data.materials.clear()` or `.append(...)` on a kit country (seen on the Dingo Fence video, 2026-11-19) throws away the relief and the fill controls, and the country renders as a flat slab. Colour a country with `wm.set_color(key, rgb)` or `wm.highlight(key, color=...)`. For two colours inside one country (north and south of a line), lay thin tinted patches a little above the map and keep the country's own material. The kit reports `map_material_replaced` when a build does it.
- Land must read as land. Under the AgX look of these routes the default bright relief fill washes out to pale grey-white and reads as snow or ice (seen in the hypersaline proof, 2026-11-18). For a land-heavy shot use `palette="continents"` or a mid-tone land colour, keep the sea dark, and keep the highlight colour clearly apart from the land.
