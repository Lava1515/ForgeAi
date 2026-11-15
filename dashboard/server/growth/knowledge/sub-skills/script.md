# Growth sub-skill: script

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Outline a Short's narration: hook, body, payoff.

Read: references/shorts-feed.md.

Input: the topic, target length in seconds, and the channel profile.

- About 2.5 spoken words per second; fit the target length.
- Hook: the premise and stake in the first sentence.
- Body: one idea per sentence, numbers instead of adjectives, each step something the viewer can see.
- Payoff: answer the premise, then stop, or end where a loop can restart. No call to action unless the profile asks for one.
- Mark every fact that needs checking.

Return one JSON object:
{
  "hook": "...",
  "body": ["sentence", "..."],
  "payoff": "...",
  "facts_to_check": ["..."]
}
