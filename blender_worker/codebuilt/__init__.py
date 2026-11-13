"""Code-built shorts engine kit (KAN-910, CB1).

Helpers ported and restated from the chat builds (gum short, earth-stop short):
mesh tools, materials, lights, camera with depth of field, on-screen readouts,
figure rigs, the per-frame render loop, preview and contact-sheet tools, and the
every-frame framing check.

Pure-Python parts (mathx, geometry, paths, timeline, framing, renderloop, sheet)
import without Blender. The bpy parts (meshes, materials, lights, camera,
readouts, figures, scene, smoke_scene) run only inside Blender.
Every path argument must be absolute.
"""
