"""Three-shot smoke scene for the engine kit (KAN-910). Runs inside Blender 5.2:

  blender -b --factory-startup -P smoke_scene.py -- --out <abs frames dir> [--scale 25] [--samples 8]
          [--range a b | --frames 1,2] [--qa] [--info] [--blend-out <abs file.blend>]

Shot 1 grid floor, sphere and lathe vase with depth of field.
Shot 2 swept tube and bevelled box with a readout.
Shot 3 posed figure with an area light and a readout.
"""
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

import bpy  # noqa: E402

from blender_worker.codebuilt import figures, framing, materials, meshes, renderloop, stage, timeline  # noqa: E402
from blender_worker.codebuilt.mathx import ss  # noqa: E402

FPS = timeline.FPS
SHOT_LEN = 0.4
NFRAMES = int(3 * SHOT_LEN * FPS)  # 36


def build(args):
    scene = stage.reset_scene()
    stage.setup_render(scene, scale=args.scale, samples=args.samples)
    cam = stage.Camera(scene)
    colls = {n: meshes.coll(scene, n) for n in ("props", "tube", "person")}
    subject = [(0, 0, 1)]

    # ---- shot 1: grid floor + sphere + lathe vase, depth of field
    c = colls["props"]
    floor = materials.pbr("floor", (0.55, 0.6, 0.7), 0.7)
    meshes.grid("floor", 12, 12, lambda u, v: ((u - 0.5) * 12, (v - 0.5) * 12, 0.05 * math.sin(u * 9) * math.sin(v * 9)), floor, c)
    meshes.ball("sphere", 0.8, materials.noise_mat("rock", (0.8, 0.45, 0.2), (0.5, 0.25, 0.1)), c, loc=(-0.9, 0, 0.8))
    vase = meshes.lathe("vase", [(0.01, 0), (0.5, 0.05), (0.55, 0.6), (0.3, 1.1), (0.28, 1.5), (0.42, 1.7)],
                        materials.pbr("vase", (0.2, 0.5, 0.8), 0.25, Coat_Weight=0.8), c)
    vase.location = (1.0, 0, 0)
    stage.area(c, "key1", (-3, -4, 5), (0, 0, 0.8), 600, 3)

    # ---- shot 2: swept tube + bevelled box
    c = colls["tube"]
    tube, path = meshes.sweep("tube", [(-2, 0, 0.4), (-1, 0, 1.2), (0.5, 0, 0.5), (2, 0, 1.4)], [0.25, 0.4, 0.3, 0.2],
                              materials.pbr("tube", (0.85, 0.2, 0.25), 0.4), c)
    meshes.box("block", c, materials.pbr("block", (0.9, 0.8, 0.2), 0.3), (0, 0, -0.2), (1.8, 0.8, 0.2), 0.08)
    ro = stage.hud_text(c, "readout", "SMOKE", 0.35, materials.emit("txt", (1, 1, 1)), 0.9, 0.3, materials.pbr("plate", (0.01, 0.01, 0.03), 0.6))
    stage.area(c, "key2", (-3, -4, 5), (0, 0, 0.8), 600, 3)

    # ---- shot 3: figure
    c = colls["person"]
    fig = figures.make_person(c, 2)
    meshes.grid("floor3", 4, 4, lambda u, v: ((u - 0.5) * 8, (v - 0.5) * 8, 0), floor, c)
    ro3 = stage.hud_text(c, "readout3", "FIGURE", 0.3, materials.emit("txt3", (1, 0.9, 0.3)), 0.8, 0.28, materials.pbr("plate3", (0.01, 0.01, 0.03), 0.6))
    stage.area(c, "key3", (-2, -4, 4), (0, 0, 1), 500, 3)

    def shot1(t):
        u = ss(0, SHOT_LEN, t)
        cam.set((-1 + 2 * u, -7, 2.2), (0.0, 0, 0.9), lens=55, fstop=2.8, focus=(0, 0, 0.9))
        subject[0] = (0.0, 0, 0.9)

    def shot2(t):
        u = ss(SHOT_LEN, 2 * SHOT_LEN, t)
        cam.set((0, -6 + 1.5 * u, 1.2), (0, 0, 0.8), lens=45)
        ro.scale = (0, 0, 0)
        stage.hud(cam, ro, 0, 1.3, 5, 1 if u > 0.3 else 0)
        subject[0] = (0, 0, 0.8)

    def shot3(t):
        u = t - 2 * SHOT_LEN
        arms, legs = figures.flail(u)
        figures.pose(fig, (0, 0, 0), (0, 0, 0.3 * math.sin(u * 5)), arms=arms, legs=legs)
        cam.set((0, -4.5, 1.3), (0, 0, 1.1), lens=50)
        stage.hud(cam, ro3, 0, 1.6, 5, 1)
        subject[0] = (0, 0, 1.1)

    shots = [(0.0, "props", shot1), (SHOT_LEN, "tube", shot2), (2 * SHOT_LEN, "person", shot3)]
    return scene, shots, colls, subject, cam


def main():
    args = renderloop.parse_args(renderloop.script_argv())
    scene, shots, colls, subject, cam = build(args)

    def apply(f):
        timeline.apply_frame(f, shots, colls, FPS)
        bpy.context.view_layer.update()

    if args.info:
        print("NFRAMES", NFRAMES, "shots", timeline.shot_frame_ranges(shots, NFRAMES, FPS))
        return
    bad = framing.check_scene(scene, cam.obj, apply, lambda: subject[0], NFRAMES)
    print("QA frames", NFRAMES, "subject outside middle zone:", len(bad), bad[:20])
    if args.qa:
        return
    if bad:
        raise SystemExit(f"framing check failed on {len(bad)} frames")
    if args.blend_out:
        bpy.ops.wm.save_as_mainfile(filepath=args.blend_out)

    def render_fn(fp):
        scene.render.filepath = fp
        bpy.ops.render.render(write_still=True)

    frames = renderloop.parse_frames(args.frames, args.range, NFRAMES)
    renderloop.render_frames(frames, args.out, apply, render_fn, skip_existing=not args.frames)


if __name__ == "__main__":
    main()
