# F11 still proof

Author: codex / gpt-6.1-sol, 2026-11-19 20:04 +02:00.

Prepared only; no Blender, Docker, dashboard or GPU work was started by the worker.
At **zero live jobs**, the supervisor runs from this branch's worktree:

```powershell
python output/agent-jobs/f11-look/make_stills.py --zero-jobs-confirmed
```

Requires the already installed approved CPU executor image, Node and Python/Pillow.
No install, image pull, asset download, dashboard start or service restart is needed.
The existing fence still acquires its normal lease, even for the CPU launch.
Do not weaken its refusals. Keep the branch/worktree available while this runs.

The script freezes the saved Dingo build and inputs, resolves `main` and
`t3/f11-earth-map-look` to SHAs, and records these plus hashes in manifest.json.
Use `--before-ref <sha>` / `--after-ref <sha>` to pin a particular comparison.
Only materials/maps/globe/world_map are loaded from those revisions, inside the
ordinary generated build; every other kit component is identical. Their __file__
continues to point to the approved kit mount, so both use the same bundled raster.
The Dingo script body, camera, poses, lights, view transform and timings are unchanged.
No fence file or mount allowlist is patched and no alternate render route is used.

Route: composePreviewRunner (approved `cb6-generated-blender-v1`, CPU) -> normal
runner -> runIsolatedJob -> fixed executor -> shotcheck -> renderloop preview spec.
Frames 63/192 show the opening globe; 831/966 show the Australia map. Scale 50
of the saved build's 1080x1920 yields 540x960. QA remains enabled.
Sheets use the existing createPreviewSheetMaker / preview_sheet.py host helper.

Future outputs are under C:/code/ForgeAi/output/agent-jobs:

- f11-look-before-pv1/preview and f11-look-after-pv1/preview: original PNG stills.
- f11-look/: manifest, frozen inputs/builds, before/after sheets/results,
  comparison.jpg (before/after rows with Sonnet's supplied sheet beneath),
  and sonnet-final_sheet.jpg. Existing jobs and source files are read only.

The proof job ids resume only identical inputs. A changed revision correctly
refuses RESUME_MISMATCH; preserve the old proof and choose fresh job ids in the
script for a new comparison. Never delete a live job to force a rerun.

Known limit: the saved Dingo build explicitly discards Australia's kit materials
and substitutes a flat two-colour material. This proof deliberately retains it.
The kit can improve surrounding country fills and the globe, but cannot restore
relief inside that custom Australia shader. That author change is recorded under
Found, not built in docs/BACKLOG.md.
