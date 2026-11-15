---
type: plan
author: claude-pro · claude-opus-5-5
created: 2026-11-15 20:25 +02:00
status: active
---

# Content, publishing and growth lanes (G1 to G6)

Owner order, 2026-11-15 about 20:15: add the content, publishing and monitoring skills to the fleet plan, make the
plan detailed, and build it today. Branch `feat/content-growth-skills` (worktree `.worktrees/content-growth`).
It merges only when no video run is active (CLAUDE.md rule 2), after one review by a different model family.

## Why

What ForgeAi had on 2026-11-15:

- **Making videos:** seven project skills (`codebuilt-script`, `-direction`, `-scene-generation`, `-look-review`,
  `-maps`, `-history`, `-teardown`).
- **Publishing:** the Publish button, scheduling and auto release (`routes/youtube.js`, `routes/autoRelease.js`).
  Titles and tags come from one-line prompts in `episode/codebuilt/lightMetadata.js` that see only the topic.
- **Growth:** `dashboard/server/growth/` asks the model for an analysis, an audit, ideas and a strategy. It
  reads its instructions from `growth/knowledge/sub-skills/*.md`, **but that folder does not exist in this repo.**
  It was left behind when the code was taken over from `ForgeAi-old`. Every growth call has run on the one-line
  placeholder "Execute growth workflow for X" and no output schema, so the report fills in fake "B" grades.
- **Monitoring:** `routes/channel.js` reads public numbers (views, likes, comments) only when someone presses
  Scan. Nothing records how a video grows over time, so the cohort report (`growth/report.js`) always says
  "unavailable" for 1, 2, 7 and 28 days.
- **No skill teaches publishing copy or how to read the numbers.**

External skills were vetted on 2026-11-15 (`output/temp/skill-search/VETTING.md`). None is installed as is: they
are generic social media advice, some push a paid scheduler (WoopSocial) that would break rule 6, and one repo
shows a bought-stars pattern. What these lanes write is ForgeAi's own text. It draws on our research
(`ForgeBrain/research/youtube-shorts-2026-11-14/FINAL-REPORT.md`) first and on the vetted MIT and Apache
skills as reference. Those sources are recorded in `licenses/register.json`.

## Rules for every lane

- Generic pipeline: no niche is hardcoded. The niche comes from the channel profile (`growth/profiles.js`,
  `channelsManager`).
- Never upload, never publish, never switch auto release on (rule 6). The watcher only reads public numbers.
- Every claim in a skill carries its strength: `[YOUTUBE]` YouTube said it, `[DATA]` we measured it,
  `[CREATOR]` someone claims it. No invented benchmarks; the growth quality gate already refuses a benchmark
  that has no source.
- Tests only for damage that actually happened (rule 3): the missing knowledge folder, and snapshot ages.

## Lanes

| Id | Lane | State | Files (one owner each) | Done when |
|---|---|---|---|---|
| G1 | Growth knowledge base | BUILD TODAY | `dashboard/server/growth/knowledge/**` (new), test `tests/growthKnowledge.test.js` | Each of the 10 sub-skills named in `askGrowth.js` exists and states the exact JSON keys the consumers read (`report.js`, `ideas.js`, `strategy.js`, `check.js`); three references (feed, metadata, numbers); the test fails if a file or a required key is missing |
| G2 | Publishing copy skill | BUILD TODAY | `.claude/skills/codebuilt-publish/SKILL.md` (new), `paths/codebuilt.json` (skill + `skillsByStep.publish`), `episode/codebuilt/lightMetadata.js`, one call in `episode/codebuilt/start.js` | The drafting step loads the skill and passes the script and premise, so titles and tags describe what the video shows; a failure still falls back to the topic as before |
| G3 | Stats watcher and age snapshots | BUILD TODAY | `dashboard/server/growth/snapshots.js` (new), `routes/channel.js`, `growth/report.js` (passes the ages to the analysis) (record after a scan, `channelWatchRun`), `scripts/supervisor/start_codebuilt_dashboard.mjs` (call it in the existing loop), test `tests/growthSnapshots.test.js` | Each scan stores views, likes and comments per video with its age. Videos carry `analytics_history` at 1, 2, 7 and 28 days, which the cohort report already reads. The existing loop rescans each channel that has an API key every 3 h. It reads only, so quota use stays tiny |
| G4 | Growth review skill | BUILD TODAY | `.claude/skills/codebuilt-growth/SKILL.md` (new) | An agent can follow it to read the numbers (endpoints, files), judge a video at 1, 2 and 7 days, apply the pilot's stop rule, and write a change proposal for the owner. It never publishes |
| G5 | YouTube Analytics numbers | OWNER | `routes/youtube.js` sign-in scope, `routes/channel.js` | Needs `yt-analytics.readonly` on the channel login (owner). Then: stayed-to-watch against swiped away, average percentage viewed, subscribers gained and viewer countries per video, stored next to the G3 snapshots |
| G6 | Growth page shows growth over time | NEXT (after G3 merges) | `dashboard/client/src/pages/Growth.jsx` (+ `npm run build`) | Per video: views at 1, 2 and 7 days and views in the last 24 h; the stop-rule state per channel |

The lanes share no files, so G1 to G4 can run in parallel. G3 edits `routes/channel.js` and the launcher, and
nobody else edits those. G2 edits `start.js` on one line only.

## G1: knowledge base contents

`growth/knowledge/sub-skills/<name>.md`. Each file says what the step is for, what input it gets, the method,
and the JSON shape to return. A sub-skill names the references it needs as `references/<file>.md`, and
`askGrowth.js` loads only those.

| Sub-skill | Called by | Must return (read by) |
|---|---|---|
| analyze | `report.js` | `analysis` (object), `scores`, `top_actions[] {action, impact, effort, category, details}`, `next_subskill {id, label, reason}` |
| audit | `report.js` | `audit {scores {seo, performance, strategy, monetization, overall}, action_plan[]}`, `top_actions[]` |
| ideate | `ideas.js` | `ideas[] {topic, title, why, score}` |
| competitor | `ideas.js` | `competitor_insights {patterns[], gaps[] {topic, reason, score}}` |
| strategy | `strategy.js` | `strategy {content_pillar, upload_cadence, positioning, pillars[]}` |
| metadata (also titles, tags) | the growth menu | `titles[]`, `description`, `tags[]` |
| hook | the growth menu | `topic_analysis`, `hooks[]` |
| script | the growth menu | `hook`, `body`, `payoff` |
| seo | the growth menu | `keywords[]` |
| shorts | the growth menu | `shorts_plan` |

References: `shorts-feed.md` (how the feed picks videos, what YouTube denies), `metadata-rules.md` (title,
description, tags and the first frame), `numbers-guide.md` (which numbers exist, what each one means, the pilot
thresholds).

## G3: snapshot design

- Store: `data/trends/snapshots_<channel>.json` (`snapshots.json` for the default channel) as
  `{ video_id: [{ at, age_h, views, likes, comments }] }`. A new point is kept only if 45 minutes or more have
  passed since the last one. Each video keeps at most 200 points: the first 48 hours stay dense, then roughly
  one point a day.
- Ages: `analytics_history` holds the point nearest to 1, 2, 7 and 28 days, within a window of a quarter of that
  age and no more than 36 hours. With no point in the window there is no entry, and the report says unavailable
  (no guessing).
- Each video also gets `views_24h`: views gained over the last 24 hours, or null with fewer than two points.
- Loop: `channelWatchRun()` runs in the existing 60 s schedule loop. Each channel with an API key is scanned at
  most once every 3 hours, and an error is logged without stopping the loop. Quota: about 1 unit per 50 videos
  per scan.

## After merge

Restart the host dashboard (`scripts/start_dashboard.ps1`) once no run is active. Press Scan once per channel,
then check `data/trends/snapshots*.json`. Point the owner at G5 (the Analytics sign-in scope).
