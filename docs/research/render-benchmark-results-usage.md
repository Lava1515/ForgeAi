# Offline benchmark result collector

Run `python tools/render_benchmark_results.py --job-dir output/agent-jobs/<job> --manifest manifest.json --wall-times 12.4,11.9,12.1` after a benchmark has already produced its frames and measured repeat times. Nothing is rendered or timed by this tool. The job folder and manifest must already exist; the report is created once at `result-validation.json` in that same folder.

The manifest is JSON with exact frame numbers and their job-relative PNG paths:

```json
{
  "expected_frames": [1, 2],
  "frames": {
    "1": "repeat-1/0001.png",
    "2": "repeat-1/0002.png"
  }
}
```

The job must be a canonical direct child of output/agent-jobs. The tool rejects aliases, Windows reparse points (including directory junctions), paths outside the job, non-regular or multi-link files, reused frame paths, invalid frame numbers, and frame keys that do not exactly match the expected list. It checks only the distinct files listed in the manifest; unlisted files and other repeat directories are not inventoried. It checks the PNG signature and IHDR dimensions (1080×1920), records SHA-256 hashes, and flags repeated content hashes for review. This header check does not decode the image. Duplicate content alone does not invalidate a static scene.

Median, min-to-max spread, and frames per second are emitted only when all listed outputs pass validation and at least one positive measured repeat time was supplied. Device confirmation and visual-quality review are reported as unavailable; the tool never recommends a configuration. It does not verify that an image was actually rendered, compare scene/settings manifests, or establish visual equivalence.
