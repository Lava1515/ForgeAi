# Generated-code executor image (candidate source)

Status 2026-11-13: the CPU launcher is approved on image `8d2b54c0...` (policy.js). The GPU launcher below is built but not approved.

Purpose: the offline container that runs the planner's Blender build script (`/job/build/build.py`) for a code-built short.
Same pinned Debian base, same verified Blender 5.2.2 tarball and same headless runtime packages as `../blender-proof-image`
(provenance table there); no ffmpeg, no GPU stack, no shell tooling, no credential, no `.env`; runtime is `--network none`.

| Piece | What it is |
|---|---|
| `launcher.S` | static MIT launcher `/opt/forge/blender-generated`: argc must be 1, hard-coded argv (Blender `--background --factory-startup --python /opt/forge/entry.py`) and environment, no `/job` path in argv |
| `entry.py` | image-resident script: runs `/job/build/build.py` once with `/kit` (the read-only engine kit mount of `blender_worker/codebuilt`) importable, `--out /job/frames --blend-out /job/work/scene.blend`; writes `/job/work/executor.json`; exits non-zero on any script failure |
| `Dockerfile` | build recipe (stage the verified tarball first, as for the proof image) |
| `image-source.test.mjs` | static invariants: `node --test tools/codebuilt/generated-executor-image/image-source.test.mjs` |

Approval candidate (the activation commit fills image and review): `engines/codebuilt/launch.js` `GENERATED_EXECUTOR_CANDIDATE`:
kind `generated-code`, command `["/opt/forge/blender-generated"]`, CPU, `blender.max` 2, limits 8192 MB / 4 CPU / 512 pids,
acknowledgements `blender_cap_detect_only` and `runs_generated_job_code`.

## GPU launcher (2026-11-13, claude-pro · claude-sonnet-5-5) - built, enumerated, NOT approved, NOT rendered

The same source builds a second fixed launcher, `/opt/forge/blender-generated-gpu` (`launcher.S` assembled with `--defsym GPU=1`; the
only difference is the entry script `/opt/forge/entry_gpu.py`). `entry_gpu.py` asks Blender itself what it can use, OptiX first then
CUDA, enables only that device type (CPU device off), sets Cycles scenes to GPU at render start, writes `/job/work/gpu.json`
and **exits 3 before the build script is read** when no device is found. There is no CPU fallback and `--gpus` alone is never taken as proof.

| What | Value |
|---|---|
| Image | `forgeai-generated-executor:gpu1`, id `sha256:eb74788b589f9993c75d1154c8da2d1a2bca8e88dffc52ec39118d7b89b912b8` (1.53 GB), built from this directory + the verified tarball (sha256 `84098912...a168`) |
| Policy entry | `cb6-generated-blender-gpu-v1`: generated-code, command `["/opt/forge/blender-generated-gpu"]`, `gpu: true`, `blender.max` 2, 8192 MB / 12 CPU / 512 pids, both acknowledgements. Its `review` is `pending...` on purpose, so `checkApproval` refuses it until the activation commit sets the exact-head review identity |
| Fence | unchanged: `--network none`, `--read-only`, `--cap-drop ALL`, `no-new-privileges`, uid 1000, no env file, no Docker socket, job folder + read-only kit only. The only argv additions versus the CPU entry are `--gpus device=0`, the image and the launcher |
| GPU lease | unchanged: every GPU job takes `.superpowers/supervisor/gpu.lock` (queue.js) and the 1.5 GiB RAM abort of the supervisor applies |
| Enumerate (no render) | `node tools/codebuilt/generated-executor-image/enumerate-gpu.mjs` (takes the GPU lock, refuses when held); `--digest-only` compares the local image id with the policy entry |

Measured on this PC (Docker Desktop, WSL2 backend, RTX 4070 Ti, driver 621.14), through the real fence argv:
`gpu.json` = `selected: CUDA`, `enabled: [NVIDIA GeForce RTX 4070 Ti]`. **OptiX is not available** (`OptiX initialization failed with error code 7804`; WSL2
ships no `libnvoptix`), so Cycles uses CUDA. **EEVEE is still on software OpenGL** (`gl.renderer: llvmpipe`, `gl.software: true`):
a WSL2 container has CUDA but no GPU OpenGL driver (the Mesa `d3d12` route needs the host `libd3d12.so`, which is not injected; mounting `/usr/lib/wsl`
crashed Blender and would also widen the mount allowlist, so it was dropped). The kit's `stage.setup_render` selects EEVEE, so **this launcher speeds up Cycles
scenes only**; switching the shots to Cycles is a look decision and is not part of this change. Fail-closed check: the GPU launcher without `--gpus`
exits 3 and runs no build script. A real Cycles GPU render (kernel compile, VRAM, timing) has NOT been run.

Honest limits: the Blender cap is detect-only (see `docs/codebuilt-isolation.md`); the build script is arbitrary code and
runs as uid 1000 inside the container with only `/job` writable.

Build (when approved; starts no container):
```sh
docker build --pull=false -t cb6-generated-executor:cand1 .
docker image inspect cb6-generated-executor:cand1 --format '{{.Id}}'
```

MIT License. Copyright (c) 2026 ForgeAi contributors. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated files, to deal in the Software without restriction, subject to the copyright notice and this permission notice being included. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Activation prepared by codex ? gpt-6.1-sol, 2026-11-13: exact-head review b186312378a1d972c1b7e08b9703567b62b23b21 PASS. Actual planner explicitly configures Cycles CPU; the trusted GPU entry changes Cycles to GPU at render start. The stage.setup_render EEVEE helper is not used by this planner. Existing CPU entry retains its image, command and GPU-off setting; both generated entries are covered by the new review identity under the unchanged equality gate. Runtime rendering/timing still awaits the next UI job.
