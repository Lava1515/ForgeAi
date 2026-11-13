# ForgeAi

Code-built YouTube Shorts: a topic goes in, a model writes the script and the Blender scene code, the scene is
rendered in a locked-down container, and a draft video comes out. Nothing is published without the owner.

This project was started fresh on 2026-11-13 from the code-built path of the earlier ForgeAi. The earlier project,
with every older video path (Studio, Episodes, kids, merch, any-story), is the archive in `C:\code\ForgeAi-old`.

## Run it

1. Voice service: `docker compose up -d narrative-factory` (listens on 127.0.0.1:5050).
2. Dashboard: `powershell -ExecutionPolicy Bypass -File scripts/start_dashboard.ps1`, then open http://127.0.0.1:3000.
3. After a change to the dashboard pages: `npm run build` in `dashboard/client`.

## What is where

| Folder | What it holds |
|---|---|
| `dashboard/server` | The dashboard server. `app.js` lists every route. `episode/codebuilt` and `episode/engines/codebuilt` are the video pipeline. |
| `dashboard/client` | The dashboard pages: New Video, Library (videos, drafts), Voices, Insights (channel, growth). |
| `blender_worker/codebuilt` | The Blender kit the generated scene code imports. Mounted read-only into the job container. |
| `narrative_factory` | The voice service (Qwen3-TTS, word timings) and `codebuilt/post`, which turns frames into the final video. |
| `tools/codebuilt` | Sources of the job container images. |
| `paths/codebuilt.json` | The rules and skills the build model gets. |
| `data/` | Channel settings and logins, the voice model. Not in git. |
| `licenses/` | The register of every outside model, asset and library with its licence (see Rules). |
| `ForgeBrain/` | The shared notes of all agents. Its own git repository, not part of this one. |
| `output/agent-jobs` | One folder per video job. `output/drafts` holds the finished drafts. Not in git. |

## Rules

- A job may write only inside its own folder under `output/agent-jobs` (`dashboard/server/episode/codebuilt/jobPaths.js`).
- The YouTube API key is per channel, in the channel settings (`data/channels.json`). `.env` holds the other tokens.
- AI calls go through the Claude and agy command-line tools. No paid API keys.
- Nothing is used unless its licence allows monetized videos: `licenses/register.json`, checked by `python tools/license_check.py` before every commit.
- Tests: only for real damage (the job fence, music level, video length) and for bugs that actually happened.
