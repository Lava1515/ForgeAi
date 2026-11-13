# Preview refusal cost and pre-render kit QA

Research note · 2026-11-13 21:01 +02:00 · codex · gpt-6-luna

## Finding

The four refused previews for `mwfaddlm-2d3538` did **not render frames**. Every `work/executor.json` records `exit: 1, frames: 0`; every `work/qa_failure.txt` records `QA failed before rendering`, and each stderr traceback ends in `shotcheck.run_qa()` raising `QAError`. The measured elapsed time from each preview job folder's creation to the QA failure artifact is 4m12s–4m24s:

| Preview | Job folder created (UTC) | QA failure recorded (UTC) | Elapsed | Frames |
|---|---|---|---:|---:|
| `pv1` | 18:10:56.486 | 18:15:15.482 | 4m19s | 0 |
| `pv2` | 18:15:48.109 | 18:20:02.025 | 4m14s | 0 |
| `pv3` | 18:21:06.941 | 18:25:18.767 | 4m12s | 0 |
| `pv4` | 18:26:16.693 | 18:30:40.411 | 4m24s | 0 |

These timestamps measure from preview job-folder creation through Blender scene construction and QA refusal; they do not isolate Docker startup, Blender initialization, cleanup, or post-run audit time. The source has no finer per-phase timing here. The roughly five-minute cost is supported as a Blender preview attempt that reaches QA, but attributing all of it specifically to container startup is not. The preview loop also spent separately on Claude look/fix calls: `.start/mwfaddlm-2d3538/cost_calls.json` records five `build_look` calls totaling about 153 seconds of provider wall time and 18,145 output tokens.

## Existing gate and enforcement

Kit QA is already ordered before preview rendering. `dashboard/server/episode/codebuilt/planner.js` requires a literal `shotcheck.run_qa(...)` before `renderloop.render_frames(... require_qa=True)`. In `blender_worker/codebuilt/shotcheck.py`, `run_qa()` poses frames through the Blender scene and evaluates scene-derived checks; it is not a text-only check and cannot honestly be claimed to run without Blender. The one-use QA gate in `renderloop.py` refuses rendering unless that exact pass succeeded. The saved diagnostics prove this gate stopped all four previews before any frame was written.

The preview still enters the regular approved GPU execution path: `composePreview.js` reuses the final renderer's composed runner; `compose.js` selects a frozen approved launch; `runner.js` passes it to `runIsolatedJob`; `runJob.js` takes the GPU lease, locks the job, snapshots, calls `runFenced`, confirms cleanup, then audits. `processGuard.js` is the sole container start/stop boundary. Moving or duplicating QA ahead of this path cannot perform this scene-dependent QA without Blender. A separate QA-only Blender container would preserve the fence but add another launch and lease cycle; it is not a cost-saving change.

## Smallest safe plan

No code change is justified for “QA before preview render”: that invariant already exists and is verified by the artifacts. Keep scene QA inside the same preview Blender execution, under the same approved launch, exact job-folder mount/fence, and GPU lease. Do not add host-side QA, a second preflight container, alternate launch options, or automatic retries. If the owner still wants to reduce refusal latency, first add phase timing to the existing fenced run (without changing its controls), then optimize only the measured dominant phase in that same approved run.

## Focused probe plan for a later implementation

After the current `start.js` / `visualLoop.js` worker finishes and the owner resumes integration, add bounded timestamps for fence launch, first watchdog readiness, executor completion, cleanup confirmation, and audit completion to an existing per-job artifact. Run a small controlled QA-failing generated scene and a passing scene through the existing approved preview launch; assert the failing case has zero PNGs and a QA diagnostic, the passing case produces only its requested preview frames, and both retain the exact job fence, approved launch identity, and single GPU lease. Compare phase timings. Do not run a live container, Blender, GPU, voice, or API probe as part of this research note.

## Future Claude limit handling

When explicit UI resume support lands, classify a Claude usage-limit stop as resumable and persist/use its `claude_limit_until` before resuming the same job. Preserve completed script, voice, and build artifacts and continue at the first missing step. Do not implement autonomous wait/retry here; the owner decision explicitly defers that behavior to the resume flow.
