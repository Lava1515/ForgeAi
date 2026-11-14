# M6: YouTube-informed prompt rules (taken, narrow)

author: claude-pro · claude-haiku-5-5
created: 2026-11-14 21:19 +02:00
lane: M6 (docs/BACKLOG.md)
decision: `ForgeBrain/decisions/2026-11-14-m6-narrow-prompt-rules-taken.md` (supervisor, 2026-11-14 21:18)
supersedes: the 21-item proposal in commit `1e1beda`

## Taken (implemented in this lane)

1. **Premise and stake in the opening.** The script hook names the subject and one concrete stake (place, object,
   person or number) within the first two seconds, in the words. Edit: `.claude/skills/codebuilt-script/SKILL.md`,
   "The hook" (one bullet added).
2. **Subject visible at frame 0.** Already in `codebuilt-direction` (first shot and "Premise at the opening and
   ending"). No change.
3. **Hook sentence, payoff ending, no call to action.** Already in `codebuilt-script` ("The hook", "The ending",
   "Premise at the opening and ending"). No change.
4. **Plain, accurate, descriptive title, about 6 to 10 words as guidance.** Edit:
   `dashboard/server/episode/codebuilt/lightMetadata.js`, title prompt only. The validator is unchanged; the
   title is not checked for word count.

Precedence: the duration, word-count and JSON-shape limits in each prompt still win over this guidance, as the
skills already say.

## Explicitly not done

- No new upload, release or publish gate; no change to `autoTopic.js`, `planner.js`, the map skill or any
  licence or register entry.
- No cap on uploads per day. The auto release cap stays with the owner.
- No camera-path ban and no title-template ban.
- No topic bans, no new loop video type.
- No monetization or income prediction.
- No change to the AI disclosure defaults.
- No change to the old channel's status (practice channel, owner decision 2026-11-14).

## Sources

- YouTube Help, "Disclosing use of altered or synthetic content" (support.google.com/youtube/answer/14328491),
  read 2026-11-14 with the WebFetch tool. Disclosure is required for realistic altered or generated content;
  non-realistic content and fully animated work do not need it. Voice: the page's example is cloning one's own
  voice. It does not state the rule for unrealistic AI voices, so this lane does not claim one.
- YouTube Partner Program overview (support.google.com/youtube/answer/72851), checked by the supervisor. This lane
  makes no threshold claims.

## Rule 10 (not done here)

Video-affecting changes need the three-video proof from the M6 decision. The supervisor runs it. This lane does not
run videos, upload, merge to main or restart anything.
