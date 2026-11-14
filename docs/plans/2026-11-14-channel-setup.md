# Setting up the two pilot channels, 2026-11-14

For the owner. Written by claude-pro · claude-fable-5-2. Sources: the research in
`ForgeBrain/research/youtube-shorts-2026-11-14` (mainly `02-money-policy-accounts-REPORT.md` and
`FINAL-REPORT.md` section 5). Where a point is a guess, it says so.

Agents never create accounts and never upload. Everything in parts 1 to 3 is done by the owner.

## The short answers

- **No new email is needed.** One Google login can own several YouTube channels. Each extra one is a "Brand
  Account" channel: its own name, handle, videos, subscribers and analytics.
- **It does not hurt the algorithm.** YouTube recommends per video and per viewer, and says there is no
  channel-level penalty. Two channels under one login do not share audience signals. (YouTube statements;
  nobody outside can measure this.)
- **What the channels do share is their fate.** If one channel is terminated, the owner may not keep or
  open any other. A separate email does not protect against this: the rule is about the person, and opening
  channels to get around a restriction is itself a violation. So the practice channel must stay clean too:
  no bursts, no duplicates.
- **One AdSense account** for all channels, later, when a channel qualifies. Never a second one.

## Part 1. Create each channel (about 10 minutes each)

1. Sign in to YouTube with the Google account you want to own the channels (the one that owns the practice
   channel is fine).
2. Profile picture, top right > **Settings** > **Account** > **Add or manage your channel(s)** >
   **Create a channel**.
3. Type the channel name (part 4 has suggestions) and confirm. This makes a Brand Account channel.
4. Switch to the new channel (profile picture > **Switch account**), then open **YouTube Studio**.
5. **Customization > Basic info**:
   - **Handle**: the name without spaces. If it is taken, add a short word, not digits.
   - **Description**: one or two plain sentences in English that say what the channel shows. Texts are in
     part 4.
   - **Channel URL / links / contact**: leave empty.
6. **Customization > Branding**: a simple picture and banner. Anything clean will do for the pilot; it can be
   replaced later.
7. **Settings > Channel > Basic info**:
   - **Country of residence**: your real country. Do not set another country to chase better-paying viewers;
     payment and tax details must match later.
   - **Keywords**: 5 to 8 words for the niche (part 4).
8. **Settings > Channel > Advanced settings**:
   - **Audience**: "No, set this channel as not made for kids".
9. **Settings > Upload defaults**:
   - **Video language**: English. **Category**: Education. **Visibility**: Private (the dashboard sets the
     real visibility when it uploads).
   - Description and tags: leave empty; the pipeline writes them per video.
10. **Settings > Channel > Feature eligibility**: do the phone verification (it unlocks custom thumbnails and
    longer uploads).
11. On the Google account itself: turn on **2-Step Verification** if it is not on. One lost login would cost
    every channel.

Not needed: a warm-up period, watching other videos first, posting at a special hour, a VPN. YouTube staff
deny all of these as levers.

## Part 2. Add the channel to ForgeAi (about 5 minutes each)

1. Dashboard > channel switcher > **Add channel**.
2. Fill in the name and the new fields:
   - **Niche**: what the channel is about (texts in part 4). Videos pick their theme inside it.
   - **Format**: Narrated.
   - **Language**: en.
   - **Avoid**: one phrase per line (texts in part 4).
3. Set the daily limit to **1**.
4. Press **Connect YouTube**. In Google's window, pick the **new channel**, not the practice channel. The
   dashboard shows the connected channel's name afterwards: check that it is the right one.

## Part 3. Posting rules for the pilot

- One video a day per channel at most. Never several within minutes.
- Never the same video twice, never a date as a title (the dashboard now refuses both).
- Have about 4 finished videos per channel before the first upload, so the first week does not depend on a
  good day of the pipeline.
- Watch every video before it goes out. Nothing is uploaded without you.
- After each 7 days, per video, from Studio: views, "Shown in feed", "Stayed to watch", average percentage
  viewed, subscribers, viewer countries.
- Stop rule from the research: after 20 uploads, if the typical Short is under 300 views and nothing passed
  10,000, change the kind of premise first, the niche second.

## Part 4. Names and texts

Owner's choices, 2026-11-14: the second channel is what-if videos; names in the "Forge" family, like
ForgeStudio; the practice channel stays without a niche.

A family name works when the second word says the niche, so a viewer and YouTube can tell the two channels
apart at a glance. The research advised against "AI" and "Studio" in the name (a guess, not measured): they
say who makes the videos, not what the videos are about.

### Channel 1: maps and borders

| Field | Value |
|---|---|
| Name (first choice) | **Forge Atlas** |
| Other names if the handle is taken | Forge Maps, ForgeBorders, Atlas Forge |
| Handle | @ForgeAtlas |
| Description | Strange borders, odd countries and true sizes, shown on a 3D map. One short explainer a day. |
| Keywords | maps, geography, borders, countries, explained, map facts |
| ForgeAi niche | Geography oddities, borders and country comparisons shown on a map |
| ForgeAi avoid (one per line) | current wars / disputed borders / territorial claims / religion / elections |

### Channel 2: what-if

| Field | Value |
|---|---|
| Name (first choice) | **Forge What If** |
| Other names if the handle is taken | What If Forge, ForgeIf, Forge Hypothetical |
| Handle | @ForgeWhatIf |
| Description | What if the Moon vanished? What if you fell through the Earth? Real physics, shown in 3D. One short a day. |
| Keywords | what if, physics, science, space, explained, hypothetical |
| ForgeAi niche | What-if questions about physics, space and the Earth, answered with real numbers |
| ForgeAi avoid (one per line) | real disasters with victims / medical advice / weapons |
| ForgeAi video type | set the type to What-if when starting videos for this channel |

### Practice channel

Unchanged: no niche, everything on Auto.

## How ForgeAi fits a video to a channel

- You choose the channel when you start a video (or the active channel is used).
- With topic and theme on Auto, the pipeline proposes 12 ideas **inside that channel's niche**, drops any that
  touch the avoid list or repeat a recent video of that channel, and builds the best one.
- The script is written in the channel's language; the title and description are written for that idea.
- The finished draft belongs to that channel and is uploaded with that channel's login.

Limit today: a finished draft cannot be moved to another channel. The channel is chosen before the video is
made, because the idea is picked to fit that channel.
