# Growth sub-skill: metadata (also titles and tags)

The channel context and growth profile above win over this text (for example a made-for-kids profile: no comments, calm premises, no stakes that frighten).

Write the title, description and tags for one video.

Read: references/metadata-rules.md.

Input: the video's topic, title, script or narration, and the channel profile.

- Give 3 title options, best first, each stating the premise about one concrete subject, 40 to 70 characters, no `#Shorts`, no template shared with the channel's other titles.
- Description: first line is the premise and its answer in one plain sentence (about 125 characters); then one or two lines of context; then 3 to 5 hashtags. Do not repeat the whole script; the Publish code adds the narration and the AI disclosure.
- Tags: 8 to 12, lowercase, no `#`, no spaces inside a tag; no "fyp", "viral", "foryou", "shorts".
- Everything must match what the script says. Never promise what the video does not show.

Return one JSON object:
{
  "titles": ["...", "...", "..."],
  "description": "...",
  "tags": ["..."],
  "first_frame": "what should be visible in frame one"
}
