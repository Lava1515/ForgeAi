# ForgeAi backlog

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
| U1a | REVIEWING 315e0b5 | dashboard/server/episode/codebuilt/start.js; dashboard/server/episode/codebuilt/visualLoop.js (preview id only); dashboard/server/episode/codebuilt/overlaySpec.js; dashboard/server/episode/engines/codebuilt/jobFolder.js; dashboard/server/episode/codebuilt/runCoordinator.js; new resume integration test file dashboard/server/episode/codebuilt/overlayResume.test.js |
| U1b | REVIEWED e9ad0ba, awaits U1 integration | blender_worker/codebuilt/shotcheck.py; blender_worker/codebuilt/test_shotcheck.py; dashboard/server/episode/codebuilt/visualLoopPrompts.js (KIT_CHECKS name only) |
| U1c | REVIEWED 464c938, awaits U1 integration | dashboard/server/episode/codebuilt/planner.js (overlay parts only); dashboard/server/episode/codebuilt/overlaySpec.test.js |
| T1 | DISPATCHING wave 1 | dashboard/server/episode/codebuilt/autoTopic.js; dashboard/server/episode/codebuilt/theme.js; their dedicated tests; output/agent-jobs/t1-topics/ |
| RL1 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/rl1-render-look/ only |
| A0 | ACCEPTED design, review2 MERGE | C:/code/ForgeAi/output/agent-jobs/a0-design/ only |
| G1 | DISPATCHING wave 1 | .claude/skills/codebuilt-scene-generation/SKILL.md |
| G2 | DISPATCHING wave 1 | .claude/skills/codebuilt-look-review/SKILL.md |
| G3 | DISPATCHING wave 1 | .claude/skills/codebuilt-maps/SKILL.md |
| G4 | DISPATCHING wave 1 | .claude/skills/codebuilt-teardown/SKILL.md |
| G5 | DISPATCHING wave 1 | .claude/skills/codebuilt-direction/SKILL.md |
| G6 | DISPATCHING wave 1 | .claude/skills/codebuilt-script/SKILL.md |
| G7 | DISPATCHING wave 1 | blender_worker/codebuilt/maps.py; new blender_worker/codebuilt/test_maps_anchor_point.py |
| G8 | DISPATCHING wave 1 | blender_worker/codebuilt/teardown.py; new blender_worker/codebuilt/test_teardown_anchor_point.py |
| G9 | DISPATCHING wave 1 | dashboard/client/src/components/episode/CodebuiltStart.jsx only |
| G10 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/o1-overlay-types/map/ only |
| G11 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/o1-overlay-types/teardown/ only |
| G12 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/handmade-1118/RUNBOOK.md only |
| G13 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/g13-captions/ only |
| G14 | DISPATCHING wave 1 | C:/code/ForgeAi/output/agent-jobs/g14-stages/ only |
| G15 | RETRYING on clash | C:/code/ForgeAi/output/agent-jobs/classic-baseline/ only |
| U1 | WAITING for dependencies | Binding plan sections 4 and 13. |
| O1 | WAITING for dependencies | Binding plan sections 4 and 13. |
| O1a | WAITING for dependencies | Binding plan sections 4 and 13. |
| O1b | WAITING for dependencies | Binding plan sections 4 and 13. |
| O1c | WAITING for dependencies | Binding plan sections 4 and 13. |
| P1 | WAITING for dependencies | Binding plan sections 4 and 13. |
| T2 | WAITING for dependencies | Binding plan sections 4 and 13. |
| G16 | WAITING for dependencies | Binding plan sections 4 and 13. |
| G17 | WAITING for dependencies | Binding plan sections 4 and 13. |
| A1 | OWNER | Binding plan sections 4 and 13. |
| A2 | OWNER | Binding plan sections 4 and 13. |
| A3 | OWNER | Binding plan sections 4 and 13. |
| P2 | OWNER | Binding plan sections 4 and 13. |
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

