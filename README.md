# ForgeShorts

Code-built YouTube Shorts: a topic goes in, a model writes the script and the Blender scene code, the scene is
rendered in a locked-down container, and a draft video comes out. Nothing is published without the owner.

Started 2026-11-13 as a fresh copy of the code-built path of `C:\code\ForgeAi` (main `a3221a29`). ForgeAi is the
archive: every older video path (Studio, Episodes, kids, merch, any-story) stays there.

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
| `data/` | Channel settings and logins, voices, the voice model. Not in git. |
| `output/agent-jobs` | One folder per video job. `output/drafts` holds the finished drafts. Not in git. |

## Rules

- A job may write only inside its own folder under `output/agent-jobs` (`dashboard/server/episode/codebuilt/jobPaths.js`).
- The YouTube API key is per channel, in the channel settings (`data/channels.json`). `.env` holds the other tokens.
- AI calls go through the Claude and agy command-line tools. No paid API keys.
- Tests: only for real damage (the job fence, music level, video length) and for bugs that actually happened.
