---
author: codex ? gpt-6.1-sol
created: 2026-11-14 15:45 +02:00
updated: 2026-11-14 16:13 +02:00
updated_by: codex ? gpt-6.1-sol
status: integrated-and-verified
---

# Lane D2: loop integration

Merged `t3/add-seam-safe-loop-format` (36f7815) into
`t3/loop-draft-integration`, based on main b9b8fb4. Nothing pushed, merged to
main, uploaded, or added to channel/account data. No dependency or outside
resource was introduced. This report replaces the earlier incomplete adapter report.

## Review findings resolved

1. **Motion:** `renderloop.py` independently poses 0, N/2 and N before any PNG render; static and unclosed state fail. `post/loop.py` also checks all delivered adjacent frames, half-cycle change and frozen runs.
2. **Draft:** the starter passes its host-owned `contentMode` as `videoType`; loop drafts use `out/audio/loop.wav`, omit subtitles, have an empty script and top-level `video_type: "loop"`. The copied report must confirm type, seam, length, source audio and encoded audio. Loops refuse the legacy manifest layout. Premise title and answer-first description remain intact.
3. **Local seam:** the existing global MAE/p99 checks now also require every 64 px tile mean to be <=2/255, including partial edge tiles.
4. **Text:** the loop validator refuses `text_add`, bare/aliased `stage.text`/`stage.hud_text`, and positional `FONT`; the review checklist explicitly asks whether any glyphs are visible.
5. **Resume:** loop jobs are not resumable; status exposes ?Loop jobs cannot resume; start a new loop job? and the resume action refuses them. Narrated reuse stays intact.
6. **Integrity:** the hash-verified path pack selects the input set. A missing `vo.wav` hash in a narrated job fails closed; missing/invalid path packs also produce `INPUT_CHANGED`.
7. **Short duration/type:** Auto accepts 6?20 seconds only with a loop channel profile; explicit factual/what-if still require narrated lengths. Explicit owner type wins over channel format. Direct starter requests also understand Auto.
8. **Audio variation:** SHA-256 of topic text selects root pitch, partial set and integer pulse rate in the original `audio.py` synthesis. Fourier bins and modulation remain periodic on the exact sample grid.
9. **Small findings:** removed internal research/lane lines, refused `use_animated_seed`, removed the unused loop QA branch from `qa/gate.py` (the active gate is loop post), and added frame-filling subject, occupied top third, immediate motion and half-cycle guidance to the skill.
10. **Map wiring:** direction receives topic+script, narrated build receives topic+script, and loop build receives topic+idea/brief when loading build/topic guides. Loop-specific guidance takes precedence. Both maps and loops remain registered in the shared pack.

## What the state gate compares

Object evaluated world matrices (including parent transforms), object render
visibility, active camera identity and its world matrix, lens, ortho scale,
shifts, clipping, sensor dimensions and numeric depth-of-field values; light
energy, colour, radius/size and spot settings; material diffuse colour,
metallic and roughness; numeric/vector input and output defaults on material,
light and world shader nodes. The view layer/dependency graph is updated at
each pose. Numeric equality uses abs 1e-5 / relative 1e-6 tolerance; nonnumeric
camera identity must match exactly. A regression covers Blender's sequence
protocol vectors, which do not expose `__iter__`.

This is a cheap supported-state check, not a complete comparison of arbitrary
mesh topology or every Blender property. The pixel gates supply independent
visible-motion and seam checks after rendering. Builds must still obey the
pure-function pose contract.

## Threshold calibration on real frames

All pixel numbers below are mean absolute RGB differences on the 8-bit scale.
The rebuilt proof has mean adjacent difference **1.063788**, half-cycle
**1.280169**, and zero frozen steps. Floors **0.1** for the mean consecutive
step and **0.2** for half-cycle change are about 10x and 6x below those measured
changes, while exceeding the independent-render background discrepancy
(global **0.012587**, worst tile **0.035400**). A step below **0.05** counts as
frozen; **15 consecutive such steps at 30 fps (0.5 s)** refuses the loop.
These are conservative bounds from this proof, not a general perceptual metric.

The tile limit **2** admits the proof's **0.035400** worst tile and rejects the
reviewer's erased-sphere **103.355553** and 100 px block **80.991943**, despite
their global MAE being only **0.848597** and **0.488230**. The global seam limits
remain MAE <=1 and p99 <=8. Calibration is in
`output/temp/loop-d2/calibration.json`.

## Verification

- `npm ci` in `dashboard/server`: 70 packages, zero vulnerabilities.
- `npm test` there: **48 passed, 0 failed**; loop draft/source receipt refusal and narrated missing-hash regressions included.
- `python -m pytest -q`: **18 passed, 6 subtests passed**; preflight static/nonperiodic, vector matrices, pixel motion/frozen runs and small-tile seam damage covered.
- `python tools/license_check.py`: **passed, 29 entries**; existing 19 source re-read reminders remain.
- `compare.mjs`: main b9b8fb4 and current prompt captures deep-equal byte for byte for factual and what-if script/direction/build with unmatched topics. Sizes respectively 8718/11816/40342 and 8965/11905/40431 bytes. Matching direction/build topics include `codebuilt-maps`; loop topic matching also checked.
- `draft-compare.mjs`: narrated draft metadata deep-equal to main, including premise handling.
- `choices.mjs`: explicit type wins, short Auto without loop profile refuses, loop-profile short duration accepts, failed loop status/action refuse resume.
- `validators.mjs`: actual planner validation refuses `text_add`, alias assignment, positional FONT and animated seed; loop topic guide loads.
- Audio manual comparison: same topic gives identical samples, different topic differs, second topic remains seamless.
- `git diff --check HEAD`: passed.

Scratch scripts and detailed outputs: `output/temp/loop-d2/` (including
`npm-ci.log`, `npm-test.log`, `python-tests.log`, `licenses.log`,
`prompt-comparison.json`, `narrated-draft-comparison.json`,
`choices-resume.json`, `validator-checks.json`).

## Real proof and its limits

`planCodebuiltLoop` was attempted through its existing router, without API keys;
it returned **?Claude CLI is not set up?** (`model-attempt.json`). Therefore the
permitted hand-written fallback was rebuilt. The existing proof's camera was
aimed lower to raise the subject into the top third. First, middle and last
frames were personally inspected: the balls exchange sides and return; the
final frame approaches the opening naturally. The track is still overbright
and this is a technical proof, not a polished pilot. Nobody listened to audio.

`output/temp/loop-d2/proof.mjs` sends `{type:"Auto", channelId, duration:8}` to
the real coordinator and starter with an in-memory loop profile, an injected
topic/premise and the hand-written source supplied through the planner's
validated reply boundary. Visual model review and light metadata are injected
because the CLI is unavailable. The real policy-pinned GPU executor renders,
the real isolated `cb5_main.py` post step runs, and the real draft adapter writes
a sealed draft. Its summary is **done=1, failed=0, drafts=1**.

The harness uses the existing Docker-fence argv builder with this worktree's
explicit job root, network none, read-only root/kit, uid 1000, dropped
capabilities and resource limits, and acquires/releases the shared GPU lease.
Production's fixed job-root policy was not widened. This does not claim a live
HTTP/dashboard/model/visual-review production run or the full host fence runner.

Proof files (ignored, local to this worktree):

- `output/agent-jobs/loop-d2-proof-v2/build/build.py`, `proof-launch.json`, `container.log`, `post.log`, `work/{gpu,executor,render-timing}.json`.
- `frames/{0000,0120,0239}.png`: inspected first/middle/last; `frames/0240.png`: independently rendered diagnostic endpoint, excluded from encoding.
- `out/video.mp4`: **8.000 s, 1080?1920, 30 fps**, audio present; `out/report.json`, `out/contact_sheet.png`, `out/audio/loop.wav`; no narration/words/subtitle files.
- Source audio seam step about 2.10e-51; delivered AAC seam **6.33e-11**, ordinary max step **0.002207**: both pass.
- Draft: `output/temp/loop-d2/drafts/cb-loop-d2-proof-v2/{metadata.json,video.mp4,audio.wav,report.json,...}`; top-level loop type, empty script, premise title/description, no subtitle role.
- `output/temp/loop-d2/request-result.json`: request, completed run and job records; job `premise.json` is present.
- `output/agent-jobs/loop-d2-static/` and `loop-d2-nonperiodic/`: real executor negative controls, **exit 1 with zero PNGs**; no-motion and N!=0 refusal respectively. `preflight-controls.json` records both.

An initial preflight attempt exposed the vector snapshot bug and rendered zero
frames; its failed job `loop-d2-proof` remains as evidence. Only one full GPU
proof was rendered. No GPU lease is left held.

## Files changed

- `dashboard/server/episode/codebuilt/`: `productionChoices.js`, `planner.js`, `start.js`, `lengthCheck.js`, `runCoordinator.js`, `draftAdapter.js`, `visualLoop.js`, `visualLoopPrompts.js`, `bundle.js`.
- `dashboard/server/episode/engines/codebuilt/`: `jobFolder.js`, `producer.js`.
- `blender_worker/codebuilt/`: `loops.py`, `renderloop.py`, `audio.py`.
- `narrative_factory/codebuilt/post/`: `cb5.py`, `run.py`, `loop.py`; `qa/`: `gate.py`, `loop_seam.py`, `test_loop_seam.py`, `test_loop_motion.py`.
- `dashboard/server/tests/`: `codebuiltLoop.test.js`, `codebuiltLoopDraft.test.js`.
- `.claude/skills/codebuilt-loops/SKILL.md`, `paths/codebuilt.json`, this report.

The adapter/job-folder/bundle/coordinator/producer/visual-review boundary files
are the necessary integration beyond the lane's initial ownership list. Lane
B premise writing/forwarding and lane C registration remain intact.

## Left

Live model-driven dashboard/visual-review proof and owner audiovisual approval
remain unperformed. No push or main merge is requested or performed. The
implementation and required checks are complete on this branch.

Brain note:
Loop drafts require host videoType plus source/encoded audio receipts; loop resume is intentionally refused. codex ? gpt-6.1-sol
The offline request-to-draft proof is loop-d2-proof-v2; live router was unavailable, so the source/topic were injected. codex ? gpt-6.1-sol
