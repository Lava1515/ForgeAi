# Rules for every agent working in this project

1. **Monetization licence gate (owner, 2026-11-13).** Before you use anything from outside in this project (an AI
   model, a voice, music, sound, an image, a 3D model, a font, a library, a container image, a dataset), check its
   licence at the source. It may be used only if the licence allows monetized (commercial) videos. Credit-required
   licences are fine when the credit goes into the video description. Non-commercial, research-only and unclear
   licences are out: do not download it, do not wire it in, propose an allowed alternative instead.
   Record every such thing in `licenses/register.json` (licence, source link, date, how you checked) and run
   `python tools/license_check.py`. The check runs before every commit and fails on anything missing or not allowed.
2. **Lean process.** One review by a different model before merging. No ticket system, no supervisor relays.
3. **Tests** only for real damage (the job fence, music level, video length) and for bugs that actually happened.
4. **No paid API keys.** AI calls go through the Claude and agy command-line tools.
5. A job may write only inside its own folder under `output/agent-jobs`.
6. Never publish or upload a video without the owner.
