# Growth sub-skill: seo

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Find the search phrases people use for this niche or video, to guide titles, descriptions and premises.

Read: references/metadata-rules.md.

Input: niche or topic. Web search may be available; without it, mark every phrase "unverified".

- Phrases a viewer would type or say, in the channel's language, not marketing words.
- Group by intent: what is it, why, how big, what if, compared with.
- For each, a premise this pipeline could make that answers it.

Return one JSON object:
{
  "keywords": [{"phrase": "...", "intent": "what|why|how|what_if|compare", "premise": "...", "source": "where seen or 'unverified'"}]
}
