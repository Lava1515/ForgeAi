# Shorts pilot build plan, 2026-11-14

Owner order, 2026-11-14 about 15:25: make a plan, update the brain, launch the fleet to build what the YouTube
research decided. Written by claude-pro · claude-fable-5-2.

Evidence: `output/agent-jobs/youtube-research-2026-11-14/FINAL-REPORT.md` (sections 4.3, 6 and 9).
Decisions: `ForgeBrain/decisions/2026-11-14-owner-shorts-pilot-and-practice-channel.md` and
`ForgeBrain/memory/feedback_generic-pipeline-theme-on-the-fly.md`.

## Goal

The pipeline stays generic: it picks the theme on the fly. A channel carries its niche as a setting. The pilot
(20 map explainers, 20 silent physics loops, two fresh channels the owner creates) must be producible from the
dashboard without any niche written into pipeline code.

## Rules for every lane

- No niche in code. Words such as "map", "geography" or "physics" may appear only in a kit, a skill text, a
  channel profile or a test fixture, never as a branch in the pipeline.
- Project rules in `AGENTS.md` hold: licence gate before anything from outside, no paid API keys, a job writes
  only in its own folder, nothing is uploaded, no accounts are created.
- Do not touch `data/channels.json`, `.env`, `data/youtube_token.json` or the old channel.
- Work in your own worktree and branch. Commit there. Do not merge and do not push.
- Touch only the files your lane owns. If you must touch another lane's file, keep it to a few lines and name
  them in your report.
- Tests only for real damage and for bugs that happened. Run `npm test` in `dashboard/server` and
  `python tools/license_check.py` before you report.
- Scratch files go under `output/temp/<lane>` inside your worktree.
- Report: what changed (files), what you ran and its result, what is not done, and a `Brain note:` of up to
  3 lines.

## Shared contract (so lanes can work at the same time)

**Channel profile.** A channel in `data/channels.json` may carry:

```json
"profile": {
  "niche": "geography oddities, borders and country comparisons shown on a map",
  "format": "narrated",
  "language": "en",
  "avoid": ["current wars", "disputed borders"]
}
```

- `niche`: free text, up to 200 characters. When a video's theme is on Auto, the niche is the theme.
- `format`: `narrated` or `loop`. `loop` means the video type is `loop`.
- `language`: a BCP-47 code, default `en`. Used for the script and for the upload language fields.
- `avoid`: up to 10 short phrases. A premise that matches one is rejected.
- A channel without `profile` behaves exactly as today.

**Video types.** `factual`, `whatif`, and the new `loop` (silent, 6 to 20 seconds, the last frame meets the
first, no narration, no captions).

**Premise.** The topic pick returns, besides `topic`, a `premise` object
`{ title, hook, payoff, score, reasons }`. `title` is the premise in plain words, 6 to 10 words, a full question
or claim, no hashtag. It is saved in the job folder as `premise.json` together with the ranked and rejected
candidates, and the draft's `listing_copy.title` comes from it.

## Lanes

| Lane | What | Owns | Agent | Reviewer |
|---|---|---|---|---|
| A upload-metadata | Real titles and descriptions on upload | `dashboard/server/routes/youtube.js` | codex · gpt-6-luna | claude-pro · claude-sonnet-5-5 |
| B profile-premise | Channel profile, premise step with a gate | `routes/channelsManager.js`, `routes/channelsRoutes.js`, `episode/codebuilt/autoTopic.js`, `theme.js`, `draftAdapter.js`, `data/channels.example.json` | codex · gpt-6.1-sol | claude-pro · claude-sonnet-5-5 |
| C map-kit | Map kit from Natural Earth | new `blender_worker/codebuilt/maps.py`, `blender_worker/codebuilt/mapdata/`, new set `sets/world_map.py`, its entry in `sets/registry.py`, new skill `codebuilt-maps`, `licenses/register.json` | claude-pro · claude-sonnet-5-5 | codex · gpt-6.1-sol |
| D loop-format | The `loop` video type end to end | `episode/codebuilt/productionChoices.js`, `planner.js`, `start.js`, `voice.js`, `narrative_factory/codebuilt/post`, `narrative_factory/codebuilt/qa`, new `blender_worker/codebuilt/loops.py`, new skill `codebuilt-loops` | codex · gpt-6.1-sol | claude-pro · claude-sonnet-5-5 |
| E profile-ui | Profile fields in the channel dialog | `dashboard/client/src/components/ChannelModal.jsx`, `services/api.js` | agy · gemini-3.8-flash-high | codex · gpt-6-luna |

`paths/codebuilt.json` and the two existing skills `codebuilt-script` and `codebuilt-direction` are shared:
lanes C and D each add their own skill entry; lane B adds the premise rules below to the two skill texts.
The supervisor resolves any overlap at merge.

### A. Upload metadata

1. Title: the draft's listing title as it is. No ` #Shorts` suffix. Up to 100 characters.
2. Refuse the upload with a clear message when the title is empty, is only a date or digits in any script
   (the old channel got seven uploads titled with a date), or equals the draft id.
3. Description: first line is one sentence that says what the video shows; then the narration when there is
   one; then the AI notice; then at most five hashtags. Do not force the `shorts` tag.
4. Set `defaultLanguage` from the channel profile language (default `en`), and `defaultAudioLanguage` the same
   for narrated videos. For a `loop` video leave the audio language out.
5. Refuse a second upload of a draft that already has a YouTube video id, unless the request says `force`.
6. One test for the title rules (points 1 and 2): this is a bug that happened.

### B. Channel profile and premise gate

1. Validate, save and return `profile` in the channel settings (closed character set like `TEXT_CHOICE`,
   lengths as in the contract). Old channels without it keep working.
2. Topic pick: when the theme is on Auto and the channel has a niche, the niche is the theme. Ask for 12
   candidates instead of 6. For type `loop` the candidate shape is
   `{ topic, title, loop_idea (what moves and how the end meets the start), shots: 1 to 3, tags }` with no
   minimum of facts; the existing number and shot rules apply only to narrated types.
3. Premise rule in `theme.js` (report section 4.3): one concrete named thing with a stake; a full question or
   claim; title of 6 to 10 words; no list premise ("things that", "top 5"); a visual payoff is stated; no
   match with the channel's `avoid` list. Each fails or scores with a reason.
4. Variation: the existing repeat rule must also compare against the channel's last videos by subject and by
   title wording.
5. Return `premise` and write `premise.json` in the job folder (through the caller that owns the job folder;
   keep the job fence). `draftAdapter.js` takes `listing_copy.title` from `premise.title`, and
   `listing_copy.description` starts with the one-sentence answer.
6. Add to the skills `codebuilt-script` and `codebuilt-direction`: the subject and the premise text are on
   screen in the first frame, no logo or title card; end on the payoff and stop, or end where a loop can
   start; no call to action.

### C. Map kit

1. Licence first: Natural Earth is public domain. Check the terms at the source, record it in
   `licenses/register.json`, run the licence check, and only then download. Do not use GADM.
2. Convert the 1:110m and 1:50m country shapes to a compact data file under
   `blender_worker/codebuilt/mapdata/` (under 6 MB in total), with ISO codes, names, centroids and areas. Keep
   the conversion script.
3. `maps.py`: a flat world or region map as meshes; one country as its own mesh by ISO code or name;
   highlight, lift and colour a country; border lines; move a country onto another place at true size (project
   around its own centre so the size stays honest); a label; a camera move that flies to a country.
4. A set `world_map` in the registry with three angles, and a skill `codebuilt-maps` that tells the build model
   when and how to use the kit. Loaded by topic, like the other topic skills.
5. Borders: use Natural Earth's default boundaries as they are; the skill says to stay away from current wars
   and disputed borders.
6. Proof: render preview frames of three different scenes (world with one country highlighted, one country
   moved onto another continent, a zoom to a small country) into `output/temp/map-kit/` and look at them
   yourself. Name the frames in the report.

### D. Loop format

1. `loop` joins the video types. A loop job has no script, no voice, no captions and no narration fact check.
   Any number or text shown on screen must still be true.
2. Length 6 to 20 seconds. The scene is built so the frame after the last equals the first: periodic motion by
   construction, or a scene that returns to its start state. `loops.py` gives the helpers (periodic values,
   a cyclic camera, a baked simulation that is closed into a cycle).
3. A seam check in QA: compare the first frame with the frame after the last; fail above a threshold, with the
   number in the report.
4. Sound: only our own synthesized audio from `blender_worker/codebuilt/audio.py`, and it must loop too.
5. A skill `codebuilt-loops` for the build model: one clear subject, motion from frame 0, no text needed, what
   makes a loop satisfying (the report's lane 06 and lane 12 notes).
6. The narrated path must be unchanged: run the existing tests, and add one test that a `loop` job never asks
   for a voice.

### E. Profile fields in the dashboard

1. In the channel dialog: niche (text), format (narrated or loop), language, avoid list. Saved through the
   existing channel save call as `profile`.
2. Plain wording, no new page. Build with `npm run build` in `dashboard/client` and say whether it passed.

## After the lanes

1. Each lane is reviewed once by a different model, fixed, then merged to `main` by the supervisor, in the
   order A, B, E, C, D. Full `npm test` and the licence check after every merge.
2. The supervisor adds two channel entries without logins (`maps-pilot`, `loops-pilot`) with profiles, through
   the dashboard's own channel save.
3. Three videos of each format are made on the GPU through the dashboard, one after another. Nothing is
   uploaded. The owner watches them.
4. Owed by the owner: the two YouTube channels; the Studio numbers for 10 recent Shorts.

## Not in this plan

- Uploading, scheduling, creating accounts.
- The long version of a winning Short.
- Extra audio languages.
- The voice licence: `licenses/register.json` already lists Qwen3-TTS (Apache-2.0) as allowed. Whether a
  synthetic voice needs the YouTube disclosure box is a question for the upload step and is covered by the
  existing AI notice; it is asked again before the first upload.
