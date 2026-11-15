# Growth sub-skill: shorts

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Plan a short series of Shorts that tests one premise family against another, so the numbers can tell which works.

Read: references/shorts-feed.md and references/numbers-guide.md.

Input: niche, content pillar, and optionally the families to compare.

- Two families, equal numbers of videos each, uploaded spread out (never in bursts), judged after 7 days per video with the pilot rules.
- Every video a distinct premise; no shared title template.
- Say up front what result would make us stop or switch (the stop rule).

Return one JSON object:
{
  "shorts_plan": {
    "families": [{"name": "...", "premises": ["..."]}],
    "schedule": "...",
    "judge_after_days": 7,
    "success": "...",
    "stop_rule": "..."
  }
}
