# ForgeAi uploader

A small server with one page. It takes finished videos from a hand-over folder and puts them on YouTube at each
channel's slot times. It replaces auto release inside the dashboard (owner, 2026-11-20). No packages to install: Node 22 only.

Plan: `docs/plans/2026-11-20-uploader-service-plan.md`. Rule 6 of `CLAUDE.md`: an agent never sends a video to it,
never uploads and never changes its slots, limits or pause.

## Start

```
cd uploader
node --env-file-if-exists=../.env server/index.js
```

Page: `http://localhost:3100`.

| Setting (environment) | Default | Meaning |
|---|---|---|
| `UPLOADER_SHARE` | `output/uploader-share` | The hand-over folder. The dashboard must use the same path. Later: the NAS folder. |
| `UPLOADER_STATE` | `data/uploader` | Queue, YouTube sign-ins and the log. Back this folder up; never put it on the share. |
| `UPLOADER_PORT` | `3100` | |
| `UPLOADER_HOST` | `127.0.0.1` | Any other address needs `UPLOADER_UI_KEY` (16 characters or more); the page then asks for it as a password. |
| `UPLOADER_PUBLIC_HOSTS` | empty | Extra `name:port` values the page may be opened under. |
| `UPLOADER_AHEAD_HOURS` | `6` | How long before its slot a video is handed to YouTube (private, with YouTube's own schedule time). |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` | from `.env` | The same Google sign-in keys as the dashboard. |

## Once, in Google Cloud

Add `http://localhost:3100/api/youtube/callback` to the OAuth client's **Authorized redirect URIs**. Google returns
only to `localhost` or to a real https address, so "Connect a channel" is pressed in a browser on the uploader's own
machine.

## How it works

1. The dashboard's **Send to uploader** writes `inbox/<draft id>/` with `video.mp4`, `manifest.json` and, last, `READY`.
2. Each minute the uploader takes every package that has `READY`. It refuses: the same file twice, a title that is
   only a date, a made-for-kids flag, a damaged copy. A refusal is written to `results/<draft id>.json`.
3. For each connected, unpaused channel it gives the oldest waiting video the next free slot and uploads it private
   with that publish time. Never over the daily limit, never two in one slot, never closer than 4 hours.
4. The sign-in is checked against YouTube before every upload: a video is only ever uploaded to the channel named
   in its manifest.
5. After the slot it asks YouTube whether the video is public, then deletes its copy 7 days later.
6. A cut-off upload is never sent again by itself: it shows as failed with a Retry button.

Pause stops new hand-overs. A video already handed to YouTube still goes public at its time; use Cancel on it.

## Moving to another PC

Copy `uploader/` and the state folder, set `UPLOADER_SHARE` to the NAS folder on both machines, start it there, and
stop the old one. Two uploaders on one folder refuse to run together.

## Tests

`node --test tests/*.test.js`
