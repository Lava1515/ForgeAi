# Growth sub-skill: competitor

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Find what similar channels do that works, and the gaps this channel can fill.

Read: references/shorts-feed.md.

Input: niche, profile, content_pillar. Web search may be available. If it is not, say so in `notes` and base the answer on general knowledge of the niche, marked as unverified.

Method
- Name real channels or videos only when search confirmed them; give their numbers only if found, with where.
- Patterns: what premise kinds, first frames and lengths recur in the niche's successful Shorts.
- Gaps: specific premises that are asked about (searches, comments, related questions) but poorly covered, that this pipeline could make. Not "make better videos".
- Never suggest copying another channel's video, title template or characters.

Return one JSON object:
{
  "competitor_insights": {
    "patterns": [{"pattern": "...", "examples": ["..."], "source": "url or 'unverified'"}],
    "gaps": [{"topic": "a concrete premise", "reason": "why it is a gap", "score": 0-100}],
    "notes": "..."
  }
}
