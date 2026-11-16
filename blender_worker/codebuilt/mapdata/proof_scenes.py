"""Proof renders for the map kit. Runs inside Blender 5.2:

  blender -b --factory-startup -P proof_scenes.py -- --out <abs frames dir> [--scale 50] [--samples 16] [--scenes highlight moved small] [--cpu-cycles]

highlight  world with one country highlighted and labelled (50m, muted palette)
moved      a country moved onto another place at true size on a Mercator map: DR Congo onto Greenland, at 0, 0.5 and 1 of the move
small      a flight from the world view to Singapore, a country 40 km wide: marker, then the zoom
Writes <out>/map_<scene>[_<step>].png. Not part of a video job; it is the visual check of the kit.
"""
import argparse
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

import bpy  # noqa: E402

from blender_worker.codebuilt import maps, renderloop, stage  # noqa: E402
from blender_worker.codebuilt.paths import require_abs  # noqa: E402
from blender_worker.codebuilt.sets import registry, world_map  # noqa: E402


def parse(argv):
    ap = argparse.ArgumentParser(prog="map-proof")
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=int, default=50)
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--cpu-cycles", action="store_true", help="render with Cycles on the CPU, as a build job in the container does")
    ap.add_argument("--scenes", nargs="+", default=["highlight", "moved", "small"])
    a = ap.parse_args(argv)
    a.out = require_abs(a.out)
    return a


def fresh(a):
    sp = registry.get("world_map").scene
    scene = stage.reset_scene()
    stage.setup_render(scene, scale=a.scale, samples=a.samples, background=sp.background, bg_strength=sp.bg_strength)
    scene.view_settings.exposure = sp.exposure
    if a.cpu_cycles:
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = a.samples
    return scene, stage.Camera(scene)


def shot(scene, cam, pose, path):
    cam.set(*pose)
    bpy.context.view_layer.update()
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path)


def scene_highlight(a):
    scene, cam = fresh(a)
    t0 = time.time()
    h = world_map.build((0, 0, 0), detail="50m", palette="muted", highlight="BRA")
    wm = h["map"]
    world, zoom = wm.world_view(tilt=78), wm.view("BRA", tilt=62, azimuth=20)
    big = wm.label("BRAZIL", (-52, -34), span=maps.view_span(world), tilt=70, lift=0.3)
    close = wm.label("BRAZIL", (-52, -22), span=maps.view_span(zoom), tilt=62, lift=1.0)
    wm.set_border(0.002 * maps.view_span(zoom))
    print("build seconds", round(time.time() - t0, 2), "objects", len(bpy.data.objects))
    close.hide_render = True
    for o in close.children:
        o.hide_render = True
    shot(scene, cam, world, os.path.join(a.out, "map_highlight.png"))
    big.hide_render = True
    for o in big.children:
        o.hide_render = True
    close.hide_render = False
    for o in close.children:
        o.hide_render = False
    shot(scene, cam, zoom, os.path.join(a.out, "map_highlight_zoom.png"))


def scene_moved(a):
    scene, cam = fresh(a)
    h = world_map.build((0, 0, 0), detail="50m", projection="mercator", palette="muted", hide=("ATA",), relief=False)
    wm = h["map"]
    wm.set_color("GRL", (0.75, 0.82, 0.95), emission=0.05)
    mv = wm.moving("COD", to="GRL")
    pose = wm.view("GRL", tilt=70, margin=1.5, up=-1.2)
    wm.set_border(0.002 * maps.view_span(pose))
    for step, t in (("0", 0.0), ("5", 0.5), ("10", 1.0)):
        mv.pose(t, hold_lift=0.1)
        shot(scene, cam, pose, os.path.join(a.out, f"map_moved_{step}.png"))
    wm.label("DR CONGO", (-41, 60), span=maps.view_span(pose), tilt=70, lift=0.6)
    shot(scene, cam, pose, os.path.join(a.out, "map_moved_label.png"))


def scene_small(a):
    scene, cam = fresh(a)
    h = world_map.build((0, 0, 0), detail="50m", palette="muted", bbox=(60, -15, 150, 40))
    wm = h["map"]
    hit = wm.highlight("SGP", marker_radius=0.12)
    start, end = wm.view("MYS", tilt=70, margin=1.2), wm.view("SGP", tilt=62, min_span=0.9, margin=1.0)
    wm.label("SINGAPORE", (103.8, 4.0), span=maps.view_span(end), tilt=62, lift=0.1)
    wm.set_border(0.0025 * maps.view_span(end))
    for step, t in (("a", 0.0), ("b", 0.5), ("c", 1.0)):
        shot(scene, cam, maps.fly(start, end, t), os.path.join(a.out, f"map_small_{step}.png"))


def main():
    a = parse(renderloop.script_argv())
    os.makedirs(a.out, exist_ok=True)
    for s in a.scenes:
        {"highlight": scene_highlight, "moved": scene_moved, "small": scene_small}[s](a)


if __name__ == "__main__":
    main()
