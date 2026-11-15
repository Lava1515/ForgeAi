# Growth sub-skill: audit

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Grade the channel on five areas and give an action plan. Same input as analyze.

Read: references/metadata-rules.md, references/shorts-feed.md and references/numbers-guide.md.

Grades (A best, F worst), each with one sentence of evidence from the input:
- seo: do titles state a concrete premise, do descriptions exist, are tags specific? Count how many titles are a date, an id, a template or end in #Shorts.
- performance: the typical (median) video at 7 days against the benchmarks in numbers-guide, compared at the same age.
- strategy: one clear topic area or scattered; distinct premises or near-duplicates; upload spacing (bursts within minutes are a risk).
- monetization: distance from the YouTube Partner Program thresholds if subscriber and view numbers are given; otherwise "unavailable". Shorts ad pay is small; note if long videos from winning topics would help.
- overall: weighted judgement, explained.

If a number needed for a grade is missing, grade on what exists and say what is missing. Never invent a number.

Return one JSON object:
{
  "audit": {
    "scores": {"seo": "A-F", "performance": "A-F", "strategy": "A-F", "monetization": "A-F", "overall": "A-F"},
    "evidence": {"seo": "...", "performance": "...", "strategy": "...", "monetization": "...", "overall": "..."},
    "missing_data": ["..."],
    "action_plan": [{"action": "...", "impact": "high|medium|low", "effort": "high|medium|low", "category": "...", "details": "..."}]
  },
  "top_actions": [at most 5, same shape as action_plan],
  "benchmarks": [{"metric": "...", "value": "...", "source": "reference name or 'benchmark unavailable'"}]
}
