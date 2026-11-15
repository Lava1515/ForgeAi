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

## Publish and grow

| Id | Lane | State | Notes and main files |
|---|---|---|---|
| P1 | Upload polish | MERGED; checks passed | Title field in the Publish box; the synthetic-voice disclosure question answered from YouTube's current rules and wired if required. `client/src/components/PublishYouTube.jsx`, `routes/youtube.js` |
| P2 | Auto release | MERGED; OFF until owner enables | Per channel: a switch (default off), a daily cap with no default (the owner sets a number per channel; with none set, nothing is released), a quality bar (fact check passed, length within tolerance, visual check approved), upload with a scheduled `publishAt`, a log of every release. Builds on `releaseDue` in `routes/youtube.js`. The owner turns it on, never an agent |
| P3 | Type to channel map | MERGED; checks passed | Each video type points at a channel in the dashboard; a channel can carry several types. `routes/channelsManager.js`, `ChannelModal.jsx` |
| P4 | Voices page | MERGED; checks passed | Browse and pick the Qwen speakers with their samples (nine samples exist in `output/temp/voice-samples`). New client page and route |
| P5 | Channel stats and growth | PARTLY BLOCKED | Public numbers work now (`routes/channel.js`, `Growth.jsx`). Retention and swipe-away need the YouTube Analytics login scope: OWNER |
| G1 | Growth knowledge base | BUILT on `feat/content-growth-skills`; review, merge after the run | `growth/knowledge/` was missing, so every growth prompt ran on a placeholder with no schema. Ten sub-skills and three references, each naming the JSON keys the code reads. `dashboard/server/growth/knowledge/**`. Plan: `docs/plans/2026-11-15-content-growth-lanes.md` |
| G2 | Publishing copy skill | BUILT on the same branch | New skill `codebuilt-publish` at `skillsByStep.publish`; the drafting step passes the script and premise, so titles and tags describe the video. `lightMetadata.js`, one call in `start.js`, `paths/codebuilt.json` |
| G3 | Stats watcher and age snapshots | BUILT on the same branch | Each scan stores views over time (`data/trends/snapshots*.json`); videos carry views at 1, 2, 7 and 28 days plus `views_24h`; the existing host loop rescans every 3 h, read-only. `growth/snapshots.js`, `routes/channel.js`, `growth/report.js`, launcher |
| G4 | Growth review skill | BUILT on the same branch | New skill `codebuilt-growth`: how an agent reads the numbers, applies the pilot's stop rule and writes a proposal; never publishes |
| G5 | YouTube Analytics numbers | OWNER | Needs `yt-analytics.readonly` on the channel login; then stayed-to-watch, swipe-away, average percentage viewed and viewer countries next to the G3 snapshots. Same blocker as P5 |
| G6 | Growth page over time | READY after G3 merges | `Growth.jsx`: views at 1, 2 and 7 days, views in the last 24 h, the stop-rule state per channel; `npm run build` in `dashboard/client` |

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

