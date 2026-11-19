# Rules for every agent working in this project

**What ForgeAi is (owner, 2026-11-14).** ForgeAi is the one place for everything: finding topics, making the
video, checking it, publishing it, scheduling it, and learning from the results. The code-built video path is
the core, but anything the owner wants around it is built here, in this repo, not in a new project. The old
project (`C:/code/ForgeAi-old`) is a reference for ideas only: when something in it is wanted, write it again
against the code-built path, do not copy it over. The list of work is `docs/BACKLOG.md`; anything on it that is
not marked blocked can be taken by the fleet.

1. **Monetization licence gate (owner, 2026-11-13).** Before you use anything from outside in this project (an AI
   model, a voice, music, sound, an image, a 3D model, a font, a library, a container image, a dataset), check its
   licence at the source. It may be used only if the licence allows monetized (commercial) videos. Credit-required
   licences are fine when the credit goes into the video description. Non-commercial, research-only and unclear
   licences are out: do not download it, do not wire it in, propose an allowed alternative instead.
   Record every such thing in `licenses/register.json` (licence, source link, date, how you checked) and run
   `python tools/license_check.py`. The check runs before every commit and fails on anything missing or not allowed.

   An agent may install a tool, library, model, or asset it judges useful, only after a Fable thread approves in
   writing with three checks (necessary; not malware: what was checked, pinned version/commit; licence allows
   monetized videos). All three must be yes; no other model's approval counts. The approval goes in the register
   entry's how-checked field.
2. **Lean process, fleet allowed.** Take work from `docs/BACKLOG.md`. One review by a different model family
   before merging. When only Claude can review (owner, 2026-11-17): Fable may review any work, and Opus may review
   work built by Sonnet or Haiku; a model never reviews its own work. No ticket system, no supervisor relays. Fleet (owner, 2026-11-14): Sol supervises; at most 3 Codex
   workers (Sol, Luna), 4 Claude workers (Opus, Sonnet, Haiku) and 15 agy workers (5 each on the nintendo, clash
   and folk_guy accounts) at once; fewer is fine. Each worker uses its own git worktree and its own files; two workers never edit the same file. Never change
   a file a running job is using (the mounted Python under `blender_worker/` and `narrative_factory/`, the server
   code, `dashboard/client/dist`) while a video run is in progress: finish on a branch, merge after the run, and
   restart the dashboard then. Tell the owner what was merged.
3. **Tests** only for real damage (the job fence, music level, video length) and for bugs that actually happened.
4. **No paid API keys.** AI calls go through the Claude and agy command-line tools.
5. A job may write only inside its own folder under `output/agent-jobs`.
6. **Publishing.** An agent never uploads or publishes a video itself. A video goes out only through the
   dashboard's Publish button (the owner presses it) or through auto release. Auto release is built in this repo
   and stays OFF per channel until the owner switches it on for that channel; an agent never switches it on.
7. The dashboard is local only: there is no admin token and no review step before publishing (owner, 2026-11-14).
   Do not add either back.
