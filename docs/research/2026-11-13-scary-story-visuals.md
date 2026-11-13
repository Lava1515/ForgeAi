# Scary-story visual directions: research snapshot

**Research snapshot:** 2026-11-13  
**Source:** read-only note at `C:/code/ForgeAi-old`, commit `e699f7bb` on `t3/research-scary-story-visuals`.  
**Status:** Research proposal only. No scary-story workflow was implemented, benchmarked, or approved for production.

## Summary

Three visual directions remain open: still-led editorial movement, short image-to-video inserts, and deterministic 3D scenes. The source note provides no fair comparison among them and no evidence to rank them for scary-story quality, time, or production suitability. Fog, silhouettes, camera motion, and analog-video treatments are design possibilities, not measured findings.

## Historical performance evidence (not a comparison)

The source note records two bounded historical Wan 2.2 I2V-A14B FP8 trials. They used the same listed settings but different input images/tasks. Baseline GPU memory differed. Peak memory is total observed GPU use, not incremental model allocation.

| Historical trial | Recorded task/setup | Generation / runner time | Minimum available physical RAM | Peak total GPU use |
|---|---|---:|---:|---:|
| Wan 2.2 I2V-A14B FP8, kids | 480×832, 81 source frames, four steps split 2+2, CFG 1, shift 5, RIFE ×3, 48 fps; toddler illustration input | 103.31 s / 103.81 s | 4.518 GiB | 11,143 MiB |
| Wan 2.2 I2V-A14B FP8, 3D scene | Same recorded settings; rendered mannequin-and-cabinet input | 102.61 s / 103.17 s | 4.233 GiB | 11,273 MiB |

These observations establish neither scary-story quality nor a general runtime, memory limit, or comparison with Blender. The historical project used a single-GPU atomic lock for heavy work. Concurrent Blender and ComfyUI execution was not benchmarked. Its abort policy (available physical RAM below 1.5 GiB for 60 seconds) is historical policy, not a threshold derived from the two runs.

The archive note identifies the measurements as coming from `2026-10-25-wan14b-kids-and-3d.md` and `findings.md` for a Wan 5B spike, with materially different tasks/settings. Those sources are historical only; this snapshot does not reproduce their runs or assert comparable results.

## Rights and license status

The source note did not verify exact pinned licenses for the historical Wan setup components, including FP8 weights, text encoder, VAE, LoRAs, RIFE, ComfyUI code/nodes, and dependencies. Accordingly, that stack remains **unverified and excluded from the recommended stack** until every component has primary, exact-version license evidence that allows monetized videos. A model-card-level statement alone does not clear all weights, dependencies, inputs, or outputs. Unknown and noncommercial terms are out.

No image, video, model, sound, font, or other third-party asset is approved by this report. Any future candidate must pass the project monetization license gate individually and be recorded in `licenses/register.json` before use.

## Limits and next research

The source note records one EEVEE attempt ending with `EGL_BAD_MATCH` before rendering and says CUDA worked; it contains no EEVEE render benchmark, memory measurement, or speed ratio. Do not compare that failure to a successful render or infer an EEVEE ceiling. A future visual-format comparison would need a defined story, same deliverable criteria, reproducible settings, and separate rights checks. This note authorizes no build, download, installation, or production use.

**References carried forward:**

- [Wan 2.2 I2V-A14B model card](https://huggingface.co/Wan-AI/Wan2.2-I2V-A14B) (repository metadata only; not a component-by-component clearance).
- Historical local measurements cited by the source note: `C:/code/ForgeAi-old/docs/superpowers/perf/2026-10-25-wan14b-kids-and-3d.md` and `C:/code/ForgeAi-old/docs/superpowers/spikes/1.8-video/findings.md`.

---

Research snapshot recorded 2026-11-13 21:00 +02:00 · codex · gpt-6-luna.
