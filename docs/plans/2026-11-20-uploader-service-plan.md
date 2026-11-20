# Uploader: a small separate server and UI that publishes ForgeAi's videos (plan, 2026-11-20)

Written by claude-pro · claude-fable-5-2, 2026-11-20 16:05 +02:00. Owner's order of about 16:00:
`ForgeBrain/decisions/2026-11-20-owner-separate-uploader-on-vm.md`. Nothing is built. Lines marked OPEN wait
for the owner.

## 1. What the owner asked for

- Automatic uploads do not live in ForgeAi. A small server with its own UI runs on a VM.
- ForgeAi sends each finished video there. The uploader puts it on YouTube.
- Two uploads a day at fixed hours (owner's first idea: 07:00 and 17:00, "fix the hours if I am wrong").
- The uploader knows which channel each video belongs to, so ForgeAi's flow must carry the channel.

## 2. The shape

```
ForgeAi (this PC)                          Uploader (VM)
  video finished -> draft                    receives package, checks it
  owner presses "Send to uploader"  ---->    queue per channel
  package = video + manifest                 at each slot: next video of that channel -> YouTube
  shows the status it gets back     <----    result: YouTube id, time, or the error
```

- **ForgeAi decides what the video is.** It builds the title, description, tags, language, the made-for-kids
  answer and the AI mark, exactly as the Publish box does today, and writes them into the manifest.
- **The uploader decides when.** It holds the YouTube sign-ins, the slots and the daily limit. It changes
  nothing in the text; it uploads what it was given, or refuses.
- **Code lives in this repo**, folder `uploader/`, with its own `package.json` and its own container. ForgeAi
  is the one place for everything (owner, 2026-11-14); only the running copy is on the VM.

## 3. What already exists in ForgeAi

| Need | State |
|---|---|
| A draft knows its channel | Yes: `channel_id` in the draft's `metadata.json`, set when the video starts. |
| A channel knows its types | Yes: "Video types for this channel" in the channel dialog. |
| Title, description, tags per video | Yes: `buildSnippet` in `dashboard/server/routes/youtube.js`. |
| The new channels in ForgeAi | **No.** Only "ForgeAI (Primary)" exists. Parts 2 and 3 of `2026-11-20-channels-and-publishing-guide.md`. |
| The channel's YouTube id on the channel | Field exists ("YouTube Channel ID"); must be filled for every channel, because the uploader matches on it. |
| Auto release inside ForgeAi (P2) | Built, off. This plan replaces it: it stays off and is removed once the uploader is proven. |

## 4. The package ForgeAi sends

One folder per video: `video.mp4` and `manifest.json`.

```json
{
  "package_id": "<draft id>",
  "sha256": "<of video.mp4>",
  "youtube_channel_id": "UC...",
  "forgeai_channel_id": "ch_...",
  "video_type": "whatif",
  "title": "...", "description": "...", "tags": ["..."],
  "language": "en", "category_id": "27",
  "made_for_kids": false, "contains_synthetic_media": true,
  "checks": { "fact_check": true, "length": true, "visual": true },
  "created_at": "..."
}
```

Sent with `POST /api/packages` on the uploader, with a shared key in a header (`UPLOADER_KEY` in `.env` on both
sides; the value is never written into a note or a log). Sending the same package twice changes nothing.

## 5. The uploader

**Refuses a package when:** the video's hash is already known (same video twice), the title is a date or empty,
`youtube_channel_id` has no sign-in on the uploader, the sign-in belongs to another channel than the manifest
says, or `made_for_kids` is true.

**Slots.** Each channel has its own slot times and its own daily limit. At a slot the oldest waiting video of
that channel goes out. An empty queue means the slot is skipped; nothing is doubled up later. The uploader sends
the video to YouTube up to a day early as private with YouTube's own schedule time, so a VM that is off at the
slot does not miss it.

**Limits it cannot go over:** the channel's daily limit, one video per slot, never two videos of one channel
closer than 4 hours.

**UI (one page):** per channel the queue with the next slot times; pause per channel and pause everything;
remove a video from the queue; move a video up or down; history with the YouTube link; errors in plain words;
"Connect YouTube" per channel.

**Back to ForgeAi:** ForgeAi asks the uploader for the state of its packages and writes the YouTube id and the
publish time into the draft, so the Growth page keeps working.

## 6. Hours

Advice, low confidence: YouTube's staff say posting time is not a lever. What our own numbers show is that each
Short gets its test plays in the first 6 to 40 hours, so it is safer when the English-speaking viewers are awake
at the start.

| Slot (your time, +02:00) | New York | London | Verdict |
|---|---|---|---|
| 07:00 | 00:00 | 05:00 | viewers asleep: move it |
| 17:00 | 10:00 | 15:00 | good |
| **15:00** | 08:00 | 13:00 | proposed first slot |
| **21:00** | 14:00 | 19:00 | proposed second slot |

Proposed: **15:00 and 21:00**. OPEN: 2 a day in total (one per channel: Forge Atlas 15:00, Forge What If 21:00)
or 2 a day on each channel. My advice is one per channel a day at the start: the channels that broke out in the
research posted about 0.9 a day, and four videos a day is more than you can watch before they go out.

## 7. Safety and rules

- The VM is reached only on a private network (the PC's own virtual switch, the home network or a private
  tunnel). It is never opened to the internet. Every call needs the shared key; the UI too.
- The YouTube sign-ins live only on the VM, in a file readable by the uploader alone, and are backed up with
  the queue.
- Google's sign-in window returns only to `localhost` or to a real https address. So "Connect YouTube" is done
  in a browser on the VM itself, or through a tunnel that makes the VM's port look like localhost.
- **CLAUDE.md rule 6 must change, by the owner.** Today it says a video goes out only through the dashboard's
  Publish button or auto release. Proposed text: "A video goes out only through the uploader. An agent never
  sends a video to it, never uploads and never changes its slots, limits or pause."
- OPEN: who sends a video to the uploader. Proposed start: you press **Send to uploader** on each draft after
  watching it (it replaces Publish). Later, a per-channel switch "send by itself when all checks passed", off
  until you turn it on.
- OPEN: the Publish button in ForgeAi. Proposed: keep it for the practice channel until the uploader has run
  two clean weeks, then remove it.

## 8. Build lanes

| Id | Lane | Files | Done when |
|---|---|---|---|
| U1 | Package builder | new `dashboard/server/publish/package.js`, reuse `buildSnippet`; category 27 | a draft becomes `video.mp4` + `manifest.json`; refuses a draft with no channel YouTube id |
| U2 | Uploader server | `uploader/server/**` | receive, refuse rules, queue, slots, YouTube upload with schedule, state file, log of every decision |
| U3 | Uploader UI | `uploader/client/**` | the one page of part 5 |
| U4 | ForgeAi side | `PublishYouTube.jsx`, a small route, draft status | "Send to uploader" button, status shown on the draft, YouTube id written back |
| U5 | Run on the VM | `uploader/Dockerfile`, `uploader/README.md` | one command starts it; restart keeps queue and sign-ins; backup of the state folder |
| U6 | Review | | security review by another model family: key check, wrong-channel check, limits, what a stolen key could do |
| U7 | Proof | | 4 packages to the practice channel as **private** uploads at test slots; then the first real slot with you watching |

U2 and U3 touch only new files, so they can be built while videos run. U1 and U4 touch dashboard code and merge
at zero jobs. P2 (auto release in ForgeAi) is removed in a last lane after U7.

Tests, only for real damage: over the daily limit, the same video twice, the wrong channel, an upload while paused.

## 9. Owner answers, 2026-11-20 16:05 +02:00

1. **Where it runs:** on this PC first; in the end on another PC in the home network.
2. **How many:** 2 a day on each channel.
3. **Who sends:** the owner, with a "Send to uploader" button on each draft.
4. **Hours:** the owner asked whether 13:00 and 21:00 is best. My answer: keep 15:00 and 21:00 (13:00 is 06:00
   in New York), and stagger the channels so two uploads never land in the same minute:
   Forge Atlas 15:00 and 21:00, Forge What If 16:00 and 22:00. Nobody can call an hour "best"; the uploader
   records the slot of every video, so after about 3 weeks the views per slot show whether to move one.
5. **The NAS as the hand-over (owner's idea): yes, it replaces part 4's `POST`.** These lines win over parts
   2, 4, 5 and 7 where they differ.

### Hand-over through a NAS folder

```
<share>/forge-uploader/
  inbox/<package_id>/   video.mp4, manifest.json, READY   (ForgeAi writes; READY last)
  taken/<package_id>/   the uploader moved it here and owns it
  results/<package_id>.json   state, YouTube id, publish time or the error (the uploader writes; ForgeAi reads)
```

- ForgeAi copies the video and the manifest, then writes an empty file `READY`. The uploader touches nothing
  without `READY`, so a half-copied video is never picked up. It then checks the hash from the manifest.
- No network call between the two programs and no shared key. Either side can be off; the other keeps working.
  This is why it is better: the uploader PC can publish while this PC is shut down.
- The uploader keeps a video until YouTube reports it public and processed, then 7 more days, then deletes
  the copy on the NAS. The draft in ForgeAi stays.
- While both run on this PC, the "share" is a plain local folder (`output/uploader-share`). Moving to the LAN
  PC is then one path setting on each side.
- The folder path is a setting, `UPLOADER_SHARE` in `.env`. A NAS path is outside `C:/code`; that is the
  owner's own exception to the stay-inside rule, for this folder only.
- Risks to cover: the share not mounted (ForgeAi says "uploader folder not reachable" and sends nothing; the
  uploader pauses and shows it), and two uploaders on one share (a lock file; the second one refuses to start).

### What two a day per channel means

Four videos a day to make and to watch once both channels run, six with a third. The pipeline needs about
38 minutes a video, so the making fits; the watching is yours. An empty queue skips its slot.

## 10. Built, 2026-11-20 evening (main 1735b4e)

Merged after four Codex review rounds. What changed against the plan above, because of the reviews:

- Every package and every answer is signed with one key that never lies on the share (`data/uploader/handover.key`, made by itself).
- The uploader copies an accepted video into its own state folder and uploads from that copy. The share holds only `inbox/`, `claimed/` and `results/`; there is no `taken/` or `refused/`.
- A send is taken once. An upload cut off mid-way is never sent again by itself and keeps its slot until the owner chooses "It is on YouTube" or "Retry".
- Slots default to 15:00 and 21:00 on every channel (no hour apart); change them per channel on the uploader page.
- The uploader hands a video to YouTube up to 6 hours before its slot, not 24.
- How to run it and how to move it to another PC: `uploader/README.md`.

Not proved by a real upload yet.
