"""Image-resident entry of the GPU generated-code executor (runs inside Blender's Python). MIT License. Copyright (c) 2026 ForgeAi contributors.

The GPU launcher (`/opt/forge/blender-generated-gpu`) starts Blender with this file as its only script. Before the job's build script
runs, this file checks what Blender itself can see and selects it; `--gpus` on the docker command line is never taken as proof.

  1. Cycles device enumeration: OptiX first, then CUDA. The first type with at least one device is selected, that device type is the
     only one enabled (the CPU device is switched off), and Cycles scenes are set to the GPU when a render starts.
  2. No device found: the evidence file is written and the process exits with code 3 BEFORE the job's script is read. There is no
     silent CPU fallback, so a finished GPU job means Blender saw and selected a device.
  3. The OpenGL/Vulkan renderer that EEVEE would use is recorded too (`gl.renderer`, `gl.software`). It is evidence, not a gate:
     a Docker Desktop (WSL2) container has CUDA but no GPU OpenGL driver, so EEVEE can still be on llvmpipe while Cycles is on the GPU.

Evidence: `/job/work/gpu.json`. Then `/opt/forge/entry.py` runs unchanged (same contract, same `/job/work/executor.json`).
Absolute paths only, nothing is read from the environment, no process or socket is started.
"""
import json
import os
import runpy
import sys

WORK = "/job/work"
EVIDENCE = "/job/work/gpu.json"
ENTRY = "/opt/forge/entry.py"
VERSION = "codebuilt-gpu-select-v1"
NO_DEVICE = 3
SOFTWARE_GL = ("llvmpipe", "softpipe", "swrast", "software")


def _write(evidence):
    try:
        os.makedirs(WORK, exist_ok=True)
        with open(EVIDENCE, "w", encoding="utf-8") as fh:
            json.dump(evidence, fh, indent=1)
    except OSError:
        pass


def _gl():
    try:
        import gpu
        gpu.init()
        renderer = str(gpu.platform.renderer_get())
        return {"backend": str(gpu.platform.backend_type_get()), "renderer": renderer,
                "software": any(m in renderer.lower() for m in SOFTWARE_GL)}
    except Exception as ex:  # evidence only: never a reason to stop
        return {"error": repr(ex)}


def _select():
    import bpy
    evidence = {"version": VERSION, "selected": None, "devices": {}, "errors": {}}
    prefs = bpy.context.preferences.addons["cycles"].preferences
    chosen = None
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.refresh_devices()
            names = [d.name for d in prefs.devices if d.type == kind]
        except Exception as ex:
            evidence["errors"][kind] = repr(ex)
            names = []
        evidence["devices"][kind] = names
        if names and chosen is None:
            chosen = kind
            break
    if chosen is not None:
        prefs.compute_device_type = chosen
        prefs.refresh_devices()
        for d in prefs.devices:
            d.use = d.type == chosen
        evidence["selected"] = chosen
        evidence["enabled"] = [{"name": d.name, "type": d.type} for d in prefs.devices if d.use]

        def to_gpu(*_args):
            for scene in bpy.data.scenes:
                if scene.render.engine == "CYCLES":
                    scene.cycles.device = "GPU"

        for hook in (bpy.app.handlers.render_init, bpy.app.handlers.render_pre):
            hook.append(to_gpu)
        to_gpu()
    return evidence


def main():
    try:
        evidence = _select()
    except BaseException as ex:  # a failed selection is a failed GPU job
        evidence = {"version": VERSION, "selected": None, "errors": {"select": repr(ex)}}
    evidence["ok"] = evidence.get("selected") is not None and bool(evidence.get("enabled"))
    evidence["gl"] = _gl()
    _write(evidence)
    sys.stdout.write("gpu-select: %s\n" % json.dumps({k: evidence.get(k) for k in ("ok", "selected", "enabled")}))
    sys.stdout.flush()
    if not evidence["ok"]:
        sys.stderr.write("gpu-select: Blender found no CUDA or OptiX device; refusing to run the build script on the CPU\n")
        sys.stderr.flush()
        os._exit(NO_DEVICE)
    runpy.run_path(ENTRY, run_name="__main__")  # entry.py ends the process itself (os._exit)


main()
