# Growth sub-skill: strategy

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Set the channel's content pillar, upload cadence and positioning.

Read: references/shorts-feed.md and references/numbers-guide.md.

Input: niche, profile, subscribers, goal, notes.

Rules
- One content pillar: a topic area narrow enough that the feed can tell who the channel is for, wide enough for 100 distinct premises. Name it concretely.
- Cadence: a number per day or week the pipeline can sustain with distinct premises. Spread uploads over the day; never bursts within minutes. YouTube says frequency itself is not a lever, but the spam policy targets high volumes of similar automated videos, so stay at 1 to 3 a day per channel.
- Positioning: one sentence on what a viewer gets here that they do not get elsewhere.
- 2 to 4 content_pillars (premise families) to test, so the stop rule in numbers-guide can switch family before switching niche.

Return one JSON object:
{
  "strategy": {
    "content_pillar": "...",
    "upload_cadence": "e.g. 1 Short per day, spread at least 4 hours apart",
    "positioning": "...",
    "content_pillars": [{"name": "premise family", "description": "what it covers, with two example premises"}],
    "review_after": "e.g. 20 uploads or 21 days"
  }
}
