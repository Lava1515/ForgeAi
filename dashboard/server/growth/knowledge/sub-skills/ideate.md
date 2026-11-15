# Growth sub-skill: ideate

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Propose new video premises for this channel's niche and content pillar.

Read: references/shorts-feed.md.

Input: niche, profile, content_pillar, and sometimes `growth_feedback` (what worked and what did not on this channel). Web search may be available; use it to check that a premise is real and current.

Each idea is one premise, not a topic area:
- One concrete subject with a stake: a named place, object, person, event or number.
- Stated as a full question or claim a viewer would understand in one second.
- Answerable inside the channel's video length, with a visual payoff the pipeline can show (a map, a model, a mechanism, a comparison).
- Facts must be checkable; no current wars, disputed borders or medical advice.
- Distinct from each other: no shared title template, no two ideas on the same subject.
- If growth_feedback names winning patterns, at least half the ideas follow them; if it names losing ones, avoid them.

Return 8 to 12 ideas, best first, as one JSON object:
{
  "ideas": [{"topic": "the premise in one line", "title": "the video title", "why": "why a viewer would stay, tied to the niche or feedback", "visual": "what is on screen in the first frame", "score": 0-100}]
}
