# Growth sub-skill: analyze

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Diagnose why this channel's Shorts get the views they get, from the numbers in the input, and say what to change first.

Read: references/shorts-feed.md and references/numbers-guide.md.

Input: `summary` (totals, median views per hour, scan time), `best` (leaderboards by voice, style, theme), `recent_videos` (title, views, views_per_hour, views_24h, analytics_history by age, length, theme, voice; retention fields when available).

Method
1. Compare videos at the same age (analytics_history 1, 2, 7 days), not raw totals. Use medians.
2. Split the videos into the better and worse half. What do the better ones share: premise kind (one concrete subject with a stake, or a list), title (premise stated, or vague or a date), length, theme, voice? Name the pattern with the titles that show it.
3. Decide which feed step is most likely failing: topic signal (titles vague, topics scattered, metadata empty), or stay-or-swipe (needs retention numbers; if they are missing, say "unavailable" and name the Studio numbers the owner should look at).
4. Look for channel-level policy risks in the data: bursts of uploads within minutes, duplicate titles, one title template on many videos.
5. Pick at most 5 actions, the most likely to move the typical video first. Each action names what to change in the pipeline (premise, title, first frame, length, topic area) and how we will see if it worked.

Do not write advice that would fit any channel. Every action must point at this channel's videos or numbers. Do not invent retention, CTR or subscriber numbers that are not in the input. A benchmark must carry `source` or say "benchmark unavailable".

Return one JSON object:
{
  "analysis": {
    "summary": "two or three sentences on where the channel stands",
    "patterns": [{"finding": "...", "evidence": ["video titles or numbers"], "strength": "strong|moderate|weak"}],
    "failing_step": {"step": "topic_signal|stay_or_swipe|watch_time|unknown", "why": "...", "needs": "numbers that would confirm it"},
    "policy_risks": ["..."],
    "priority_actions": [{"action": "...", "impact": "high|medium|low", "effort": "high|medium|low", "category": "premise|title|first_frame|length|topic|cadence|metadata", "details": "how to check it worked"}]
  },
  "scores": {"performance": "A|B|C|D|F"},
  "top_actions": [same shape as priority_actions, at most 5],
  "next_subskill": {"id": "hook|metadata|ideate|strategy|script|shorts", "label": "...", "reason": "..."},
  "benchmarks": [{"metric": "...", "value": "...", "source": "reference name or 'benchmark unavailable'"}]
}
