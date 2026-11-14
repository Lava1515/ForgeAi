# YouTube Shorts rules for the pipeline: proposal for owner approval

author: claude-max · claude-haiku-5-5
created: 2026-11-14 21:08 +02:00
lane: M6 (docs/BACKLOG.md), research folder `ForgeBrain/research/youtube-shorts-2026-11-14`
status: proposal. Nothing here is built or merged. The owner confirms the list before M6 merges.

Tags: `[DATA]` measured by a lane, `[YOUTUBE]` YouTube said it, `[CREATOR]` a creator or vendor claims it,
`[GUESS]` inference. "Moderate" and "weak" are the strengths the lanes gave.

## 1. What the evidence supports, and what it does not

- The research is observational. Nobody outside YouTube sees the ranking, retention or swipe data.
- The FINAL-REPORT overstated two things. The adversarial review (`11-review-REVIEW.md`, F1, F4) and lane 12
  (`12-map-check`) both say so: (a) the map lead came partly from countryball channels, which are a different
  product; in the clean map cohort, map explainers (19 of 29 channels with a 100k Short) are about even with
  physics loops (13 of 33) and not a clear winner; (b) the premise-versus-look comparison is 9 of 10 pairs
  differing in premise or first seconds, not a proven rule.
- Our own channel is the one fact we have: 94 uploads, typical 7.5 views before 2026-10-16, about 44 after.
  Nobody knows yet whether topic matching or swipe-away failed. The owner's 10-minute Studio check settles it
  (FINAL section 9). This check should run before any rule is judged a success.

## 2. Proposed checklist (for the owner to approve or cut)

Each rule shows its evidence and how it would be checked. "Build" names the file that would change; nothing
changes until the owner approves.

### Premise and hook

1. **One concrete premise with a stake** (a named place, object, person or number). No "things that..." lists.
   `[DATA, lane 06, 31 winners / 10 flops, moderate]`. Check: a premise score in the planner before build.
   Already partly in code: `autoTopic.js` scores proposed premises, and its tests reject lists, missing
   stakes or payoff, and avoided phrases (npm test, 48 of 48 pass). Build: tune that floor against items 2 to 4
   rather than add a second gate.
2. **The subject is on screen in frame 0; no logo or title card.** 29 of 31 winners. `[DATA, moderate]`.
   Build: `.claude/skills/codebuilt-direction/SKILL.md` (opening shot) and `codebuilt-scene-generation`.
3. **The premise is said or shown within 3 seconds.** 15 of 31 winners did it, so it is a target, not a rule for all.
   `[DATA, moderate]`. Build: `.claude/skills/codebuilt-script/SKILL.md`, "The hook" section (it already asks for
   a picturable first sentence of 12 words or fewer; add the 3-second premise line).
4. **End on the payoff and stop.** Only 3 of 31 winners used a call to action, so do not add one by default.
   `[DATA, moderate]`. Build: `codebuilt-script` ending section, no CTA line.
5. **No cut-per-second or length target.** Winners ran 6 to 178 s; the lanes disagreed about 24 to 32 s versus
   35 to 50 s, so the research gives no fixed length. Keep the existing length check (10 s tolerance, owner rule
   2026-11-13). `[DATA, weak]`. Build: none.

### Title and description

6. **Title = the premise in plain words, about 6 to 10 words, English.** The research says YouTube reads the
   title to learn the topic `[YOUTUBE, Beaupré 2026-09-01]`. `#Shorts` is not a lever `[YOUTUBE]`; leaving it
   out is a style choice, not a rule. Build: `dashboard/server/episode/codebuilt/lightMetadata.js` title prompt
   (currently a generic "concise video title"), and the P1 title field.
7. **Never a date as the title, and never the same video twice.** Our 7 date-titled uploads since 2026-11-12
   had no description and went out in bursts `[DATA, lane 05]`. Build: the upload check in P1.
8. **A real description** (one or two sentences on the premise, plus any source line). Build: P1.
9. **Title templates are banned.** Shared title skeletons are what "interchangeable content" policy describes
   `[YOUTUBE, help 1311392]`. Build: the variation check in item 10.

### Variation (the policy risk that matters most)

10. **Each upload differs visibly from the last in subject, camera path and title skeleton.** No two in a row
    with the same region, camera path or title pattern. This is measurable, unlike "vary the look".
    `[YOUTUBE, help 1311392, Jan 2026 terminations; GUESS on the exact test]`. Build: a check in the
    publish path (P1), not a prompt change.
11. **Review the whole channel, not one video.** One termination closes all channels of the owner
    `[YOUTUBE]`. This is the reason for item 12.

### Pace and accounts

12. **At most one Short a day per channel, never in bursts.** Breakout channels posted about 0.9 a day in their
    first 30 uploads `[DATA, n=133, lane 04]`. Our bursts of up to 16 a day are the pattern the spam policy
    describes `[GUESS]`. Build: P2 auto release. The cap has no default; the owner sets it per channel.
13. **Expect a wait.** The first 1M Short was usually the 11th upload `[DATA, n=149, lane 04]`. Do not judge a
    format on fewer than 20 uploads.
14. **Channel: one niche, real country, English title and description.** `[YOUTUBE]` help 141805, 2976814
    (claimed in the research, not re-checked here).
15. **Accounts and the old channel.** The review (F5) and lane 02 say stop uploading to the old channel. The
    owner decided on 2026-11-14 to keep it as a practice channel (`decisions/2026-11-14-owner-shorts-pilot-and-practice-channel.md`).
    **That is an owner decision that conflicts with the research; this proposal follows the owner's decision.**
    Practice uploads must still follow items 7 and 12.

### Sound and disclosure

16. **Our own audio only; no in-app music.** Shorts over 60 s with an active Content ID claim are blocked
    `[YOUTUBE, help 15424877]`. Code-made music avoids claims. AI-generated music needs a disclosure label
    `[YOUTUBE, help 14328491]`. Build: none; a rule for the music step.
17. **Voice: the built-in speakers of Qwen3-TTS-12Hz-1.7B-CustomVoice (Apache-2.0, `licenses/register.json`).**
    The research assumed "the owner's voice"; the pipeline does not clone it. No YouTube rule bans TTS. A
    disclosure label is needed only for realistic AI content, not stylized 3D `[YOUTUBE, help 14328491]`.
    Cloning someone else's voice is out (privacy and likeness detection). Build: the P1 disclosure question
    answered from YouTube's current help page before the first upload. Open: check that the register entry
    covers monetized use for the model's speakers. It says Apache-2.0, so it is probably fine, but the check
    is the owner's gate, not mine.
18. **Subtitles: word-by-word captions for narrated stories only** `[DATA, weak]`. Build: none; optional.

### Map kit (only if the owner picks map explainers)

19. **Natural Earth is the boundary source (public domain, no credit).** Do not use GADM: its licence does not
    allow commercial use without permission `[source: gadm.org/license, per review F7]`. geoBoundaries is CC BY
    (credit and per-country check); OpenStreetMap is ODbL (credit line). Each goes into
    `licenses/register.json` before any download. The register has a Natural Earth entry already
    (line 295); GADM, geoBoundaries and OSM have none. Build: `licenses/register.json`, serialized through the
    supervisor (the register is shared).
20. **No current wars or disputed borders at the start.** Sensitive-event content may not monetize
    `[YOUTUBE, help 6162278]`; in the sample, border videos did not help views (11 higher, 10 lower)
    `[DATA, lane 04]`. Some states require their own border depiction `[GUESS]`. Build: the map theme in
    `.claude/skills/codebuilt-maps/SKILL.md`.

### Money (no build now)

21. **Plan no income from the Shorts ad pool.** From 2027-02-01 a channel needs 10M qualified Shorts views in
    90 days to earn from it, and 20M to join the Partner Program through Shorts `[YOUTUBE, blog 2026-08-10]`.
    The long-form path is the realistic route (8,000 watch hours). Build: a later long-form lane, not M6.

## 3. Conflicts and gaps to settle before merge

- **Item 15**: the owner's practice-channel decision overrides the research's stop-uploading advice. Owner to confirm.
- **Item 12 and the cap**: P2 says "no default cap". The research suggests one a day. This proposal only
  recommends a number; the owner sets it.
- **Item 17**: the register must show that the Qwen speakers allow monetized use (its entry says Apache-2.0,
  checked 2026-11-13). Not re-checked in this lane.
- **Title and description**: the research gives no measured title format; items 6 to 9 are guidance, not
  evidence-tested rules.
- **Map explainers vs physics loops**: the research does not pick one. The owner chooses between them, or runs
  both as equal pilots (review verdict item 1).

## 4. Intended file ownership if approved (M6 lane)

| File | Change | Lane conflicts |
|---|---|---|
| `.claude/skills/codebuilt-script/SKILL.md` | hook: premise within 3 s; ending: no CTA by default | none known |
| `.claude/skills/codebuilt-direction/SKILL.md` | frame-0 rule: subject on screen | none known |
| `.claude/skills/codebuilt-maps/SKILL.md` | map kit: Natural Earth, no current wars or disputed borders | M3 (map proof) also edits maps; coordinate |
| `dashboard/server/episode/codebuilt/lightMetadata.js` | title prompt: plain premise title, no date title, no template | P1 (title field); coordinate |
| `dashboard/server/episode/codebuilt/planner.js` | premise gate, advisory first | M2, M4 also edit planner.js; serialize |
| `dashboard/server/episode/codebuilt/autoTopic.js` | premise scoring | M4 also edits autoTopic.js; serialize |
| `licenses/register.json` | map data entries (GADM not allowed) | shared; supervisor serializes |

Not in this proposal: any change to `docs/BACKLOG.md`, the ForgeBrain vault, `dashboard/client/dist`, the server
code while a run is active, or auto release settings.

## 5. Sources

- `ForgeBrain/research/youtube-shorts-2026-11-14/FINAL-REPORT.md` (sections 2, 4.3, 5, 6, 7, 9)
- `11-review-REVIEW.md` (F1, F4, F5, F7, verdict), `12-map-check-REPORT.md` (section 1)
- `02-money-policy-accounts-REPORT.md` (B4, B5, music, YPP rules)
- `06-watch-winners-REPORT.md` (premise rules), `04-breakout-channels-REPORT.md` (pace, waiting)
- `licenses/register.json` (Qwen and Natural Earth entries)
