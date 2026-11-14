# ForgeAi backlog

One list for everything the owner wants in ForgeAi. Updated 2026-11-14 by claude-pro Â· claude-sonnet-5-5.
`READY` = nothing outside the code blocks it; the fleet can take it. `OWNER` = waits on the owner. `PARKED` = the
owner put it later. Each lane lists the files it mostly touches so two workers do not collide. Workers work in
worktrees and merge only after the running video run is finished (CLAUDE.md rule 2).

## How the fleet takes this list (owner, 2026-11-14)

Launch every READY lane. Put most of the workers on one lane at a time (the focus lane); the rest of the lanes
run with the spare workers, one worker or two each, and never on a file another lane is editing. Sol supervises.

## Make the videos better and cheaper

| Id | Lane | State | Notes and main files |
|---|---|---|---|
| M1 | Fact check speed | MERGED; proof running | One pass took about 447 s, nearly all page fetches. Fetch in parallel, cap per page, cache by URL. `episode/codebuilt/retrievalAdapter.js`, `routes/storySources.js` |
| M2 | Failure triage | MERGED; proof pending | Sort real bugs from model noise in the job folders and fix the cheap ones. Narrated jobs since the fact check fix finished 2 of 2 so far; the older failures were mostly loop jobs (now removed) or fact check blocks before the fix. Open case: the what-if job `mwg8b8qd` stopped at `look_failed`. Keep watching new runs. `episode/codebuilt/planner.js`, `start.js` |
| M3 | Map video proof | MERGED; map proof pending | Make 3 narrated map videos through the real path (type factual, map theme) and fix what breaks. Needs the running video run to be over. `blender_worker/codebuilt/maps.py`, `sets/world_map.py` |
| M4 | History video type | MERGED; history proof pending | A `history` type next to `factual` and `whatif`: period places and people, sourced dates and numbers. `episode/codebuilt/productionChoices.js`, `planner.js`, `autoTopic.js`, new skill `codebuilt-history` |
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

