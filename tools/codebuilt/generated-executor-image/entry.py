"""Image-resident entry of the generated-code executor (runs inside Blender's Python). MIT License. Copyright (c) 2026 ForgeAi contributors.

The launcher (`/opt/forge/blender-generated`) starts Blender with this file as its only script. This file runs exactly one
thing from the job folder: the planner's build script `/job/build/build.py`, with the engine kit importable from the
read-only mount `/kit` (blender_worker.codebuilt) and the render arguments the kit's `renderloop.parse_args` expects:
frames to `/job/frames`, the scene to `/job/work/scene.blend`. Absolute paths only, nothing is read from the environment.

Contract: exit code 0 only when the build script finished without an exception; `/job/work/executor.json` records the script hash,
the exit code and the frame count. It writes nothing else, starts no process, opens no socket and imports no network module.
"""
import hashlib
import json
import os
import runpy
import sys
import traceback

JOB = "/job"
SCRIPT = "/job/build/build.py"
KIT = "/kit"
FRAMES = "/job/frames"
WORK = "/job/work"
SCENE = "/job/work/scene.blend"
VERSION = "codebuilt-executor-v1"


def _record(code, script_sha):
    frames = 0
    try:
        frames = sum(1 for n in os.listdir(FRAMES) if n.lower().endswith(".png"))
    except OSError:
        pass
    try:
        with open(os.path.join(WORK, "executor.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": VERSION, "script_sha256": script_sha, "exit": code, "frames": frames}, fh)
    except OSError:
        pass


def main():
    code, script_sha = 1, None
    try:
        os.makedirs(FRAMES, exist_ok=True)
        os.makedirs(WORK, exist_ok=True)
        with open(SCRIPT, "rb") as fh:
            script_sha = hashlib.sha256(fh.read()).hexdigest()
        if KIT not in sys.path:
            sys.path.insert(0, KIT)
        sys.argv = [SCRIPT, "--", "--out", FRAMES, "--blend-out", SCENE]
        runpy.run_path(SCRIPT, run_name="__main__")
        code = 0
    except SystemExit as stop:
        code = stop.code if isinstance(stop.code, int) else (0 if stop.code in (None, 0) else 1)
    except BaseException:  # the build script is generated code: any failure is reported, never swallowed
        traceback.print_exc()
        code = 1
    _record(code, script_sha)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)  # Blender would otherwise exit 0 after a script error


main()
