# Code-built set library (KAN-911, CB2)

Eight scenery sets ported from the chat builds, one module each. Every module has
`build(origin=(0, 0, 0))`, builds the set centred on `origin` in its own collection, and returns a
handles dict. Required keys (`common.REQUIRED_HANDLES`): `collection`, `origin`, `subject` (world
point the set is about), `lights`. Each set adds its own handles (globe: `globe`, `axis`, ...).
Two sets can share a scene at different origins. Random scenery is seeded, so two builds match.

| Set | One line (the theme picker reads `registry.picker_text()`) |
|---|---|
| `city_street` | Toy city street: road, sidewalks, pastel shop buildings, palms, lamps, clouds and a sky dome. |
| `globe` | Spinning Earth globe in space with clouds, equator ring, thin atmosphere and a star field. |
| `polar_penguin` | Polar ice field at the pole with icebergs, a striped pole and ring, and a waddling penguin. |
| `tunnel` | Long rocky tunnel with a glowing far end, floating dust and a falling astronaut figure. |
| `cutaway_planet` | Earth cut open to show crust, mantle and glowing core, with a shaft line, a marker and stars. |
| `xray_body` | Transparent x-ray torso with a lit esophagus, stomach with acid and bubbles, and intestines. |
| `room` | Cosy teal room: wall with wainscot, window, shelf with books, gumball machine and a potted plant. |
| `bathroom` | Tiled bathroom with toilet and water, tank, paper roll, bin, bath mat and a potted plant. |

`registry.py` is pure Python (no Blender): `names()`, `get(name)`, `catalog()`, `picker_text()`,
`match_themes(words)`, `load_builder(name)`, plus per-set `description`, `themes`, `subject`, three
camera `angles` and `SceneParams`. A new set is added to `SPECS` and gets a module of the same name.

## What was ported, and what was left out

Sources are the chat builds (gum short, earth-stop short, and the earth-hole short for `tunnel` and
`cutaway_planet`, which are not in the first two). The code was copied and restated on the engine kit
(`meshes`, `materials`, `stage`, `figures`); nothing imports from the chat output folder.

Left out on purpose: the story characters (the gum, the gum-short head rig, the toilet gum and stars),
all shot animation and per-frame state, and the short-specific props that only exist to be animated
(city dynamics, wind streaks, sonic rings, foam, sugar and water drops). Where a set had an animated
part, the rest pose is built and the object is returned as a handle. Cars and people in `city_street`
stand still.

## Preview sheets

```
python -m blender_worker.codebuilt.sets.run_preview --job-dir C:/code/ForgeAi/output/agent-jobs/<job id>/sets
         [--blender <abs blender.exe>] [--sets globe room ...] [--dry-run]
```

One Blender run per set renders its three registry angles to `<job>/frames/<set>_<angle>.png` at 25 percent
scale (270x480, 8 samples). The launcher then writes `<job>/sets_sheet.jpg` (one row per set, three angles per
row), `<job>/sets_report.json` (per-frame exposure verdict, Blender output tails) and per-set `.blend` files in
`<job>/blend/`. It does not take the GPU lock; run it under the queue. TEMP and TMP are pointed into the job folder.
`--dry-run` prints the eight Blender commands and touches nothing. The job folder must be inside
`C:/code/ForgeAi/output/agent-jobs`; every path is absolute.

## Exposure

All sets render with the Standard view transform and `view_settings.exposure = 0` (stops). Light energies
were copied from the chat build, then lowered per set against real preview frames: the chat values clipped
or washed out five sets in Blender 5.2 (bathroom and room at mean luma 0.83 to 0.91, polar penguin 0.87 to 0.89,
x-ray body and globe close-up clipped). Factors used: bathroom 0.2, room 0.18, polar 0.2 (sky card x0.85),
x-ray 0.5, globe 0.7; city, tunnel and cutaway planet are unchanged. The gate thresholds below are unchanged. `SceneParams` in the registry
holds the per-set world colour, exposure and sample count; a build job applies it with
`stage.setup_render(..., background=..., bg_strength=...)` and `scene.view_settings.exposure`.

How "correct exposure" is judged, by `run_preview.check_frames` on the rendered PNGs:

| Verdict | Rule (provisional) | Fix |
|---|---|---|
| `dark` | mean luma below 0.06 | raise `exposure` for that set in the registry (+0.5 stop steps) |
| `bright` | mean luma above 0.70 | lower `exposure` |
| `clipped` | more than 10 percent of pixels at luma 0.98 or above | lower `exposure`, or lower the emissive strength |
| `ok` | none of the above | none |

Space sets (`globe`, `cutaway_planet`) and the tunnel are mostly black by design, so they sit near the
dark limit; if they fail only for that reason, lower `LUMA_MIN` for them rather than raising exposure
until the background greys. The limits are a first guess from the lighting values and have not yet been
checked against a real render. Offline checks already done: the subject of every set projects inside the
safe zone (x 0.2..0.8, y 0.22..0.9) at all three angles, at any origin (`registry.project`).

## Tests

`python -m pytest blender_worker/codebuilt/tests/test_sets.py` (no Blender). The registry, scene params
and launcher are tested directly. For the build functions the kit calls are replaced by a recording fake,
and each set is built at two origins: every object that is not parented must move by exactly the origin
difference, the returned handles must include the required keys with the subject at origin plus the
registry subject, and two builds must match. That check found and fixed an absolute-Y clamp in the x-ray
acid pool. What the fake cannot show (shapes, materials, exposure) waits for the real preview sheets.
