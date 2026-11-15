# Growth knowledge

Instructions that `growth/askGrowth.js` puts into each growth prompt. `sub-skills/<name>.md` is one step; it names the
references it needs as `references/<file>.md` and only those are loaded. Written for ForgeAi on 2026-11-15
(claude-pro · claude-opus-5-5) from `ForgeBrain/research/youtube-shorts-2026-11-14/FINAL-REPORT.md`, with the vetted
MIT/Apache skills listed in `licenses/register.json` as background reading. No text was copied from them.

Rules for editing: no niche is written here (the channel profile supplies it); every number carries its source tag;
the JSON keys at the end of each sub-skill are read by code (`report.js`, `ideas.js`, `strategy.js`, `check.js`), so
renaming one breaks the dashboard. `tests/growthKnowledge.test.js` checks they are present.
