---
author: codex · gpt-6.1-sol
created: 2026-11-14 15:45 +02:00
status: implementation-complete-pending-draft-adapter-integration
---

# Lane D: loop format

Loop jobs accept a topic, optional `loop_idea` (string, at most 2000 characters),
and 6–20 seconds on the 30 fps frame grid (default 10). Explicit `type: "loop"`
or a channel `profile.format: "loop"` selects the format. Explicit owner type
wins over the channel default. There is no niche branch in the pipeline.

The existing starter, build router, visual review, isolated renderer and post
kit remain the pipeline. Loops skip script generation, narration fact checking,
voice calls, word alignment and captions. The loop build and review prompts
forbid all on-screen text/readouts, so they cannot silently bypass checking
a displayed factual claim. Build calls use the existing `makeAsker` router.
No external resources, AI calls during verification, uploads or paid keys.

## Changed files

- `dashboard/server/episode/codebuilt/productionChoices.js`: third type.
- `planner.js`: separate loop brief/prompt/validator; narrated prompt bodies unchanged.
- `start.js`: format selection, silent branch, loop duration and review inputs.
- `lengthCheck.js`: loop-specific 6–20 second range.
- `runCoordinator.js`: loop/profile resolution, duration and optional idea forwarding.
- `visualLoop.js`, `visualLoopPrompts.js`: allow empty narration only for the
  explicit loop format and use a loop-specific review checklist.
- `bundle.js`: `CB5_LOOP_SOURCES` and no required subtitle role when sealed
  draft metadata has `video_type: "loop"`.
- `dashboard/server/episode/engines/codebuilt/jobFolder.js`: hash-verified
  loop input set (path pack and brief only), subtitle-free output collection.
- `engines/codebuilt/producer.js`: loop post runs without staging voice/words.
- `blender_worker/codebuilt/loops.py`: phase, sinusoidal values, cyclic camera,
  and cosine-timed forward/backward replay of baked state. Replay is explicitly
  stylized reversal, not a claim of unforced physical dynamics.
- `blender_worker/codebuilt/renderloop.py`: independently pose/render diagnostic
  frame N after the ordinary frames, only for the host's loop path-pack contract.
- `blender_worker/codebuilt/audio.py`: original periodic synthesis with a smooth
  rhythmic rest at the boundary, no samples or whole-track fade.
- `narrative_factory/codebuilt/post/{cb5.py,run.py,loop.py}`: loop dispatch,
  shared grading/encoding without captions, endpoint exclusion, seam and sound gates.
- `narrative_factory/codebuilt/qa/{loop_seam.py,gate.py}`: endpoint image
  comparison and loop-aware QA entry point.
- `.claude/skills/codebuilt-loops/SKILL.md`, `paths/codebuilt.json`: guidance
  loaded at the loop step only; existing narrated skill assignments unchanged.
- `dashboard/server/tests/codebuiltLoop.test.js`,
  `narrative_factory/codebuilt/qa/test_loop_seam.py`: the two requested regressions.

The boundary files beyond the lane's original list were necessary because the
runner previously required script/voice/word/subtitle artifacts and visual
review required nonempty narration. Their changes are limited to those format
conditions. `draftAdapter.js`, all other lane B files, and planner's `SET_BUILD`
and `MESH_CALL` lines are untouched. `voice.js` and `factCheckStage.js` need no
changes: the starter never calls them for a loop.

## Verification

- `npm ci` in `dashboard/server`: passed, 70 packages, zero vulnerabilities.
- `npm test` there: all 42 tests pass, including all 41 unchanged existing tests
  and the new silent-job test. Its runner/draft adapter are injected fixtures;
  it does not claim the production draft adapter supports loops yet.
- `python -m pytest blender_worker/codebuilt/test_shotcheck.py narrative_factory/codebuilt/qa/test_loop_seam.py -q`:
  3 passed. The seam regression accepts independently written equal endpoints
  and rejects a displaced subject.
- Python compile checks on the touched kit, post and QA modules passed.
- `python tools/license_check.py`: passed, 28 registered entries. It still
  prints the repository's existing 19 source re-read reminders. No outside
  resource or dependency was introduced by this lane.
- Source comparison with `HEAD`: `scriptPrompt`, `buildPrompt`, and the
  production-choice prompt definitions are byte-identical. The two existing
  video types retain their prompt text and assigned skills.
- Real proof source passed `validateBuildScript`, `pythonSyntaxCheck` and
  `pythonQaStructureCheck`. Real input hash verification accepted only
  `pathpack.json` and `brief.md`; output collection accepted video/sheet/report.

## Real proof and calibration

All proof files are in this worktree under
`output/agent-jobs/loop-proof-20261114/` (ignored outputs, not committed).

- `build/build.py`: hand-written eight-second periodic marble/rotor scene.
  This is a renderer/post proof, not a claim of a live model-generated job.
- `proof-launch.json`, `container.log`, `work/gpu.json`, `work/executor.json`,
  `work/render-timing.json`: launch and render evidence. The installed GPU
  executor ran successfully through the existing Docker fence argv builder,
  network none, read-only root/kit, uid 1000, dropped capabilities and limits.
  The shared `C:/code/ForgeAi/.superpowers/supervisor/gpu.lock` was acquired
  and released. No second GPU render was needed.
- This proof passed the explicit worktree job root to the fence argv builder.
  Production `composeCodebuiltRunner` still pins the main checkout's job root;
  its root policy was not widened for this lane. No production dashboard run
  was claimed. Post was invoked through the normal isolated `cb5_main.py` entry.
- `frames/0000.png`, `frames/0120.png`, `frames/0239.png`: opening, middle and
  final encoded poses, inspected personally. The marble moves around the track.
  The proof has excess top space and a bright track; it is not a polished pilot.
- `frames/0240.png`: independently posed/rendered frame after the last, excluded
  from encoding. No opening-frame copy, crossfade or jump concealment.
- `out/video.mp4`: actual **8.000 s, 1080×1920, 30 fps**, audio present.
- `out/contact_sheet.png`, `out/report.json`, `out/audio/loop.wav`.
  There is no `.srt`, narration script or word-timing file in the proof.
- Endpoint MAE **0.013430748/255**, p99 max-channel error **1/255**. Limits are
  MAE **1/255** and p99 **8/255**. This admits the small observed independent
  GPU/denoiser variation while remaining tight at 8-bit pixel scale.
- `seam-displaced-control.png`, `seam-control.json`: a 20-pixel horizontal
  displacement of the real opening frame fails at MAE **7.548357964**, p99 **163**.
  These are empirical bounds from one scene, not a general perceptual guarantee.
- The synthesized source seam step is about **2.10e-51** (ordinary maximum
  adjacent-sample step **0.00219373**). The delivered AAC's seam step is **0**
  (ordinary maximum **0.00220768**), measured after decoding the exact video
  duration and excluding codec padding. The post gate requires its seam step
  not exceed its ordinary maximum plus one PCM16 code value. Nobody listened.

## FAILING UNTIL INTEGRATED: draft adapter contract

Per the owner's follow-up, `draftAdapter.js` is deliberately untouched. The
supervisor must integrate after lane B lands. Current production draft creation
still requires the narrated audio/subtitle sources and will fail for this loop;
there is no placeholder subtitle, fake narration or alternate adapter workaround.

The host-written, validated report is **`out/report.json`**:

```json
{
  "version": "codebuilt-cb5-v1",
  "video_type": "loop",
  "status": "ok",
  "subtitles": null,
  "duration_seconds": 8,
  "post": { "ok": true, "probe": { "duration": 8, "width": 1080, "height": 1920, "fps": 30 } },
  "seam": { "passed": true, "mae_rgb_255": 0.013430748, "p99_max_channel_255": 1, "mae_limit": 1, "p99_limit": 8 },
  "length_check": { "min_s": 6, "max_s": 20, "actual_s": 8, "within_tolerance": true },
  "audio": { "passed": true, "encoded_seam": { "passed": true } }
}
```

Existing report fields still apply. Report path strings are diagnostic only;
never follow them. After accepting this report and its loop seam/length/audio
verdicts, choose the fixed exported **`CB5_LOOP_SOURCES`** from `bundle.js`:

| Role | Job source | Draft destination |
|---|---|---|
| video | `out/video.mp4` | `video.mp4` |
| code | `build/build.py` | `build.py` |
| audio | `out/audio/loop.wav` | `audio.wav` |
| report | `out/report.json` | `report.json` |
| contact_sheet | `out/contact_sheet.png` | `contact_sheet.png` |

Omit the subtitles role entirely, set `script: ""` without reading an SRT, and
preserve **top-level `metadata.video_type: "loop"`**. This exact metadata field
allows `verifyCodebuiltDraft` to omit the required subtitle role. Keep the
existing bundle digest/receipt logic over all present roles. Preserve the
premise title/description changes from lane B. No subtitle or voice artifact
is required or manufactured for loops.

## Left for integration/review

- Draft adapter change above, then a live dashboard/router-to-draft acceptance
  run with lane B's loop topic provider and a loop channel profile.
- One different-model review before merge (supervisor's next step). No child
  agents were started, no merge or push performed.
- Loop resumes currently re-plan rather than reusing narration-bound cached
  planner artifacts. An already prepared runner job with changed generated
  code fails its existing immutable-input check; start a fresh job in that case.
- Human listening and owner quality review remain undone.

## Brain note:

Loop reports use `video_type: loop`, no SRT, and `out/audio/loop.wav`; draftAdapter integration is deliberately pending. — codex · gpt-6.1-sol
Frame N is separately rendered seam evidence, never encoded; raw and delivered-audio seams are checked. — codex · gpt-6.1-sol
