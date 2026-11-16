# ForgeAi backlog

One list for everything the owner wants in ForgeAi. Updated 2026-11-14 by claude-pro Â· claude-sonnet-5-5.
`READY` = nothing outside the code blocks it; the fleet can take it. `OWNER` = waits on the owner. `PARKED` = the
owner put it later. Each lane lists the files it mostly touches so two workers do not collide. Workers work in
worktrees and merge only after the running video run is finished (CLAUDE.md rule 2).

## How the fleet takes this list (owner, 2026-11-14)

Launch every READY lane. Put most of the workers on one lane at a time (the focus lane); the rest of the lanes
run with the spare workers, one worker or two each, and never on a file another lane is editing. Sol supervises.

## Make the videos better and cheaper

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
| X1 | Surface kit and first-frame check | READY | `materials.py` has four helpers and recent builds use plain colours only. Add code-built surfaces (wood, brushed and painted metal, concrete, rock, water, ice, glass, rubber, fabric, soil, grass) with bump and worn edges; CC0 photo sets from Poly Haven or ambientCG where better, each in `licenses/register.json` first; rounded edges, contact shadows, richer view transform. Look review fails a flat-colour main subject and a first frame that does not show the subject. Proof: fenced CPU swatch sheet. `blender_worker/codebuilt/materials.py`, `stage.py`, skills `codebuilt-scene-generation`, `codebuilt-look-review` |
| Q1 | Overlap videos in a batch | MERGED 2ce22a1; throughput proof pending | Measured on 6 Auto videos: 38 min each, of which about 18 min (topic, script, fact check, direction, scene code) leave the graphics card idle and about 20 min (previews, looks, final render) leave the writing models idle. While video N previews and renders, video N+1 does its text steps and scene code. One job on the graphics card at a time; the voice step (about 1.4 min, needs the card) queues for it. Each job still writes only inside its own folder. Target: a 3-video batch at 25 min per video or less with the same checks passing. `episode/codebuilt/runCoordinator.js`, `start.js` (no planner.js changes; S2 owns that file) |
| Q2 | Lighter final render | READY | Final render averages 12.9 min for about 950 frames: Cycles on the card, 10 to 12 samples, 12 light bounces, caustics on, RGBA PNG. Port the kept render speed-ups (B1 salvage, branch `t3/speed-up-codebuilt-render-pipeline`) and try fewer bounces, caustics off and RGB output. Proof: the same build rendered before and after, time and a side-by-side contact sheet; no visible loss. Do not halve the frame rate. `blender_worker/codebuilt/renderloop.py`, `stage.py` (coordinate with X1, which also edits `stage.py`: Q2 goes after X1 merges) |
| A1 | Map premise bank | READY; research only, no code | 60 map premises in the five winning shapes of `ForgeBrain/research/trend-review-2026-11-16/REPORT.md` (tour of 4 or 5 places, comparison barrage, what-if chain, journey, mystery about familiar countries), 12 per shape. Each: title of 4 to 8 words, first sentence, the places it points at in order, one source link per fact, length guess. No current wars or disputed borders. Up to 3 agy workers, one shape set each, separate output files under `output/agent-jobs/<job id>`; one reviewer of another family removes weak or unsourced ones. Result goes to `ForgeBrain/research/trend-review-2026-11-16/premise-bank.md` |
| L2 | First-look defect census and pre-check | READY | Part 1 (read-only): count the round-0 findings in every `output/agent-jobs/*/visual_loop.json` by kind and say which a code check could catch. Part 2 (after part 1): add those checks before the first look so a build with them is repaired without a model call. `blender_worker/codebuilt/shotcheck.py` and the look-loop caller only; not the look-review skill (X1 owns it). Target: one look round fewer on average |
| C1 | Earth image licence check | READY; docs only | Check at the source whether Natural Earth raster relief and NASA Blue Marble or similar may be used in monetized videos; write the finding and add allowed ones to `licenses/register.json` on a branch. Feeds X1 |

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
