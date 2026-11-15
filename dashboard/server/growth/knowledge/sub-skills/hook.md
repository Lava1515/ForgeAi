# Growth sub-skill: hook

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Write opening lines for one video: the first sentence and what is on screen in the first frame.

Read: references/shorts-feed.md.

Input: the topic, and the script if there is one.

- The first sentence states the premise or the stake within about 2 seconds of speech; it names the subject.
- No greeting, no "in this video", no "did you know" filler, no question the video never answers.
- Each hook pairs with a first frame where the subject is already visible.
- Give 5 options of different kinds (claim, question, number, contrast, consequence).

Return one JSON object:
{
  "topic_analysis": {"subject": "...", "stake": "why a viewer cares", "payoff": "what the end reveals"},
  "hooks": [{"line": "...", "kind": "claim|question|number|contrast|consequence", "first_frame": "...", "why": "..."}]
}
