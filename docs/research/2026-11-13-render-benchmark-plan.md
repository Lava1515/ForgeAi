# Same-scene Blender rendering benchmark plan

**Status:** Plan only; no benchmark execution or performance result is included.  
**Prepared:** 2026-11-13 21:00 +02:00 · codex · gpt-6-luna.

## Objective

Compare three render configurations on one frozen scene and one full-quality 1080×1920 image sequence:

1. Cycles GPU in the approved job container.
2. Cycles GPU in the same container, with the frame range partitioned across several Blender processes.
3. EEVEE using the installed Windows Blender 5.2 executable.

Measure elapsed wall time, throughput, resource use, and output validity. Do not infer results from a preview or substitute copied/held frames. The existing `renderloop.py` has a hold/copy feature, so the benchmark path must explicitly render every frame and validate unique per-frame outputs.

## Read-only project facts

- `tools/codebuilt/generated-executor-image/entry_gpu.py` selects OptiX first and CUDA second, records the Cycles devices, and refuses to proceed when it cannot select a GPU. It separately records the OpenGL renderer; the source specifically warns that CUDA can work while EEVEE uses software OpenGL (for example, llvmpipe in Docker Desktop/WSL2).
- `tools/codebuilt/blender-proof-image/README.md` describes an image that is explicitly marked **never run**, CPU-only and not a GPU benchmark. Do not use it as the benchmark container.
- `blender_worker/codebuilt/renderloop.py` supports rendering explicit frames and can copy held frames. For this benchmark, use hold=1 and do not reuse existing output files.
- `blender_worker/codebuilt/sets/README.md` describes reduced 25%-scale, 8-sample preview renders, which are not full-quality benchmark results.
- The fleet orders say GPU render-speed measurements wait until the GPU is free. The current task order says video run 8 is active. Therefore this plan must not be run until the owner/scheduler confirms the run has ended and the normal resource lease is available.

## Freeze one representative scene

Select one existing, deterministic scene and pin its exact source revision, scene builder, seed, camera, animation timeline, render engine settings, and all dependency versions. Keep the scene and all outputs in a dedicated job folder under `output/agent-jobs/<job-id>`; the benchmark driver must reject any resolved write path outside that job directory. No other job may write there.

Use one scene file and one frame list for every configuration. Record scene-file SHA-256 and a canonical settings manifest with:

- Blender version/build hash, OS and driver/runtime versions;
- exact engine and device configuration;
- resolution X=1080, Y=1920, percentage=100, pixel aspect, camera, frame range/list and frame rate;
- samples, denoiser and denoising device, sampling/adaptive thresholds, color management, output format, bit depth, compression and transparent-film setting;
- scene asset hashes, random seeds and relevant environment variables;
- process count and exact frame partition for split-process mode.

Fix the settings once before measurement. Where an engine cannot honor an identical setting (Cycles-only samples/denoiser, for example), document the setting difference explicitly. Compare like-for-like image content and output resolution; report engine-specific settings rather than claiming pixel identity or equal quality without review.

## Run protocol

1. **Preflight, no render:** Check that no active video/GPU job holds the lease, acquire the project’s existing GPU lease for the complete GPU measurement window, and verify the job fence resolves every output/temp/log path into this job directory. Record the lease owner and timestamps. Do not change lease code or bypass its lock. Abort if lease ownership is uncertain.
2. **Environment capture:** Record hardware inventory and baseline load/memory before each configuration: GPU model and VRAM, driver, CPU model/logical cores, RAM, OS, container/image digest and Blender build. Capture available GPU utilization/memory and host CPU/RAM at a fixed interval. Record container cgroup limits and container-visible devices; these are observations, not new caps.
3. **Warm-up:** For each configuration, run one untimed representative frame at the exact final quality settings. Confirm the expected device from Blender evidence/logs (Cycles must use the selected GPU; EEVEE must report hardware OpenGL, not software rendering). Delete/segregate warm-up output only inside this job folder. If device verification fails, mark that configuration invalid and stop it; do not silently fall back to CPU/software or compare its timing.
4. **Measured repeats:** Run each configuration at least three times, in a recorded order (rotate order across rounds if practical). Each repeat renders the same full frame list from a clean output subfolder; no resume/skip-existing behavior. Time process launch through all output files flushed and validated. Record per-frame times where available plus total wall time. Keep only one measured configuration active at a time.
5. **Split-process mode:** Divide the exact same frame list into disjoint, balanced partitions. Use multiple independent Blender processes loading the same frozen scene/settings. All processes share the same job lease; do not let each worker compete for or bypass the lock. Record process count, assigned frames, launch skew, completion times, aggregate wall time, summed process time, and peak observed GPU/CPU/memory. Do not duplicate frames or count launch overhead differently across configurations.
6. **Post-run:** Release the lease only after all processes exit and output checks finish. Preserve manifests, logs, resource samples, timings and validation results in the job folder. No frames are copied into the project or published.

## Validity and safety checks

- **Output completeness:** expected frame count equals produced frame count; exact expected filenames; no missing, zero-byte, truncated, or duplicate-content files; dimensions exactly 1080×1920; decoder can open every image; record SHA-256 for every frame. Identical hashes across different frame numbers should be flagged for review (not automatically declared failure if the scene is intentionally static).
- **No frame reuse:** log/manifest must show an actual render for every frame, hold=1, no copied frames, no resumed outputs, and empty per-repeat destination before timing.
- **Same scene/settings:** compare manifest and scene hashes across all repeats; permit only declared engine/device differences and the process-count difference. Reject results with scene, frame, or quality-setting drift.
- **Device and load:** capture selected Cycles device and EEVEE OpenGL renderer. Record host and container GPU/CPU/memory load, temperature/power if exposed, and unrelated processes. Mark a run contaminated if another workload overlaps or load changes materially; rerun only when the lease permits.
- **Memory and failure:** record peak host RAM, container memory, GPU VRAM, and any OOM, driver reset, timeout, or lease/fence violation. Stop safely on an actual lease/fence problem or resource exhaustion; do not invent thresholds in this plan. Invalid/failed runs remain recorded but are excluded from speed comparisons.
- **Quality:** compare representative matched frames and check for missing content, black frames, gross lighting/composition changes, or engine feature differences. Timings alone do not establish visual equivalence.

## Report, without prefilled numbers

For each valid configuration report all repeat wall times, median and spread, frames/second, peak resources, device confirmation, output-validation result, scene/settings hashes, and any invalidations. Include a table with the three configurations and their exact settings. Recommend a path only if it is repeatably faster under valid, comparable output; otherwise state that the evidence is inconclusive. Do not add guessed measurements or extrapolate from the small CPU proof render, preview sheets, or unrelated historical jobs.

## Constraints

- Do not execute while the active video run or another GPU lease is in progress.
- No container, Blender, voice, dashboard, or video calls as part of preparing this plan.
- Do not download assets or models, add dependencies, modify the lease/fence, copy frames outside the job folder, or publish/upload outputs.
- Any later implementation remains subject to the monetization license gate and ordinary project review rules.

---

Signed 2026-11-13 21:00 +02:00 · codex · gpt-6-luna.
