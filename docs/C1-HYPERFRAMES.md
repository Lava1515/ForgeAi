# C1 host text pass

Written 2026-11-19 14:40 +02:00 by codex · gpt-6.1-sol.

Branch: `t3/c1-hyperframes-text`. Default OFF. Review and merge belong to the supervisor; nothing pushed or merged by this worker.

The existing host producer runs after the executor is gone. On opted-in authored jobs, CB5 grades and muxes a base without drawing text, then HyperFrames draws the words, running counter and anchor labels. Original DOM blocks use paused Web Animations and a deterministic `hf-seek` function. Big numbers trigger a short flash. Existing tag, big-number, bar and measure fields remain readable for authored overlay.json compatibility. No catalog source, animation library, remote scripts or remote fonts are used. Existing sound synthesis/mixing stays in CB5; the final mux copies its audio stream unchanged.

## Enable after review

Set these in the dashboard host environment, then restart it at zero jobs:

```powershell
$env:FORGE_HYPERFRAMES_TEXT = '1'
$env:FORGE_HYPERFRAMES_CLI = 'C:/Users/Lava/AppData/Local/npm-cache/_npx/702923228c2ce1e6/node_modules/hyperframes/bin/hyperframes.mjs'
$env:FORGE_HYPERFRAMES_BROWSER = 'C:/Users/Lava/.cache/hyperframes/chrome/chrome-headless-shell/win64-158.0.8127.36/chrome-headless-shell-win64/chrome-headless-shell.exe'
$env:PATH = 'C:/Users/Lava/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin;' + $env:PATH
```

Only `route === 'authored'` plus the exact flag `1` selects it. Unset the flag to disable it. Route identity is retained in new host job state for post-only completion. Jobs whose state predates C1 lack that route field and keep the old post-only behavior. For an isolated host post rerun, with the executor already stopped and its words/mix staged:

```powershell
python -I narrative_factory/codebuilt/post/cb5_main.py <absolute-job-folder> --hyperframes
```

The CLI package must be **0.9.70**, checked from its installed package.json. No npx, installer or browser-ensure call is used. Both CLI and browser paths must exist; FFprobe must already be on PATH. Chrome headless shell **158.0.8127.36** passed the CPU sample; installed desktop Chrome stalled at capture and was stopped with its child processes. Missing prerequisites fail explicitly. Any additional installation needs Fable approval; none was performed.

The pass uses one worker, software browser capture and CPU encoding. It runs within the current serialized job's host post step, never inside the executor. Project files, render intermediates, caches, logs and output stay in a fresh directory under that job. A 25-minute timeout stops that render's process tree. The composition's CSP allows only local assets; telemetry is disabled. The font is an unmodified Inter Bold WOFF2 from the already installed HyperFrames distribution, with its OFL notice, copied into the repo. Both CLI and font source checks are in licenses/register.json. Source licences: [HyperFrames Apache-2.0](https://github.com/heygen-com/hyperframes/blob/main/LICENSE), [Inter OFL-1.1](https://github.com/rsms/inter/blob/master/LICENSE.txt).

## Validation

- CPU sample: `output/agent-jobs/c1-sample/out/video.mp4` in this worktree, 3.000 seconds, 270×480, 30 fps, video and audio present. Latest text render, remux and sheet took **10.36 seconds**. Source frames are synthetic; no pipeline video was started.
- Visually inspected the decoded contact sheet: captions appear word by word with voice lead, the counter advances, the label follows the moving anchor, and the final big number appears. Source MP4 has exactly 90 frames; output probe matches its duration and size. Decoded mean RGB at 2.60/2.70/2.95 seconds is (39,50,55)/(118,125,128)/(34,47,55), confirming the brief flash brightens and returns. No listening claim.
- Python: **472 passed**, 6 subtests passed; 5 existing Pillow deprecation warnings.
- Server: **584 passed** after linking the existing dependencies through an absolute junction. Initial missing-express failure was local test setup and was corrected without installation.
- Licence checker passes (38 entries); its 19 existing source-recheck reminders remain. `git diff --check` passes. No new tests/fixtures or proof machinery.

Limits: this is a small CPU proof, not a production-size performance measurement. Labels clamp to screen margins and hide when their anchor is behind the camera, absent or occluded. It does not run the former Pillow collision/layout gate; overlapping authored elements remain an author/layout issue. The current audio level and duration checks stay. Default remains OFF for supervisor review and activation.

## Files

All changes are C1 or its required activation/licence/documentation support; **outside-lane changes: none**.

- `dashboard/server/episode/engines/codebuilt/producer.js`: host switch and installed-tool path forwarding.
- `dashboard/server/episode/engines/codebuilt/runner.js`: pass/persist host route for producer selection and post-only completion.
- `licenses/register.json`: pinned CLI and bundled OFL font entries (supervisor should reconcile with concurrent A3 additions).
- `narrative_factory/codebuilt/post/cb5.py`: optional authored host text pass, existing audio retained.
- `narrative_factory/codebuilt/post/cb5_main.py`: explicit `--hyperframes` entry point.
- `narrative_factory/codebuilt/post/run.py`: optional base encode without Pillow captions.
- `narrative_factory/codebuilt/post/hyperframes_text.py`: validated-data adapter, local composition, CPU render, remux and output duration checks.
- `narrative_factory/codebuilt/post/hyperframes_assets/text.js`: original browser text blocks.
- `narrative_factory/codebuilt/post/hyperframes_assets/text.css`: local type and positioning.
- `narrative_factory/codebuilt/post/hyperframes_assets/Inter-700.woff2`: existing bundled OFL font.
- `narrative_factory/codebuilt/post/hyperframes_assets/OFL-inter.txt`: font copyright/licence notice.
- `docs/C1-HYPERFRAMES.md`: this report and enable instructions.

Found, not built: none.

Brain note:
codex · gpt-6.1-sol: C1 defaults OFF; enable only after review with FORGE_HYPERFRAMES_TEXT=1 and installed CLI/browser paths; CLI pinned 0.9.70.
codex · gpt-6.1-sol: Use installed Chrome headless shell 158.0.8127.36 for CPU capture; desktop Chrome stalled. New host state retains authored route for post-only completion.
codex · gpt-6.1-sol: Font is bundled Inter Bold/OFL, not the Windows fonts from the demo. Reconcile C1 licence entries with A3 before merging.
