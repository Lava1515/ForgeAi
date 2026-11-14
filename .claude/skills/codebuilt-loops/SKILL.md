---
name: codebuilt-loops
description: Build a silent 6 to 20 second seamless code-built loop with periodic subject motion, cyclic camera state and an independently rendered seam endpoint. Loaded only for loop jobs.
author: codex · gpt-6.1-sol
created: 2026-11-14 15:32 +02:00
updated: 2026-11-14 16:08 +02:00
updated_by: codex ? gpt-6.1-sol
---

# Silent loops

One clear subject filling a third to two thirds of frame height, large and readable on a phone. Compose meaningful subject or scenery in the top third; never leave it empty. Start with motion in frame zero;
no logo, title card, setup pause, captions or call to action. No text or numeric
readouts: this format does not run a narration fact check. Visual behavior must
not imply false real-world quantities or unforced dynamics.

Build a satisfying transformation, contact, near miss, assembly, disassembly or
transfer of motion. The viewer should anticipate an outcome and see it complete.
Use a clear silhouette, coherent material palette, controlled light and an
uncluttered composition. A repeated cycle should reward watching again.

Do not imitate a channel's subject or claim that a silent track was verified.

## Close the state, not just the image

- Encode frames 0 through N-1 at 30 fps. Frame N is the next frame, exactly one
  cycle after frame 0; the kit renders it separately for QA, then post excludes it.
- Use `from blender_worker.codebuilt import loops`. `loops.phase(f, N)` wraps to
  [0,1). `loops.periodic(f, N, low, high, cycles=1, offset=0)` is sinusoidal with
  integer cycles. Derive every animated property from this phase, including
  lights, deformations, particles, visibility and camera. Reset all state in
  every pose; make the half-cycle visibly different from frame 0 (avoid identical half-cycle symmetry); never accumulate transforms or run a history-dependent simulation.
- `loops.cyclic_camera(f, N, centre=(0,0,0), radius=8, height=4)` returns an orbit
  position for `cam.set(pos, centre)`. Check the entire orbit for collisions.
  A fixed camera with a moving subject is often clearer.
- `cycle = loops.close_bake(samples)` makes a forward/backward cosine-timed
  replay from baked scalar or vector samples; call `cycle(f, N)` in apply.
  Capture all state together. This is visibly stylized reversal, not a claim
  of unforced physical motion. Prefer analytic periodic motion when possible.
- Frame N must match frame 0 in pose and velocity. Do not duplicate the last
  frame, crossfade, hide a teleport, copy the first PNG or reset off-camera.
- Keep the render seed fixed across frames; do not enable animated noise seeds.
  The endpoint must be independently rendered with the same sampling settings.
- Use one continuous shot unless a cut has a clear visual purpose. The supplied
  loop contract currently requires one shot; it can contain several phases of
  the same action. Build all geometry once and animate it as a pure function.

## Fence and sound

Keep the supplied constants, render profile, `shotcheck.run_qa(..., hold=1)`
and `renderloop.render_frames(..., hold=1, require_qa=True)` unchanged.
Use only mounted kit code. No downloaded models, textures, fonts or audio.
Do not write audio: the host uses only the project's own `audio.py:synth_loop`
synthesis, periodic on the exact sample grid. It records its seam step.

QA independently compares frame 0 and frame N using RGB mean absolute error
and the 99th percentile of maximum-channel pixel error, plus the maximum 64 px tile mean (limit 2/255). Preflight poses 0, N/2 and N before rendering; the half cycle must change and N must close. Post refuses static frames, negligible half-cycle change and frozen runs of half a second. A failing seam blocks
the output. Preview the first, middle and final poses and fix the actual motion;
never weaken the threshold or conceal a jump.
