# ForgeAi backlog

## Found, not built

### Uploader (owner 2026-11-20 16:00) · branch t3/uploader · claude-pro · claude-fable-5-2

Decision: `ForgeBrain/decisions/2026-11-20-owner-separate-uploader-on-vm.md`. Plan: `docs/plans/2026-11-20-uploader-service-plan.md`.

- `uploader/`: separate server and page, hand-over through a folder (`UPLOADER_SHARE`), slots and daily limit per channel, own YouTube sign-ins. Replaces P2 (auto release in the dashboard), which stays off; removing P2 is a later lane.
- Dashboard: "Send to uploader" in the Publish box (`routes/uploader.js`), results read back in the schedule loop. Manifest category is Education (27); the direct Publish button still sends 24.
- Not proved by a real upload yet. Owner steps before the first one: add the redirect address in Google Cloud, create the channels, connect them on the uploader page.

### Speed and faults 2026-11-20 17:38 · MERGED 0f60c32 · claude-pro · claude-fable-5-2 (review codex · gpt-6.1-sol)

Plan: `ForgeBrain/plans/2026-11-20-speed-and-faults-plan.md`; decision `ForgeBrain/decisions/2026-11-20-owner-answers-1740.md`. Not yet shown by a video run.

- A: the card is reserved per voice step, preview render and final render, not for the whole author session; card waits do not count on the author clock.
- B: a failed direction call is tried once more; after two failures the job ends `author_direction` with `failure_cause` (a fixed sentence).
- C: ACE-Step no longer refuses on card use by desktop apps; fallback reasons `pin_mismatch`, `card_busy`, `card_memory`, `card_unknown`, `generation_failed`, `timeout`. Proof `output/agent-jobs/acestep-proof-1120`.
- G: Openverse step removed (owner); register entry kept, marked not in use.
- `scripts/start_dashboard.ps1` now sets the standing settings itself (author session, HyperFrames text, ACE-Step music and the C1 paths).
- NEXT, on the owner's word: batch D (3 videos, Opus, Sol monitors). Then lane E (the first write costs 8 to 10 times its scene code) and F (final render).

### Owner fixes 2026-11-20 13:04 · MERGED 1b77359 · claude-pro · claude-fable-5-2 (review codex · gpt-6.1-sol)

Decision: `ForgeBrain/decisions/2026-11-20-owner-answers-1304.md`. None proved by a real video run yet.

- Exposure repair: its own 30 minute clock; a failed repair keeps the first finished video as the draft (`exposure_repair` on the job).
- Pause and Kill Switch act on code-built batches and jobs; a paused or halted pipeline refuses a new batch, a single video and a resume.
- Research form creates a teardown as a teardown.
- Map: kit finding `map_material_replaced` goes to the author (blocks a pass in round 0 only); rule in the codebuilt-maps skill. Closes the F11 line below.
- Cleanup: Growth page wording, old stills client code and the stale One author client test removed.

- F11 (answered 2026-11-20, see above): Dingo job mwns1inh-0cdbd0 replaces AUS kit materials with an opaque custom two-colour shader in build_map(); kit defaults cannot add relief beneath that authored override. Future author fix: retain map_land and tint through its fill controls. codex · gpt-6.1-sol · 2026-11-19 20:04 +02:00.

- 2026-11-19 15:54 +02:00 · codex · gpt-6.1-sol (C4): retained shared kit no-overlay modes, overlay schema fixtures, base buildPrompt/KIT_CONTRACT, and the channel engine enum where authored/direct callers still use them or removal is uncertain; the HyperFrames legacy overlay TEXT fallback is deliberately kept.

### Fix lanes F6 to F9 (owner 2026-11-19 19:30, tonight; ids repeat the older F6 to F9 of 2026-11-18, these are the new ones) · 2026-11-19 19:45 +02:00 · claude-pro · claude-sonnet-5-5

Scope-fence additions (ORDERS "Owner order 2026-11-19 19:33"); source: `output/agent-jobs/fable-check-3/REPORT.md` "Not covered by any lane". Build on branches while the three B3 videos run; merge only after they are terminal, at zero jobs, with one cross-family review, the full suite and the licence check. None may change the job fence, the fact check's strictness or publishing.

| Id | Lane | State | Files and done when |
|---|---|---|---|
| F6 | A final with large black areas goes back to the author once | READY, one branch with F8 and F9 (worker A) | `exposureCheck.js`, `authorLoop.js`, `start.js`, tests; the A2 exposure check on the final stops being advice only: a large pure-black area sends the video back to the author once, then ships as is. |
| F7 | What-if gives no topic | READY (worker B) | `autoTopic.js`, `theme.js`, tests; the raw topic answer is saved when rejected, the cause is found and fixed. |
| F8 | Opus's first write call can pass the 20 minute limit | READY, same branch as F6 (worker A) | `authorLoop.js` (write timeout and its guard only), tests; a limit that fits Opus so "Opus on retry" works; Sonnet's limit unchanged. |
| F9 | Opening frame shows the whole subject | READY, same branch as F6 (worker A) | `previewSheet.js`, `visualLoopPrompts.js`, `exposureCheck.js`, tests; one check on frame 0 (subject whole and readable), reported to the author in its rounds. |
| F10 | Surfaces and the asset library are not optional on the authored route | READY (worker C, builds on t3/integration-f) | `assetCatalog.js`, authored contract text in `planner.js`, `.claude/skills/codebuilt-author/SKILL.md`, `.claude/skills/codebuilt-scene-generation/SKILL.md`, a check beside the A2 exposure check (`exposureCheck.js`), tests; main subject and ground carry a surface helper or library texture, light from a library sky/room image, one check counts plain `materials.pbr` on subject and ground and reports it to the author, one round to fix; small things may stay plain. |
| F11 | The Earth and the flat map look like the Sonnet tools-demo short | READY (worker D) | `blender_worker/codebuilt/sets/globe.py`, `sets/world_map.py`, `maps.py` (look only), map materials in `materials.py` (`earth_relief`, `map_land`, `map_sea`); globe by default rich colour, lit edge, dark space with stars; flat map shows the relief under the country fills; proof: before/after stills of job mwns1inh-0cdbd0 at 540x960 beside `output/agent-jobs/tools-demo-1119/sonnet/final_sheet.jpg`; no new image downloaded. |

One list for everything the owner wants in ForgeAi. Updated 2026-11-14 by claude-pro Â· claude-sonnet-5-5.
`READY` = nothing outside the code blocks it; the fleet can take it. `OWNER` = waits on the owner. `PARKED` = the
owner put it later. Each lane lists the files it mostly touches so two workers do not collide. Workers work in
worktrees and merge only after the running video run is finished (CLAUDE.md rule 2).

## How the fleet takes this list (owner, 2026-11-14)

Launch every READY lane. Put most of the workers on one lane at a time (the focus lane); the rest of the lanes
run with the spare workers, one worker or two each, and never on a file another lane is editing. Sol supervises.

## Make the videos better and cheaper

### Kola phase 1 · 2026-11-17 13:15 +02:00 · codex · gpt-6.1-sol

Owner orders 13:14 and 13:34; binding contracts, lane requirements and proofs: `ForgeBrain/plans/2026-11-17-kola-into-pipeline-fleet-plan.md` sections 2–5, 3a, 3b and 6a. Updated 2026-11-17 13:34 +02:00 by codex · gpt-6.1-sol: KS1 added, KJ1 story rule required; after phase 1 proof and push, continue approved phase 2 with Sonnet as author. No video run, dashboard start or publishing. Stop after phase 2.

| Id | Lane | State | Files and done when |
|---|---|---|---|
| KA1 | Kit saves screen positions | MERGED c085907; final review and limited-audit CPU proof pass | `blender_worker/codebuilt/anchors.py`, `renderloop.py`, tests; strict per-frame anchors, resume and fenced CPU cross-position proof. |
| KO1 | Overlay layer in post | MERGED 63dc91d; review/replay pass | `post/overlay.py`, `anchors_file.py`, `run.py`, `cb5.py`, shared fixtures/tests; strict readers, six elements, layout findings, eight-frame Kola replay. |
| KJ1 | Journey format and premise gate | MERGED 065ceae; code review and five corrected premises pass | journey skill, paths JSON, `autoTopic.js`, `theme.js`, `direction.js`, `skills.js`, tests; format-specific behavior and five sourced premises. |
| KR1 | Render look measurement | DONE report; Sonnet review pass, caveats recorded | Eight Kola frames host EEVEE/container Cycles/container EEVEE; timing, sheet and recommendation under `output/agent-jobs/kr1-render-look/`. |
| KB1 | Builder overlay contract | PARKED ad0c718; review2 FIX: resume folder collision and overlay AST bypasses | `planner.js`, `overlaySpec.js`, `start.js`, `runJob.js`, `jobFolder.js`, tests; validated immutable overlay input, bounded repair, unchanged old path. |
| KP1 | Previews show final text | MERGED 51b88ce; captions and labels visible in fenced proof | `post/preview_sheet.py`, `previewSheet.js`, `visualLoop.js`, `visualLoopPrompts.js`, tests; captions/overlay on tiles and smoke proof. |
| KS1 | Sound follows the story | MERGED 2874202; final review pass, phase 1 clip levels pending | `post/cb5.py` cue part, `blender_worker/codebuilt/audio.py`, tests; overlay-derived ping/boom/whoosh and counter tone, measured levels/stems, legacy sound unchanged; nobody listened. |
| KE0 | Author design note | PARKED; KE0 design review FIX, dependency/scope/security/cap gaps | Reviewed design before code; section 6 restrictions binding, Sonnet author, KR1 render recommendation and measured token cap. |
| KE1 | One author session | PARKED; approved Kola design blocked by KB1; generic fallback not adopted | `authorLoop.js`, `authorCall.js`, `start.js` switch; host-run fenced previews, no command/network tools, mode off by default. |
| KE2 | Author validator profile | PARKED; approved Kola design blocked by KB1; generic fallback not adopted | `planner.js` second profile; keep forbidden list, fence and previewed-hash gate. |
| KE3 | Author security review and fixes | PARKED; no approved KE1/KE2 implementation to review | Different model family reviews tool scope, files, caps, hashes and fence with applied probes. |
| KX2 | Fenced author proof | PARKED; KB1 overlay integration and author implementation unavailable | Kola scene built in author mode inside fence, beside handmade frames; no pipeline video run or draft. |

Parallel lanes added 2026-11-15 16:12 +02:00 by codex · gpt-6.1-sol; owner plan: ForgeBrain/plans/2026-11-15-parallel-lanes.md. All branch changes require cross-family review and zero active jobs before merge; GPU proofs remain serial.

| Id | Lane | State | Files and done when |
|---|---|---|---|
| V1 | Readable on-screen diagrams | MERGED; integrated Auto proof running | Scene-generation/look-review skills, visualLoopPrompts.js, isolated diagram helpers; evidence-backed generic fix and fenced CPU label-size proof. |
| M5p | Teardown pre-flight | MERGED; teardown video proof pending | stealth_jet_teardown set and teardown skill only; fenced CPU set build and dry plan pass before M5. |
| M6p | YouTube rules pre-flight | MERGED; integrated proof running | Read-only prompt audit; report each live M6 rule and omissions, later fixes limited to autoTopic.js title rules. |
| L1 | Length drift | MERGED; duration proof running | Diagnose words/pauses behind 36.6–37.4 s for 30 s; later bring median below 34 s, planner/pace code waits for E1a. |
| B1 | Unmerged branch salvage | MERGED research summary; preserved branches retained | Preserved job-detail-artifacts, 807b5801, m1-fetch-baseline and speed-up branches; identify patch equivalence, value and render-speed port plan. |
| R2 | Endings research part 2 | MERGED evidence report; unavailable acoustics documented | Recover 18 missing transcripts and measure last-two-second pitch/energy in ten Shorts where licensed audio is available; report unavailable evidence explicitly. |

| Id | Lane | State | Notes and main files |
|---|---|---|---|
| E1 | Endings that land | MERGED; integrated Auto proof running | Script payoff/callback and final voice delivery; music unchanged. E1a skills + planner.js, E1b voice.js + story_tone.py. Cross-family review each; merge only after M4 verdict and zero active jobs, restart once, then 3-video E1 proof before M5/M6/final Opus tests. Plan: ForgeBrain/plans/2026-11-15-E1-endings-that-land.md. Added by codex · gpt-6.1-sol, 2026-11-15 16:06 +02:00. |
| M1 | Fact check speed | VERIFIED; 3 of 3 completed | One pass took about 447 s, nearly all page fetches. Fetch in parallel, cap per page, cache by URL. `episode/codebuilt/retrievalAdapter.js`, `routes/storySources.js` |
| M2 | Failure triage | VERIFIED; 2 of 3 completed after fix | Same-anchor repair corruption fixed in `055c8e2`; authenticated proof `run-mwh9gsb2-cee02d` completed two videos. Third stopped at safe-area QA: generated gauge labels clip during the camera move; repair helper retained, no reusable pipeline bug found in persisted evidence. Launcher token fallback `c5d6b69` merged. `episode/codebuilt/planner.js`, `start.js` |
| M3 | Map video proof | VERIFIED 2026-11-15 (run-mwhj2pcf-5a5123: 2 of 3 done with world_map used; third stopped at fact check, a content block) | Make 3 narrated map videos through the real path (type factual, map theme) and fix what breaks. Needs the running video run to be over. `blender_worker/codebuilt/maps.py`, `sets/world_map.py` |
| M4 | History video type | MERGED; initial proof 1/3 done, repaired proof pending | A `history` type next to `factual` and `whatif`: period places and people, sourced dates and numbers. `episode/codebuilt/productionChoices.js`, `planner.js`, `autoTopic.js`, new skill `codebuilt-history` |
| M5 | Teardown, stylized first | MERGED; teardown proof pending | The simple "how it works" version of one subject (the stealth jet), built from our own shapes, every part name sourced. Realistic and detailed teardown comes later. Own `blender_worker/codebuilt/` files and a skill |
| M6 | Apply the YouTube research | MERGED; proof pending | Turn `ForgeBrain/research/youtube-shorts-2026-11-14` findings into pipeline rules (first two seconds, length, title). The owner confirms the list before it merges. `episode/codebuilt/` prompts and skills |
| T1 | Teardown as a real video type | MERGED 27b099a; runtime proof pending | Branch `t3/teardown-video-type` at `8b40750`; server126/client build/licence pass. Runtime set proof remains pending. `productionChoices.js`, `planner.js`, `autoTopic.js` |
| E4 | One more ending attempt | PARKED; single attempt failed schema gate | Exact `1793f44`: 24 primary calls, 23 valid outputs; NEW pair5 BAD_JSON. No resampling, blind comparison or factual-support verdict. Evidence: `output/agent-jobs/e4-attempt/`. E1 remains live; E2/E3 stay parked. |
| N1 | Maps first for Auto | MERGED 2de936f; profile activation and combined proof pending | Auto on the channel it uses makes map explainers; the niche sits in the channel profile, nothing hardcoded. Premise scoring rewards a person or "you" with a stake and a familiar place; titles 4 to 8 plain words, no units; `not_repeat` checks every past draft (Panama Canal, Roman concrete and Eratosthenes were each made twice). `autoTopic.js`, `theme.js`, channel profile |
| S2 | Scripts with stakes and full feelings | MERGED ff37b4f + duration wiring 2ce22a1; combined proof pending | Several story shapes instead of hook, facts, closing line. Feelings beyond the seven mild ones: add tense, worried, urgent, awed, funny. Keep every beat's delivery in the voice (today `story_tone.py` drops all but the hook's and the ending's). Fact check unchanged. `planner.js`, `voice.js`, `narrative_factory/story_tone.py`, skill `codebuilt-script` |
| X1 | Surface kit and first-frame check | MERGED 21e866d; actual CPU proof, combined video proof pending | `materials.py` has four helpers and recent builds use plain colours only. Add code-built surfaces (wood, brushed and painted metal, concrete, rock, water, ice, glass, rubber, fabric, soil, grass) with bump and worn edges; CC0 photo sets from Poly Haven or ambientCG where better, each in `licenses/register.json` first; rounded edges, contact shadows, richer view transform. Look review fails a flat-colour main subject and a first frame that does not show the subject. Proof: fenced CPU swatch sheet. `blender_worker/codebuilt/materials.py`, `stage.py`, skills `codebuilt-scene-generation`, `codebuilt-look-review` |
| Q1 | Overlap videos in a batch | MERGED 2ce22a1; throughput proof pending | Measured on 6 Auto videos: 38 min each, of which about 18 min (topic, script, fact check, direction, scene code) leave the graphics card idle and about 20 min (previews, looks, final render) leave the writing models idle. While video N previews and renders, video N+1 does its text steps and scene code. One job on the graphics card at a time; the voice step (about 1.4 min, needs the card) queues for it. Each job still writes only inside its own folder. Target: a 3-video batch at 25 min per video or less with the same checks passing. `episode/codebuilt/runCoordinator.js`, `start.js` (no planner.js changes; S2 owns that file) |
| Q2 | Lighter final render | PARKED 0dbb0a7; CPU gain absent, GPU and wider shader quality unproven | Final render averages 12.9 min for about 950 frames: Cycles on the card, 10 to 12 samples, 12 light bounces, caustics on, RGBA PNG. Port the kept render speed-ups (B1 salvage, branch `t3/speed-up-codebuilt-render-pipeline`) and try fewer bounces, caustics off and RGB output. Proof: the same build rendered before and after, time and a side-by-side contact sheet; no visible loss. Do not halve the frame rate. `blender_worker/codebuilt/renderloop.py`, `stage.py` (coordinate with X1, which also edits `stage.py`: Q2 goes after X1 merges) |
| A1 | Map premise bank | PARKED; 44 audited candidates, 16 missing plus shape/map-stop holds | 60 map premises in the five winning shapes of `ForgeBrain/research/trend-review-2026-11-16/REPORT.md` (tour of 4 or 5 places, comparison barrage, what-if chain, journey, mystery about familiar countries), 12 per shape. Each: title of 4 to 8 words, first sentence, the places it points at in order, one source link per fact, length guess. No current wars or disputed borders. Up to 3 agy workers, one shape set each, separate output files under `output/agent-jobs/<job id>`; one reviewer of another family removes weak or unsourced ones. Result goes to `ForgeBrain/research/trend-review-2026-11-16/premise-bank.md` |
| L2 | First-look defect census and pre-check | MERGED receipts 02e00c0; extra pre-check PARKED, existing readiness gate already covers proposal | Part 1 (read-only): count the round-0 findings in every `output/agent-jobs/*/visual_loop.json` by kind and say which a code check could catch. Part 2 (after part 1): add those checks before the first look so a build with them is repaired without a model call. `blender_worker/codebuilt/shotcheck.py` and the look-loop caller only; not the look-review skill (X1 owns it). Target: one look round fewer on average |
| C1 | Earth image licence check | COMPLETE; Natural Earth source checked and registered by X1; NASA unused | Check at the source whether Natural Earth raster relief and NASA Blue Marble or similar may be used in monetized videos; write the finding and add allowed ones to `licenses/register.json` on a branch. Feeds X1 |
| R1 | Final review panel | DONE: verdict FIX 2026-11-16 | Three Fable seats, two rounds. Verdict and reports: `output/agent-jobs/final-panel-2026-11-16/VERDICT.md`. One fix round F1 to F5 below; leftovers are listed at the end of the verdict |
| F1 | Map routing and a real Earth on the globe | MERGED; fix proof pending | A map flag from the topic pick loads `codebuilt-maps` and offers the map sets; the globe set uses the registered Natural Earth relief by default. `episode/codebuilt/autoTopic.js`, `skills.js`, `setCatalog.js`, `paths/codebuilt.json`, `sets/globe.py`, `sets/common.py`. Target: 3 of 3 map topics call the map kit; no noise Earth |
| F2 | Preview checks report instead of stopping | MERGED; fix proof pending | Kit checks no longer kill a preview; camera and framing numbers reach the look; a new target counts as a new composition. `shotcheck.py`, `visualLoop.js`, `visualLoopPrompts.js`. Target: rounds without pictures 37% to under 15%, mean look rounds 5.2 to 4 |
| F3 | Builder prompt and refusals | MERGED; fix proof pending | `hold` checked as a keyword argument, `world_map` in the import line, the "3 words per second" line removed. `planner.js` only. Target: 0 false refusals |
| F4 | Direction repair and map phrase rule | MERGED; fix proof pending | A direction with a timing slip is repaired in code, no fallback; skill rule that on a map something new lands with every phrase. `direction.js`, `.claude/skills/codebuilt-direction/SKILL.md`, `.claude/skills/codebuilt-maps/SKILL.md`. Target: 0 fallback directions |
| F5 | The winners' map look | MERGED; fix proof pending | Dark sea, stronger relief, bright country fill with outline, country labels on the flat map. `maps.py`, `materials.py`. Target: country identifiable in a small tile next to the reference frame |
| K1 | Close-up maps | MERGED 210fb6b; CPU still/fenced probe PASS | Bug in F5: a highlight made before `set_border` keeps its world-view lift (the tall glowing Greece block) and a tight `bbox` drops the neighbours. Lift from the country's size and recomputed on `set_border`; padded crop with clipped sea; relief that falls with zoom; skill recipe rewritten. `blender_worker/codebuilt/maps.py`, map parts of `materials.py`, `sets/world_map.py`, `.claude/skills/codebuilt-maps/SKILL.md`. Proof: stills of the Greece close-up before and after (see `output/agent-jobs/fable-look-script-1116/sheets/CASE1_greece_map.jpg`). No video run |
| S3 | Script rules, new style | MERGED 60c496d; five scripts reviewed | A contradiction as hook; the open question said by sentence 2 and answered at the end; at least four sentences of 5 words or fewer, fragments allowed; the turn on its own short line; someone who wants something by sentence 3; delete the "3 words per second" line. Exact lines in `output/agent-jobs/fable-look-script-1116/REPORT.md` section 4. `.claude/skills/codebuilt-script/SKILL.md`, script parts of `planner.js`. Proof: five scripts written by the new rules for the owner to read. No video run |
| SP2 | No full rewrite of refused scene code | MERGED 9b9ed2f; scoped repair limited to samples | `extractPython` joins the reply's code blocks in order when the longest one does not parse; a build refused for a fixable reason is repaired by a scoped edit. `planner.js` build parts. Proof: replay of `output/agent-jobs/.start/mwjj7l2f-c588c5/refused-build-1.py`. Saves 14 to 18 minutes and about 105k tokens when it happens |
| SP1 | Frames to the RAM disk | MERGED 4b05208; pixels/resume/ENOSPC PASS | Render each frame to `/tmp` inside the container, move it to `/job/frames` as one whole-file copy on a helper thread, delete the RAM copy. Measured 22% to 42% less final render time, same pixels (`ForgeBrain/plans/2026-11-16-speed-plan.md`, rig in `output/agent-jobs/render-speed-tests-1116`). `blender_worker/codebuilt/renderloop.py` and its tests. Proof: the same saved build before and after with the rig, pixel difference at most 1 of 255, resume still works, a full RAM disk fails loudly |
| X2 | Surfaces that show | ON HOLD until step A of the merged plan | Shrunk to two defects: the fixed grey second tone and pattern size in metres. Discard the uncommitted checkout `t3/x2-surface-helpers` (bump only). `ForgeBrain/plans/2026-11-17-merged-plan.md` |

## Publish and grow

| Id | Lane | State | Notes and main files |
|---|---|---|---|
| P1 | Upload polish | MERGED; checks passed | Title field in the Publish box; the synthetic-voice disclosure question answered from YouTube's current rules and wired if required. `client/src/components/PublishYouTube.jsx`, `routes/youtube.js` |
| P2 | Auto release | MERGED; OFF until owner enables | Per channel: a switch (default off), a daily cap with no default (the owner sets a number per channel; with none set, nothing is released), a quality bar (fact check passed, length within tolerance, visual check approved), upload with a scheduled `publishAt`, a log of every release. Builds on `releaseDue` in `routes/youtube.js`. The owner turns it on, never an agent |
| P3 | Type to channel map | MERGED; checks passed | Each video type points at a channel in the dashboard; a channel can carry several types. `routes/channelsManager.js`, `ChannelModal.jsx` |
| P4 | Voices page | MERGED; checks passed | Browse and pick the Qwen speakers with their samples (nine samples exist in `output/temp/voice-samples`). New client page and route |
| P5 | Channel stats and growth | PARTLY BLOCKED | Public numbers work now (`routes/channel.js`, `Growth.jsx`). Retention and swipe-away need the YouTube Analytics login scope: OWNER |
| G1 | Growth knowledge base | MERGED 81f30f7 (Codex review MERGE) | `growth/knowledge/` was missing, so every growth prompt ran on a placeholder with no schema. Ten sub-skills and three references, each naming the JSON keys the code reads. `dashboard/server/growth/knowledge/**`. Plan: `docs/plans/2026-11-15-content-growth-lanes.md` |
| G2 | Publishing copy skill | MERGED 81f30f7 | New skill `codebuilt-publish` at `skillsByStep.publish`; the drafting step passes the script and premise, so titles and tags describe the video. `lightMetadata.js`, one call in `start.js`, `paths/codebuilt.json` |
| G3 | Stats watcher and age snapshots | MERGED 81f30f7; live since 22:20 | Each scan stores views over time (`data/trends/snapshots*.json`); videos carry views at 1, 2, 7 and 28 days plus `views_24h`; the existing host loop rescans every 3 h, read-only. `growth/snapshots.js`, `routes/channel.js`, `growth/report.js`, launcher |
| G4 | Growth review skill | MERGED 81f30f7 | New skill `codebuilt-growth`: how an agent reads the numbers, applies the pilot's stop rule and writes a proposal; never publishes |
| G5 | YouTube Analytics numbers | OWNER | Needs `yt-analytics.readonly` on the channel login; then stayed-to-watch, swipe-away, average percentage viewed and viewer countries next to the G3 snapshots. Same blocker as P5 |
| G6 | Growth page over time | MERGED cb8db7e; client build passed | `Growth.jsx`: views at 1, 2 and 7 days, views in the last 24 h, the stop-rule state per channel; `npm run build` in `dashboard/client` |

## Housekeeping

| Id | Lane | State | Notes |
|---|---|---|---|
| H1 | Branch cleanup | PARKED; ownership gate | Delete merged `t3/*`, `fable/*`, `codex/*`, `fix/*` branches after checking each is merged or abandoned |
| H2 | Port on demand | OWNER; no requested port | When the owner wants a feature from `ForgeAi-old`, write it again here against the code-built path |

## Waiting on the owner

- Create the two YouTube channels (steps in `docs/plans/2026-11-14-channel-setup.md`).
- Give the Analytics login scope and a few YouTube Studio numbers (needed by P5).
- Switch auto release on, per channel, when P2 is built and the owner trusts it.
- Scary stories (PARKED): research only so far (`docs/research/2026-11-13-scary-story-visuals.md`).

Updated 2026-11-15 00:05 +0200 by codex Â· gpt-6.1-sol: merged 5bceabc; M1 run-mwgyf268-dbaa4c count3 Auto in progress. Other route proofs pending; public P5 already implemented, Analytics OWNER. H1 deletion limited to own merged branches; H2 requires a requested feature.


Updated 2026-11-15 02:30 +02:00 by codex · gpt-6.1-sol: M1 run-mwgyf268-dbaa4c completed 3/3 with no M1-specific bug; all lengths and measured audio levels passed. First draft visually unapproved; third visual pass retains 2 P1 findings. Verification applies to M1, not clean visual quality. M2 proof is next.

Updated 2026-11-15 07:19 +02:00 by codex · gpt-6.1-sol: M2 verified under ORDERS rule 10 after patcher fix; two completed drafts passed length and measured audio checks. Third generated scene failed text safe-area QA; no Blender runtime reproduction claimed. M1 visual caveats remain. Next M3 map proof.

Updated 2026-11-15 13:07 +02:00 by codex · gpt-6.1-sol: S1 text fitting and paired QA diagnostics merged (security review PASS; lens floor correction CPU-probed), D1 failed visual-check catalog badge merged; main cc8c14e activated at zero active jobs. S1 full video proof pending. H1 removed 48 verified clean merged worktrees and 59 branches; 35 candidates preserved due ignored contents or junctions. M4 initial proof 1 done / 2 failed; diagnosis before rerun.

Updated 2026-11-15 18:05 +02:00 by codex · gpt-6.1-sol: reviewed batch merged through11abc4a at zero active jobs. V1 CPU measurements and existing prevention-primary-v1 policy accepted saved report with supplementary EPERM gaps retained (not exhaustive observation). Server104/Python166/client build pass. Dashboard and factory restarted once idle; Auto3 run-mwi0z8oe-a9a8e3 started18:04. Owner17:15 order supersedes old per-lane proof order: Auto3 then teardown3 then five Opus finals. No restart or mounted-code merge while active.


Updated 2026-11-15 23:27 +02:00 by codex · gpt-6.1-sol: G6 cross-family reviewed exact0d4dc28, merged idle cb8db7e; client build/licence33 pass and premerge server120 pass. Factual final31.47s complete, whatif retrieval failure under diagnosis; history final running. T1/E4 wait for finals and push.

Updated 2026-11-16 04:56 +02:00 by codex · gpt-6.1-sol: T1 reviewed and held until15Auto terminal; E4 single attempt parked after NEWpair5 schema failure. No production ending change merged.

Updated 2026-11-16 08:13 +02:00 by claude-pro · claude-fable-5-2: owner answers 08:13 (ForgeBrain/decisions/2026-11-16-owner-review-answers-0813.md). New lanes N1, S2, X1. The 15-video Auto run stops after the video now building; push main before T1; publishing waits.

Updated 2026-11-16 by claude-pro · claude-fable-5-2: research for N1, S2 and X1 is in ForgeBrain/research/trend-review-2026-11-16/REPORT.md (map premise shapes, pace about 3 words per second, 30 to 60 s, relief Earth base). Read it before building those lanes.

Updated 2026-11-16 08:50 +02:00 by claude-pro · claude-fable-5-2: owner approved lanes Q1 (overlap videos) and Q2 (lighter final render). Later, after the proof videos: a shorter scene-code step and a code pre-check before the first look.

Updated 2026-11-16 09:16 +02:00 by claude-pro · claude-fable-5-2: three slot-filling lanes with no file collisions (A1 premise bank, L2 look pre-check, C1 Earth image licences), under the owner rule of 2026-11-15 (no idle slots).

Updated 2026-11-16 09:31 +02:00 by codex · gpt-6.1-sol: T1/N1/S2/Q1 merged at zero jobs after cross-family review; integrated156server/Python7/licence/clientbuild pass. N1/S2/Q1 activation waits X1 batch; combined3Auto proof and Q1 throughput remain pending.

Updated 2026-11-16 09:48 +02:00 by claude-pro · claude-fable-5-2: lane R1 final review panel (owner order about 09:35, ForgeBrain/decisions/2026-11-16-owner-final-fable-panel.md). Starts after PROOF READY; no new video-affecting lane between the proof and the panel's verdict.

Updated 2026-11-16 10:15 +02:00 by codex · gpt-6.1-sol: X1 merged after review and actual rendered proof (audit incomplete, applied prevention accepted). Q2 parked after code PASS but no measured gain. L2 receipts merged; additional pre-check deferred because the proposed readiness gate already exists. Ready for combined3Auto proof after idle activation.

Updated 2026-11-16 10:48 +02:00 by codex · gpt-6.1-sol: A1 two research passes failed full factual/shape quality; retain44 audited edited candidates in ForgeBrain/research/trend-review-2026-11-16/reviewed-candidates.md with16missing and explicit caveats, park target rather than claim60verified. C1 complete via source check and existing X1 Natural Earth asset entry; no NASA asset used. Combined proof still active; no production merge/restart.

Updated 2026-11-16 14:45 +02:00 by claude-pro · claude-fable-5-2: final review panel verdict FIX; one fix round F1 to F5 (ForgeBrain/fleet/ORDERS.md). Leftovers for later lanes are listed at the end of output/agent-jobs/final-panel-2026-11-16/VERDICT.md.

Updated 2026-11-16 16:46 +02:00 by codex · gpt-6.1-sol: F1-F5 and contract followups merged through fd16776 after cross-family review. Integrated server173/Python198+6subtests/licence36 pass; applied CPU fence proofs retain explicit audit limitations. Single3Auto fix proof pending; no quality approval yet.

Updated 2026-11-17 by claude-pro · claude-fable-5-2: owner go for four lanes only (K1, S3, SP2, SP1), no video run; everything else waits for step A of `ForgeBrain/plans/2026-11-17-merged-plan.md` (three hand-made videos by Fable, Opus and Sonnet). The fix proof ran 2 of 3; F1 to F5 stay merged. Whole picture: `ForgeBrain/plans/2026-11-17-state-and-next-lanes.md`.

Updated 2026-11-17 10:10 +02:00 by codex · gpt-6.1-sol: K1 and SP1 merged at zero active jobs after cross-family security review and fenced proofs; no video run or dashboard start. S3 correction/review and SP2 remain.


Updated 2026-11-17 10:17 +02:00 by codex · gpt-6.1-sol: S3 merged after Sonnet review and 174 server tests; five agent-authored scripts at output/agent-jobs/s3-scripts/PROOF.md. SP2 is next from the updated main.


Updated 2026-11-17 10:45 +02:00 by codex · gpt-6.1-sol: SP2 merged after final Sonnet security PASS and 187 server tests. Split fences join only when the longest fails syntax and the join passes. Scoped repair covers only sample-count refusals in editable definitions/assignments; every other refusal still uses full rewriting. Failed scoped edits fall back safely, bounded to two full replies plus one scoped call. Original Corinth reply is missing; no 14–18-minute or 105k-token saving was proved. Four lanes complete; no video run or dashboard start.





Updated 2026-11-17 14:18 +02:00 by codex · gpt-6.1-sol: rotation took over; reconciled KS1/KP1 merges and KB1 active security review. Phase 1 proofs remain pending.

Updated 2026-11-17 15:05 +02:00 by codex · gpt-6.1-sol: KB1 parked after second independent review FIX (kb1-review2/REVIEW.md); branch preserved, no third fix cycle. Other merged lanes remain; integrated phase 1 proofs and phase 2 dependency assessment pending.


Updated 2026-11-17 15:19 +02:00 by codex · gpt-6.1-sol: Kola phase 2 disposition closed as PARKED. KE0 design and different-family review saved under output/agent-jobs/ke0-design and ke0-review1. No generic 3D-text fallback or new KX1 proof adopted. KB1 remains parked; integrated flag-on proof and combined real-clip levels incomplete. Main code gates:195server/401Python, no runtime activation or publishing.



### Kola main way waves 1 and 2 · 2026-11-17 17:21 +02:00 · codex · gpt-6.1-sol

Binding plan: ForgeBrain/plans/2026-11-17-kola-main-way-refactor-plan.md sections 2, 3, 6, 7 and 13. Owner order 17:16 lifts KB1 parking. No pipeline video run, dashboard start, publishing or auto release change.

| Id | State | Owned files or scope |
|---|---|---|
| U1a | MERGED in 4a8aacf; reviewed 508b5ff | dashboard/server/episode/codebuilt/start.js; dashboard/server/episode/codebuilt/visualLoop.js (preview id only); dashboard/server/episode/codebuilt/overlaySpec.js; dashboard/server/episode/engines/codebuilt/jobFolder.js; dashboard/server/episode/codebuilt/runCoordinator.js; new resume integration test file dashboard/server/episode/codebuilt/overlayResume.test.js |
| U1b | MERGED in 4a8aacf; reviewed e9ad0ba | blender_worker/codebuilt/shotcheck.py; blender_worker/codebuilt/test_shotcheck.py; dashboard/server/episode/codebuilt/visualLoopPrompts.js (KIT_CHECKS name only) |
| U1c | MERGED in 4a8aacf; reviewed 464c938 | dashboard/server/episode/codebuilt/planner.js (overlay parts only); dashboard/server/episode/codebuilt/overlaySpec.test.js |
| T1 | CODE MERGED 00ac1be; H1 CLOSED not produced (Fable fix 5); P2 uses live Auto picture=true, no router retry | dashboard/server/episode/codebuilt/autoTopic.js; dashboard/server/episode/codebuilt/theme.js; their dedicated tests; output/agent-jobs/t1-topics/ |
| RL1 | REPORT ACCEPTED with C follow-ups; H2 OPEN | C:/code/ForgeAi/output/agent-jobs/rl1-render-look/ only |
| A0 | ACCEPTED design, review2 MERGE | C:/code/ForgeAi/output/agent-jobs/a0-design/ only |
| G1 | MERGED f4878f8; classic correction 66fbf97 | .claude/skills/codebuilt-scene-generation/SKILL.md |
| G2 | MERGED 60e9db4; classic correction 66fbf97 | .claude/skills/codebuilt-look-review/SKILL.md |
| G3 | MERGED c486f61; classic correction 66fbf97 | .claude/skills/codebuilt-maps/SKILL.md |
| G4 | MERGED de832fa; classic correction 66fbf97 | .claude/skills/codebuilt-teardown/SKILL.md |
| G5 | MERGED 169ed97; later M7 correction 39309a2 | .claude/skills/codebuilt-direction/SKILL.md |
| G6 | MERGED 3865d0a | .claude/skills/codebuilt-script/SKILL.md |
| G7 | MERGED c07a7b0 | blender_worker/codebuilt/maps.py; new blender_worker/codebuilt/test_maps_anchor_point.py |
| G8 | MERGED 75ac8b6 | blender_worker/codebuilt/teardown.py; new blender_worker/codebuilt/test_teardown_anchor_point.py |
| G9 | MERGED 6b92c9e; M6 availability correction pending | dashboard/client/src/components/episode/CodebuiltStart.jsx only |
| G10 | ACCEPTED still proof; label coverage caveats W2-C8 | C:/code/ForgeAi/output/agent-jobs/o1-overlay-types/map/ only |
| G11 | ACCEPTED still proof; subject quality remains weak | C:/code/ForgeAi/output/agent-jobs/o1-overlay-types/teardown/ only |
| G12 | ACCEPTED corrected runbook; unused because T2 dropped | C:/code/ForgeAi/output/agent-jobs/handmade-1118/RUNBOOK.md only |
| G13 | ACCEPTED caption comparison report; M5 remains held | C:/code/ForgeAi/output/agent-jobs/g13-captions/ only |
| G14 | ACCEPTED A3 saved-stage inventory | C:/code/ForgeAi/output/agent-jobs/g14-stages/ only |
| G15 | REPLACED: P1 before/after and G17 corpus; Fable check 1 independent baseline tool | output/agent-jobs/fable-check-1/probes/classic-capture.mjs; captures 649 prompts and 15 validator verdicts against 717d65f; post keys use P1 comparisons |
| U1 | MERGED 4a8aacf; integrated gates pass | Binding plan sections 4 and 13. |
| O1 | MERGED wave 2; Fable check 1 fixes F1/F2/M6 in progress | Binding plan sections 4 and 13. |
| O1a | MERGED in 17d5d10 | Binding plan sections 4 and 13. |
| O1b | MERGED in 17d5d10 | Binding plan sections 4 and 13. |
| O1c | MERGED HTTP mount acc5bff; integrated G1 to G9 | Binding plan sections 4 and 13. |
| P1 | ACCEPTED proof clip; H3 owner watch/listen OPEN | output/agent-jobs/kola-phase1-proof/main-way-1810/P1-REPORT.md and p1-proof/ |
| T2 | DROPPED by owner day order D1 | Binding day plan; no hand-made topic sessions. |
| G16 | ACCEPTED author skill draft, adopted by A1 | output/agent-jobs/a1-skill-draft/ |
| G17 | ACCEPTED probe report and review; K2 correction merged 20e2fd0 | output/agent-jobs/g17-probes/REPORT.md; no non-FONT guarantee claimed |
| A1 | MERGED a51a19a; security-reviewed 7433c0b | Author loop per accepted A0; Sol builds, Sonnet reviews. |
| A2 | PASS Sonnet applied security review 2 | output/agent-jobs/a2-review2/ |
| A3 | MERGED caps 44c4c6c; measurements and fixture independently PASS | output/agent-jobs/a3-measure/REPORT.md; caps 2b0852d and fixture 3fd5f3b; three serial Sonnet sessions, no final/draft |
| P2 | AUTHORIZED day order; HELD until caps+D2 merged and activated | Three authored Sonnet videos, normal Auto picture=true; no publishing. |
| S1 | OWNER | Binding plan sections 4 and 13. |


### U1b review follow-ups · 2026-11-17 17:26 +02:00 · codex · gpt-6.1-sol

Reviewer confirms none is S or L; all are C LOW. Accepted for U1 integration under plan section 3.

| Id | State | Follow-up |
|---|---|---|
| U1b-C1 | FOLLOW-UP C LOW | Avoid two text_objects walks per checked overlay frame if measured cost warrants it; no scope expansion now. |
| U1b-C2 | DOCUMENTED C LOW | Preview poses a subset; FONT visible only on unposed frames is caught at final QA. Contract covers posed frames. |
| U1b-C3 | DOCUMENTED C LOW | MAX_LISTED bounds displayed findings while ok remains false; retain fail-closed behavior. |


### A0 final review follow-ups · 2026-11-17 17:35 +02:00 · codex · gpt-6.1-sol

A0 design accepted after review2 MERGE; no S or L, two C LOW follow-ups. No author implementation authorized.

| Id | State | Follow-up |
|---|---|---|
| A0-C1 | FOLLOW-UP C LOW | A1 authorCall reads its own raw usage counters; do not change shared usageFrom and classic behavior. |
| A0-C2 | FOLLOW-UP C LOW | Carry supervisor D3 decline into copied wording; test explicit zero, missing cache/output and adjusted900k stop; over-cap passing call still ends author_tokens. |
| U1c-C2 | FOLLOW-UP C LOW | Overlay prompt retains capital-letter/readout wording; refine overlay-only text without changing classic prompt. |


### U1a accepted review follow-ups · 2026-11-17 17:52 +02:00 · codex · gpt-6.1-sol

U1a508b5ff review2 MERGE; noS/noL, only C LOW. Integration gates still pending.

| Id | State | Follow-up |
|---|---|---|
| U1a-F3 | FOLLOW-UP C LOW | Align hostJobReceipts jobWriteBlockedReason attempt-preview locks with reusable lock checks. |
| U1a-F4a | FOLLOW-UP C LOW | Guard accepted receipt and pair JSON.parse with named errors. |
| U1a-F4b | FOLLOW-UP C LOW | Make the99-round preview-id limit explicit for repeated resumes. |
| U1a-F4c | FOLLOW-UP C LOW | Avoid future round overlay.json pair/raw-spec name collision if stage inputs spec is introduced. |
| U1a-F4d | FOLLOW-UP C LOW | Document overlay history reset and fresh look budget on resume. |
| U1a-F5 | DOCUMENTED C LOW | Fence-stub anchors prove wrapper pass-through; real fenced P1 proof remains required. |


### T1 accepted code follow-ups · 2026-11-17 17:57 +02:00 · codex · gpt-6.1-sol

T1 code33732cf review2 MERGE, noS/noL. Branch not merged yet. Real proofH1 and T2 BLOCKED, no router rerun.

| Id | State | Follow-up |
|---|---|---|
| T1-C2 | FOLLOW-UP C LOW | Short valid journey thing/move yields picture null; reconcile without changing classic gate. |
| T1-C3 | FOLLOW-UP C LOW | Picture+journey prompt redundantly asks for code-derived picture. |
| T1-C4 | FOLLOW-UP C LOW | Any future authorized proof rerun needs pre-call askRoleFn counter and preserved cause; current two-call budget possibly spent. |
| T1-C5 | FOLLOW-UP C LOW | Add derived short journey field coverage when fixing that bug. |


### RL1 report follow-ups · 2026-11-17 18:07 +02:00 · codex · gpt-6.1-sol

RL1 independent Sonnet review permits report acceptance, no S or L. H2 remains open. Report clarifications added by supervisor; no rerender authorized for these follow-ups now.

| Id | State | Follow-up |
|---|---|---|
| RL1-C1 | FOLLOW-UP C MEDIUM | Kola comparison lacks Earth texture at frames 640 and 760; report now discloses mismatch and unmeasured cost effect. |
| RL1-C2 | FOLLOW-UP C MEDIUM | Eight-frame post proxy omits listed overlays and changes caption words; report now names gaps, no parity claim. |
| RL1-C3 | DOCUMENTED C LOW | AgX versus Standard preference weak at sheet size; recommendation provisional. |
| RL1-C4 | DOCUMENTED C LOW | Earlier empty, failed and aborted case folders retained and disclosed. |
| RL1-C5 | FOLLOW-UP C LOW | Measurement runner tmpfs, nofile and label differ from production fence; preserve fence, disclose fidelity limit. |
| RL1-C6 | DOCUMENTED C LOW | KR1 timeline substitution disclosed; poses match prior replay. |

Updated 2026-11-17 18:07 +02:00 by codex · gpt-6.1-sol: reconciled U1 and T1 merges, RL1 review acceptance with explicit limitations, wave 2 dispatch and G12 capacity blocker. Proof and owner hold points remain open as stated.

Updated 2026-11-17 18:08 +02:00 by codex · gpt-6.1-sol: G13 captions comparison capacity BLOCKED after all three accounts; existing RL1 evidence preserved.

Updated 2026-11-17 18:12 +02:00 by codex · gpt-6.1-sol: G7, G10 and G14 capacity blocked after all accounts; G1/G17 alternate-account work continues.

Updated 2026-11-17 18:13 +02:00 by codex · gpt-6.1-sol: G8 capacity BLOCKED after all accounts; O1c integration remains blocked.

Updated 2026-11-17 18:13 +02:00 by codex · gpt-6.1-sol: G1 capacity BLOCKED after all accounts; G16/G17 final alternate accounts active.

Updated 2026-11-17 18:14 +02:00 by codex · gpt-6.1-sol: G16 capacity blocked after all accounts.

Updated 2026-11-17 18:14 +02:00 by codex · gpt-6.1-sol: G17 capacity blocked after all accounts, no probe output.

### O1a review follow-ups · 2026-11-17 18:58 +02:00 · claude-pro · claude-sonnet-5-5

O1a 52449eb reviewed MERGE by Sonnet (no S, no L), merged as 246a433. Five C findings.

| Id | State | Follow-up |
|---|---|---|
| O1a-C1 | DONE | Closed by O1c-http a199270 (merged acc5bff, Opus review 2026-11-17): the HTTP handlers and `RUN_BODY_KEYS` accept `route`; `checkJobRoute` still validates the value. |
| O1a-C2 | FOLLOW-UP C LOW | An authored job with the flag off still reports `resumable: true`, then refuses the resume. |
| O1a-C3 | FOLLOW-UP C LOW | Author tests miss three reviewer mutations: execute-time flag check removed, preview runner losing `route`, validator losing `route`. |
| O1a-C4 | FOLLOW-UP C LOW | New tests leave scratch folders under `output/agent-jobs/o1a-tests` and hard-code the path. |
| O1a-C5 | INFO | Journey-profile channels now save route `overlay` and get `picture:true` topic prompts; `route` is a new key in `status.json`. Both follow contract 2.1. |
| W2-C1 | CLOSED 66fbf97 (L-SOL-1) | Classic jobs also load the new "When text is drawn after the render" sections in six skills (text changes, behaviour should not). Teach `skills.js` to drop the section on `classic` jobs. Opus review A note. |
| W2-C2 | FOLLOW-UP C LOW | G9 hides "One author" until a server endpoint reports author mode and `NewVideo.jsx` passes `authorModeAvailable`; the client body builders accept "authored" (the server refuses with 409). No client test runner exists. Opus review C. |
| W2-C3 | FOLLOW-UP C LOW | G7 `anchor_point` and G8 per-frame order through `render_frames` with the real camera projector are untested; the G10 and G11 stills prove them. G8: `pose("x")` outside Blender now raises instead of doing nothing; a comment in `routes/codebuilt.js` names only `start.js` as the route checker, the batch path checks in `runCoordinator.js`. Opus review B and C. |
| W2-C4 | FOLLOW-UP C MEDIUM | G13 captions report (`output/agent-jobs/g13-captions/REPORT.md`): the nine proposed caption changes would also restyle `classic` jobs (`captions.Track` runs for every job, `post/run.py:88`); apply them only to the `overlay` and `authored` routes or the owner accepts a classic change at H2. Do not drop `POP` (read by `overlay.py:431`), set it near 1.03; do not hard-code one script's key words. Feeds H2. Opus review. |
| W2-C5 | FOLLOW-UP C LOW | A1 adopts the G16 draft (`output/agent-jobs/a1-skill-draft/`): the first write turn has no `notes` field; the caption band sits at 67 to 79 percent of the height, not the bottom fifth; three NOTES.md source lines are wrong; the diagram-board ban is right because `diagram.py` draws real font text; remove the stray `grep.exe.stackdump`; the build prompt must carry word times. Opus review. |
| W2-C6 | FOLLOW-UP C LOW | G10 and G11 stills (`output/agent-jobs/o1-overlay-types/`): a part hidden from the camera still gets a label that points at nothing visible; the author skill and look review should say so. Preview only, no final render, no audio sync. |
| W2-G17 | MERGED 20e2fd0 (K2 dc91d36 reviewed) | G17 probes (`output/agent-jobs/g17-probes/REPORT.md`, 74 code-check and 15 kit-check probes, S 0 L 0): eight C gaps. C-1 3D text that is not a FONT object (mesh converted before QA, String to Curves, bitmap texture); C-2 FONT with one near-zero scale axis or hidden in an unlinked collection (fix: `max` instead of `min` in the scale test); C-3 a build can switch the kit guarantee off (alias `shotcheck`, patch `visible_text_objects`, move `overlay.json` around `run_qa`; fix: treat `shotcheck` like `anchors` and `stage` in the import rule); C-4 text that shows only after QA; C-5 copying a FONT with `add_named`/`copy`/`duplicate` (kit fails closed); C-6 `eval` aliasing and similar (fence); C-7 sets import (fixed on `t3/overlay-sets-import`); C-8 `os.symlink` (post step refuses). Decide before author mode (A1/A2) relies on plan section 2.5. |
| W2-G17b | FOLLOW-UP C MEDIUM | Opus review of G17 (`output/agent-jobs/g17-review-opus/REVIEW.md`): verdict FIX, S 0 L 0 C 13. New: C-9 a final build writes `/job/work/preview.json` itself so `run_qa` treats `text_in_3d` as a soft preview finding; C-10 patching `os.path.exists` before the kit import hides `overlay.json`; C-11 `(shotcheck).X =`, a backslash break and `sc = shotcheck` pass the regex (classic gap too, unchanged from 717d65f); C-12 a `render_pre` handler shows text only while rendering; C-13 render stamp, sequencer text strip and grease pencil put text in the frames with no FONT object. Plan 2.5 needs C-2, C-3, C-9, C-10, C-11 fixed before A1 (lane K2); C-1 and C-13 are outside the guarantee and should be written into 2.5 as a known limit with the look review as the backstop. The kit runs in the build's own process, so deliberate gaming needs a check outside that process (rendered frames) or the look review: an owner decision. |
| W2-C7 | FOLLOW-UP C LOW | Opus review of the sets import fix: `planner.js` never checks the `as` name, so `import ... as anchors` or `as stage` passes the static check (fails loudly at runtime); refuse those names in both import forms. Plain `import blender_worker.codebuilt.<x> as <alias>` is only caught by the runtime `text_in_3d` check. |
| W2-C8 | FOLLOW-UP C LOW | G10/G11 stills review (Opus): the FRANCE label box (side right) lands on southern Germany, about 25 px under the GERMANY pin, and the EXHAUST NOZZLE box covers part of the exploded right wing; the overlay layout has no rule that keeps a label box off another anchor's country or off a subject piece. The proof shows `anchor_point` is exact, not that the labels read right. |
| W2-C9 | FOLLOW-UP C LOW | Redaction of the saved `theme_provider_failed` cause (Opus recheck): UNC paths are not redacted, a Windows path loses only the part before its first space, a URL with a long id loses its host, and tokens shorter than 32 characters or split by `+` `/` `=` leak. The text is the last line of a Claude or agy CLI error, capped at 300 characters. Tighten if the cause ever shows a secret. |

### O1b review follow-ups · 2026-11-17 19:20 +02:00 · claude-pro · claude-sonnet-5-5

O1b 44b9b36 reviewed MERGE (review 2, no S, no L), merged as ec5b93d. The O1a snapshot test no longer lists `direction.js` as unchanged since 717d65f (it is changed on purpose); full server suite 375 of 375.

| Id | State | Follow-up |
|---|---|---|
| O1b-C1 | FOLLOW-UP C LOW | Outside a job scope `planCodebuiltDirection` takes journey limits from `input.formats`; no production effect (start.js runs the plan in a job scope). |
| O1b-C2 | FOLLOW-UP C LOW | `codebuilt-direction/SKILL.md` line 16 says 2 to 5 places while the overlay route says 1 to 4; the G5 skill section should reconcile it. |
| O1b-C3 | FOLLOW-UP C LOW | An overlay or authored job whose `premise.formats` is a truthy non-array throws a TypeError in `scriptPrompt`; the server always sets an array. |
| O1b-C4 | FOLLOW-UP C LOW | No length cap on premise fields; schema pins `render.status` to `pending_review` and `device` to `GPU` (H2 approval needs a schema edit); the overlay JSON repair prompt carries the RL1 text. |

### 2026-11-17 22:43 +02:00 · codex · gpt-6.1-sol
Wave 2 integration: classic guide restoration66fbf97 merged aebcb43, K2dc91d36 merged20e2fd0. Applied security probes close C14/C15; nine real Blender FONT cases refused,445 classic validator and prompt cases match archived717 after guide fix. Narrative restarted at zero jobs. A1 to A3 authorized by owner21:12; P2/S1 remain owner-only. W2-C1 closed; W2-G17b residual arbitrary text-as-mesh and malicious in-process tampering remain documented limits, not FONT detector guarantees.

### Day 2026-11-18 Kola main way · codex · gpt-6.1-sol · 2026-11-18 11:40 +02:00
Scope: ForgeBrain/plans/2026-11-18-finish-kola-main-way-day-plan.md. These ids belong to this dated section and do not replace older M lanes.

| Package | State | Ownership / next gate |
|---|---|---|
| A2r | MERGED / PASS | Sonnet security review accepted A1 7433c0b, merged a51a19a and pushed. |
| M0 | ACCEPTED 2026-11-18 11:46 +02:00 codex · gpt-6.1-sol | Haiku read-only preflight inspected; no active jobs; A3 serial; default has map profile |
| M1 | ACCEPTED | Sonnet executable harness; lock cleanup corrected and verified before three live A3 sessions. |
| M2 | CLOSED NOT PRODUCED | Fable fix 5 disposition: H1 closed; CLI setup absent in harness, count unknown, no retry. P2 live Auto picture=true. |
| M3 | ACCEPTED | Haiku page, Luna review; supervisor corrected H1 to skipped/normal Auto. Local owner-review-1118/owner-review.html. |
| M4 | BLOCKED 2026-11-18 11:50 +02:00 codex · gpt-6.1-sol | Sonnet independently confirms79846d0 pin patch correct/S0/L0/full gates; whole lane blocked by absent occlusion contract. Branch preserved unmerged; no narrowed scope. G10/G11 subject coverage unchanged. |
| M5 | BLOCKED | Luna fallback made no changes; installed Arial Black bitmap use checked at Microsoft source, but register inclusion is outside assigned files. Checkout t3-c55b4038 clean at a51a19a. |
| M6 | MERGED 018dd15 / PASS | Luna234672d, independent Haiku review; author availability and client built. |
| M7 | MERGED 39309a2 | Haiku 641b084, Luna PASS; classic prompt unchanged, integrated full gates pass. |
| M8 | ACCEPTED | Haiku runbook/request/record templates inspected and corrected by supervisor. P2 ran and is terminal: one draft of three; record sheet filled. |
| A3 | MERGED 44c4c6c / PASS | Three accepted Sonnet sessions, 5/5/4 previews; Luna review2 PASS. Exact caps 2b0852d plus Haiku fixture 3fd5f3b independently Luna PASS; caps 940000 / 90000, reserves 11097 / 105079. Integrated 524 server pass. No final/draft. |
| N1 | MERGED c9a9733 | Sonnet 2d56f9c, Luna substantive PASS; integrated full gates pass. |
| N2 | MERGED 1955184 / PASS | Sol d997406 plus whitespace5faad9a, Sonnet review2 PASS; 90-minute named ceiling before final render, profile pending_review. Integrated 524 server/430 Python pass. |
| N3 | OWNER HOLD | Prepare after N2; merge only after owner watches videos and says go |
| P2 | TERMINAL: 1 DONE / 2 FAILED | run-mwm412ec-9b4e25; Danube draft cb-mwm4a61f-438a7a; Bosporus fact_check_blocked, Hypersaline final layout overlap. See output/agent-jobs/fable-check-2/REPORT.md and p2-proof/record-sheet.md. No new run or repost authorized. |
| A1-C5 | FOLLOW-UP C LOW 2026-11-18 11:48 +02:00 codex · gpt-6.1-sol | A3 saves per-call observations; authorCaps should recompute reserve/caps from observations rather than accepting claimed runs/reserves. No invented floors. A2r no S/L; bounded shape gate currently accepts fabricated observations. |

Day-plan status table updated 2026-11-18 13:26 +02:00 · codex · gpt-6.1-sol from the supervisor ledger and accepted review evidence; no WAVE 3 DONE or P2 readiness claim.

Window 2 partial landing updated 2026-11-18 13:30 +02:00 · codex · gpt-6.1-sol: N1/M7 merged, caps and D2 blocked; no WAVE 3 DONE.

### 2026-11-18 13:59 +02:00 · codex · gpt-6.1-sol
Fable check 1 fix 9 reconciles the wave 2 table with the WAVE 2 DONE ledger entry of 2026-11-17 22:44 and the
check's independent baseline evidence. G15 is replaced, not a claimed missing folder. Fixes 2.5/8/9 docs are corrected
in the binding plan, orders and check runbook. F2 Sonnet 7da41f4 and F3 Haiku 4ac5a2d independently Luna PASS;
F1/F6 preserve their original checkouts, M6 active, caps fixture under independent review. No WAVE 3 DONE or P2 claim.

| Fix | State | Evidence / next step |
|---|---|---|
| F1 | MERGED 362edb5 | Lunaa2a8ed4, independent Sonnet PASS with own real CPU Blender background-chain/hidden/cycle probes; classic unchanged |
| F2 | MERGED c1449a1 | Sonnet7da41f4, Luna PASS f2-f3-review1/REPORT.md; plan 2.5 limits documented |
| F3 | MERGED e4c3ecc | Haiku4ac5a2d, Luna PASS; gate includes all 44 overlay tests |
| F4 | MERGED 1955184 | N2 5faad9a after whitespace cleanup; Sonnet PASS n2-review2/REPORT.md |
| F5 | CLOSED NOT PRODUCED | H1 closed, no extra router call; live Auto picture=true for P2 |
| F6 | MERGED 83cadea | Luna264d7e4, independent Haiku PASS: picture-off 48/48, journey26/26; integrated526server/430Python pass |
| F7 | MERGED 018dd15 / PASS | M6, Luna234672d independently Haiku reviewed; client built and authored runtime activated at zero jobs. |
| F8 | DOCS CORRECTED | Python gate: python -m pytest blender_worker narrative_factory tools |
| F9 | DOCS CORRECTED | Wave 2 rows above and FABLE-CHECK step 4 baseline tool |

Window update 2026-11-18 14:03 +02:00 · codex · gpt-6.1-sol: caps44c4c6c, N21955184, F2c1449a1 and F3e4c3ecc merged locally at zero jobs; integrated524server/430Python/licence/secrets pass. F1/M6/F6 review still pending; no WAVE3DONE or P2 activation.

F6 update 2026-11-18 14:07 +02:00 · codex · gpt-6.1-sol: independent Haiku review1 PASS S0L0C0, merged83cadea at zero jobs. Integrated526server/430Python/licence/secrets gates pass; F1/M6 preserved pending completion and reviews. No runtime activation or P2 yet.

F1 update 2026-11-18 14:17 +02:00 · codex · gpt-6.1-sol: Sonnet review1 PASS exacta2a8ed4; merged362edb5 at zero jobs and restarted forgeai-narrative as required. Integrated526server/431Python/licence/secrets gates pass. M6 independent review pending; no P2 or dashboard activation.

### 2026-11-18 17:45 +02:00 · codex · gpt-6.1-sol
Fable check 2 fix10 reconciles M6/F7/P2 with the ledger; report output/agent-jobs/fable-check-2/REPORT.md. Fix1/3/5/6 share one author acceptance branch; fix2 has a disjoint post/resume branch; fix4/7/8 share a prompt branch. All require independent cross-family review and full gates before zero-job merge. Fix9 remains owner-held because the camera-visibility contract is missing; no question sent under day orders. M4/M5/N3 remain held. No new video or repost authorized.

### 2026-11-18 18:02 +02:00 · codex · gpt-6.1-sol — check 2 author follow-ups
| Id | State | Finding |
|---|---|---|
| C2-AUTH-1 | FOLLOW-UP C MEDIUM | Fixed overlays get all-frame canonical layout checks; moving labels/measures use sampled preview anchors only. Full anchor pose export remains unimplemented, so do not claim all-frame dynamic geometry validation. Reviewer codex · gpt-6-luna classified C medium at final38a9cc2; no S/L finding reported. |
| C2-AUTH-2 | FOLLOW-UP C LOW | start.js needs friendly author_layout_unavailable wording; post worker currently owns file. |
| C2-MAP-PROOF | FOLLOW-UP C LOW | Marker size and land appearance guidance merged; no new rendered still proves its effect. Next owner-authorized proof only. |

### 2026-11-18 18:16 +02:00 · codex · gpt-6.1-sol — check 2 final disposition

| Fix | State | Evidence and limit |
|---|---|---|
| 1, 3, 5, 6 | MERGED f7362e9 | Author acceptance and preview coverage, independent Luna reviews; fixed overlays checked on every frame, dynamic labels/measures sampled only (C2-AUTH-1). Actual Hypersaline pair refused and Danube pair passed in saved CPU replay. No new video proof. |
| 2 | PARKED 8ab0bab | Branch t3/fix-post-only-resume, checkout C:/Users/Lava/.t3/worktrees/ForgeAi/t3-0a8189d3. Sonnet implementation 73132c1 plus supervisor cancellation fix; focused 10, server 537, Python 438, licence 36 pass. Two Luna reviews did not deliver required independent security mutation evidence. Do not merge or perform an actual resume/repost. Renewed review authorization is needed; preserve all work. |
| 4, 7, 8 | MERGED 21633c5 | Picture narration and evidence-based fact rewrites, map guidance and missing-frame wording; Luna then Sonnet review. Map appearance proof remains C2-MAP-PROOF. |
| 9 | OWNER HOLD | Camera visibility contract remains undecided; M4 is blocked. |
| 10 | RECONCILED | M6/F7 are merged, P2 is terminal with one draft and two failures; record sheet names the Fable report and both causes. |

The friendly author_layout_unavailable message is on the parked post branch, so C2-AUTH-2 remains open. M5 is blocked and N3 stays owner-held. This closes the authorized fix round with explicit limitations, not a successful three-video proof. No new video, repost, publishing or default-route switch was performed.

### 2026-11-18 20:52 +02:00 · codex · gpt-6.1-sol — evening window 1

| Lane | State | Evidence |
|---|---|---|
| Fix 2 / C2-AUTH-2 | MERGED b94b25b | Opus8ab0bab independent appliedsecurityPASS; supervisor0377a86 independentlyagyPASS S0L0C0, completedpostdraftrecovery/junctionrefusal/staleoutputs covered. Friendly layout message included. |
| M4 / fix9 / C2-AUTH-1 | MERGED c3db594 (contained in b94b25b) | Combined2d26067 independentagyPASS572server459Python; all-framezero-renderpose export, optionalgeometryvisibility, canonicalwholehiddenrefusal/partialadvisory receipt. FrozenDanube overlaponlyPASS/fullBlackSea32of32hiddenREFUSE per newerowner rule; geometryraylimits explicit. |
| M5 captions | BUILT 7524fe3, REVIEW ACTIVE | InstalledArialBlack bitmaplicencechecked; classic39RGBcomparisons; integrated572server465PythonPASS. Finalpostbranch check_layout must selectoverlaystyle aftercombinedintegration. |
| N3/default/H2look/T2/publishing/auto release | OWNER HOLD | No change authorized in evening order. |

Window1 integrated584server466Python/licence36/secretpatternandrootenvvaluesPASS, zerojobs; narrative restarted. No proof started. Supersedes earlierdayclosure states for these explicitlyauthorizedlanes only.

### 2026-11-18 21:01 +02:00 · codex · gpt-6.1-sol — evening M5 integration

M5 captions MERGED b829852 from reviewed 7524fe3 and approved one-line integration d699f9b. Independent agy PASS S0 L0 C0 with 57 classic byte comparisons and all nine G13 rules. Combined 584 server / 472 Python / 36 licences and secret checks pass. The final post precheck now uses the same overlay caption envelope as preview and encode; classic unchanged. Evidence: output/agent-jobs/evening-M5-review1/REVIEW.md and evening-supervisor/m5-combined-*.log. Evening three-video proof pending; N3/default, H2/look, T2, publishing and auto release remain held. Supersedes earlier M5 blocked/review-active statuses only.
