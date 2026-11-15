---
name: codebuilt-growth
description: How an agent checks how ForgeAi's published shorts are doing (views over time, the stop rule, what to change next) and writes a change proposal for the owner. Use for "how are the videos doing", "monitor the channel", "why no views", "what should we change", or a pilot check. Never publishes.
---

# Code-built growth review

Read-only work: read the numbers, compare like with like, and propose changes. Never upload, publish, schedule or switch auto release on (CLAUDE.md rule 6). Never change a channel's settings without the owner. Background: `dashboard/server/growth/knowledge/references/numbers-guide.md` and `shorts-feed.md`.

## Where the numbers are

- `GET http://127.0.0.1:3000/api/channel` (the active channel; `X-Channel-Id` header for another): the latest scan. Each video has `views`, `likes`, `comments`, `views_per_hour`, `published_at`, `duration_s`, and since G3 `analytics_history` (views at 1, 2, 7 and 28 days, only where a scan happened near that age) and `views_24h`.
- `POST /api/channel/scan`: scan now. The host dashboard also rescans every channel that has an API key every 3 hours (`channelWatchRun` in `routes/channel.js`), so a manual scan is rarely needed.
- Files: `data/trends/channel.json` and `channel_<id>.json` (latest scan); `data/trends/snapshots.json` and `snapshots_<id>.json` (every point over time, `{video_id: [{at, age_h, views, likes, comments}]}`).
- `GET /api/growth/report` (model-written analysis and audit; `POST /api/growth/report/refresh` makes a new one, using agy first). `?tag=<style>&age_days=7` gives a cohort comparison at one age (cohorts read the stored `analytics_history`).
- What each video was: `output/drafts/<draft>/metadata.json` (topic, type, voice, duration, premise, fact check, `generation_details.job_id`).
- Retention, stayed-to-watch, swipe-away and viewer countries need the Analytics permission (backlog G5, owner). Until then, say "unavailable". Do not estimate them from views.

## How to judge

1. Compare at the same age. Use `analytics_history` at 1, 2 and 7 days. A video younger than the age has no value there, which is not zero.
2. Use the median (the typical video), not the average. Report the best video separately.
3. A Short with `views_24h` near 0 after day 3 has stopped. Do not wait on it [CREATOR: failed Shorts almost never revive].
4. Pilot and stop rule (research 2026-11-14): judge each video after 7 days. Target: the typical Short passes 1,000 views. Stop: after 20 uploads in one format on one channel, if the typical Short is under 300 views and nothing passed 10,000, that format is not working there. Change the premise family first, the niche second.
5. Split better and worse halves and look for what differs: premise kind (one concrete subject with a stake against a list or a vague topic), title (premise stated against vague), first frame (subject visible or not), length, type, voice, theme. Name the videos that show it. Fewer than 6 videos at the same age: say the sample is too small.
6. Check channel-level risks: uploads in bursts within minutes, duplicate or near-duplicate titles, one title template on many videos.

## What to write

A short report in the job folder (`output/agent-jobs/<job id>/REPORT.md`) and a session note in the brain:
- The numbers table: video, published, age, views at 1/2/7 days, views_24h, type, length.
- The median and best at each age, against the targets above, with each source tag.
- At most 3 proposed changes, each naming the pipeline place it touches (for example `codebuilt-script` premise rules, `autoTopic.js`, `codebuilt-publish` title rules, channel profile) and how the next 7-day check would show it worked.
- What is unavailable and what the owner could give to fill it (Studio numbers, the Analytics permission).

A change to prompts or skills goes through the normal lane process: branch, review by another model family, merge when no run is active.
