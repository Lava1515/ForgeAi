# S1 safe-area diagnosis and CPU probe

Author: codex · gpt-6.1-sol. Created: 2026-11-15 13:02 +02:00.

Run `node tools/codebuilt/probe-text-visibility.mjs` from this checkout. Outputs go only to
`C:/code/ForgeAi/output/agent-jobs/s1-qa-probe-1254`. The runner uses the approved CPU
generated-code entry through `runIsolatedJob`, including the normal job lock, shared main
GPU lease, image approval, resource limits, watchdog and verified container cleanup. It
requests no GPU and never calls rendering or scene saving. The kit is mounted from the
checkout, not main. The copied historical scripts execute only inside that fence: their
AST is cut before the first top-level `shotcheck.run_qa`, so the QA/render tail never runs.
This is a bounded pose replay, not a full video proof.

## Cause and evidence

The runtime is Blender **5.2.2 LTS**. Actual failed stderr traces run
`shotcheck.run_qa -> run_qa_with -> BlenderProbe`, not `sample_text` (no such path exists
in this checkout). Main's current shotcheck SHA256 is
`4ec7f17e4b551115a9f3da891580e481c16d7b954c3a33b3783adf663899aac7`;
the initial CPU probe mounted exactly that source hash. Historical jobs did not record
their kit hash, so the precise historical mount bytes cannot be independently established.
There is no observed transform/collection-filter defect: a hidden place excludes cd1;
scale-zero gauge excludes its gl100 child, and restoring scale restores it.

The old error summary unions object names and frame numbers independently. It does NOT
say that every named object failed at the first listed frame. Actual CPU pose replay:

- M2 r1 source SHA256 `8d9811efc7eb78c72f6e69c2083f066ad176f146ee1b8b970b4c3532dcee86e1`:
  t76 xmax 1.03727 at frame 319; gl0/gl100/gl150/gl200 have world scale 1 at frame 494,
  when shot_3 has explicitly restored the gauge. The gauge is correctly absent at 319.
  M2 r0 also has an independent missing `off` helper; replay therefore uses r1.
- M4 r1 / pv2 executor source SHA256
  `400c9097c951aa93bdb590c7366c2ac13f00ed15c81390228c09fc0ec2e768ee`:
  tagw y .95115-.98080 at frame 0 in place-wall; rd_clasts y .92314-.98725
  at frame 384 and rd_calc y 1.12566-1.15364 at 744, both in place-cutaway.
  yct x 1.44304-1.60409 at frame 452 in place-lab. No hidden-place text appears at frame 0.
  The old HUD helper treated world-unit offsets as safe independently of lens/distance.

## Change and regression

Replaces d06a3b3's reset-only prompt addition. `stage.fit_text(cam, explicit_world_labels)`
widens the current perspective lens after cam.set; world labels keep their transforms.
The planner requires this before placing HUDs and asks for redesigned framing when a wider
lens makes the subject too small. `stage.hud` fits actual readout bounds by shrinking and
shifting the requested placement. QA covers the UNION of font glyphs and plate (previously
it checked only the plate, potentially missing overhanging glyphs). QA diagnostics now
pair each label with its own first/last failing frame and first box. Nothing hides
persistent labels or makes safe-area QA more permissive.

The pure regression was observed failing with ImportError before adding text_frame_factor.
The actual Blender probe asserts hidden collection/parent semantics, preserved world-label
scale, fitted HUD bounds and width at 24/85 mm, glyph coverage with an undersized plate,
and continued rejection of a deliberately clipped visible world label. Sampled original
M2/M4 poses have zero clipped boxes after fitting. M2 lens range 4.35-40 mm; M4 11.90-70 mm.
Such extreme wide lenses can compromise composition; the numeric result is not visual approval.

`work/visibility.json` records exact current kit/stage hashes and paired frame/object boxes;
`work/fence.json` records the applied read-only checkout mount, no GPU, 1 CPU, 2048 MiB,
network none, and verified cleanup. `work/executor.json` records exit 0 and **zero frames**.
The final wrapper status is **audit_incomplete**: Windows snapshot reads of pagefile.sys,
swapfile.sys and DumpStack.log.tmp return EPERM, and no secret values were supplied for
the optional leak scan. Do not report a complete containment audit. No fence was weakened.

## Handoff gate

This changes mounted kit code. Independent cross-family **security review is still required**;
the confirmed CPU probe is supplied, not a substitute for review. Do not merge while M4
is active. No main source, client/draft files, running artifacts, dashboard process or GPU
render was changed. Full cadence, occlusion, shot-variety and visual-composition proofs
remain for the supervisor after review and the safe merge window. No dependencies added.
