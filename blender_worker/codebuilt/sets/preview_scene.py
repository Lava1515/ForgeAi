"""Preview render of one set from its three registry angles (KAN-911). Runs inside Blender 5.2:

  blender -b --factory-startup -P preview_scene.py -- --set <name> --out <abs frames dir>
          [--scale 25] [--samples 8] [--origin X Y Z] [--blend-out <abs file.blend>] [--info]

Builds the set at the origin (default 0 0 0), applies the set's registry SceneParams (world colour and
exposure), then renders <out>/<set>_<angle>.png for each angle. Use run_preview.py to run all sets.
"""
import argparse
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

import bpy  # noqa: E402

from blender_worker.codebuilt import renderloop, stage  # noqa: E402
from blender_worker.codebuilt.paths import require_abs  # noqa: E402
from blender_worker.codebuilt.sets import registry  # noqa: E402
from blender_worker.codebuilt.sets.common import REQUIRED_HANDLES  # noqa: E402


def parse(argv):
    ap = argparse.ArgumentParser(prog="set-preview")
    ap.add_argument("--set", required=True, choices=registry.names())
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=int, default=25)
    ap.add_argument("--samples", type=int, default=None)
    ap.add_argument("--origin", nargs=3, type=float, default=[0.0, 0.0, 0.0])
    ap.add_argument("--blend-out")
    ap.add_argument("--info", action="store_true")
    a = ap.parse_args(argv)
    a.out = require_abs(a.out)
    if a.blend_out:
        a.blend_out = require_abs(a.blend_out)
    if not 1 <= a.scale <= 100:
        raise ValueError("--scale must be 1..100")
    return a


def main():
    a = parse(renderloop.script_argv())
    spec = registry.get(a.set)
    sp = spec.scene
    scene = stage.reset_scene()
    stage.setup_render(scene, scale=a.scale, samples=a.samples or sp.samples, background=sp.background, bg_strength=sp.bg_strength)
    scene.view_settings.exposure = sp.exposure
    cam = stage.Camera(scene)
    handles = registry.load_builder(a.set)(tuple(a.origin))
    missing = [k for k in REQUIRED_HANDLES if k not in handles]
    if missing:
        raise SystemExit(f"set {a.set} returned no {missing}")
    print("SET", a.set, "objects", len(bpy.data.objects), "lights", len(handles["lights"]), "handles", sorted(handles))
    if a.info:
        return
    if a.blend_out:
        bpy.ops.wm.save_as_mainfile(filepath=a.blend_out)
    os.makedirs(a.out, exist_ok=True)
    for ang in spec.angles:
        pos, tgt, lens = registry.angle_world(ang, a.origin)
        cam.set(pos, tgt, lens=lens)
        bpy.context.view_layer.update()
        scene.render.filepath = os.path.join(a.out, f"{a.set}_{ang.name}.png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED", scene.render.filepath)


if __name__ == "__main__":
    main()
