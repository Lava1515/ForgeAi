# Channels and publishing: the step by step guide (2026-11-20)

For the owner. Written by claude-pro · claude-fable-5-2, 2026-11-20 15:50 +02:00.
Replaces `docs/plans/2026-11-14-channel-setup.md` (same base, now checked against today's code, today's
YouTube rules and today's numbers of the practice channel).

Agents never create accounts, never upload and never switch auto release on. Every step here is yours.

## 0. What is true today

| Thing | State |
|---|---|
| ForgeAi channels | One: "ForgeAI (Primary)", connected to the YouTube channel **ForgeStudio** (the practice channel). Niche: map explainers. All four types ticked. Max 2 a day. Auto release off. |
| Google sign-in keys | `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` are in `.env`. No new Google Cloud project is needed for new channels. |
| New YouTube channels | None created yet. |
| Video types in the pipeline | Factual, What if, History, Teardown. |
| What the dashboard sends on upload | Title, description, tags, language, "not made for kids", the "altered or synthetic content" mark, and a visibility or a schedule time. Details in part 5. |

## 1. Which channels to open

| Channel | Open when | Types ticked in ForgeAi | Why |
|---|---|---|---|
| **Forge Atlas** (maps) | Now | Factual, History | Best measured breakout rate of the formats we build (research 2026-11-14). History told on a map fits here. |
| **Forge What If** | Now | What if | Your choice of 2026-11-14 for the second channel. |
| **Forge Teardown** | Later, when the teardown videos look good | Teardown | Different audience (machines, how it is built). Until then teardowns go to the practice channel. This is the last channel: the research says three at most, because one terminated channel takes all the others with it. |
| ForgeStudio (practice) | Exists | all | Stays as your test bench. Keep it clean too (see part 6). |

## 2. Create each YouTube channel (about 10 minutes each)

1. Sign in to YouTube with the Google account that owns ForgeStudio. No new email is needed.
2. Open your channel list: profile picture > **Settings** > **Account** > **Add or manage your channel(s)**
   (direct link: `youtube.com/channel_switcher`) > **Create a channel**. The label may differ a little;
   Google's help page only says "go to your channel list".
3. Type the name from part 4 and confirm. This makes a Brand Account channel under the same login.
4. Profile picture > **Switch account** > the new channel > **YouTube Studio**.
5. **Customization > Profile** (older name: Basic info):
   - **Handle**: from part 4. If taken, add a short word, not digits.
   - **Description**: from part 4.
   - Links and contact: leave empty.
   - Picture and banner: something simple and clean. It can be replaced later.
6. **Settings > Channel > Basic info**:
   - **Country of residence**: your real country. It does not change who sees the videos, and payment and tax
     details must match it later.
   - **Keywords**: from part 4.
7. **Settings > Channel > Advanced settings**:
   - **Audience**: "No, set this channel as not made for kids".
   - Copy the **Channel ID** shown here (starts with `UC`). You need it in part 3.
8. **Settings > Upload defaults**:
   - **Visibility**: Private. **Category**: Education. **Video language**: English.
   - Title, description, tags: leave empty. The pipeline writes them per video.
9. **Settings > Channel > Feature eligibility**: do the **phone verification** (intermediate features: custom
   thumbnails, videos over 15 minutes). The advanced step (ID or video check) is optional; it raises the daily
   upload limit, which we do not need at one video a day.
10. On the Google account: turn on **2-Step Verification** if it is off. One lost login loses every channel.

Not needed (YouTube staff deny all of these): a warm-up period, watching videos first, a special posting hour,
a VPN, `#Shorts` in the title.

## 3. Add each channel to ForgeAi (about 5 minutes each)

One check first, once, in Google Cloud Console (`console.cloud.google.com` > APIs & Services > OAuth consent
screen, also shown as Google Auth Platform > Audience): **Publishing status must be "In production"**. If it says
"Testing", every YouTube connection stops working 7 days after you connect. Press **Publish app** if needed.
At connect time Google may show "Google hasn't verified this app": press Advanced, then continue. That is normal
for a private tool.

Then, per channel:

1. Dashboard (`http://127.0.0.1:3000`) > channel switcher > **Add channel**.
2. General tab, fill in:

   | Field | Value |
   |---|---|
   | Use growth profile prompts | off |
   | Channel Name | the YouTube name (part 4) |
   | Channel Description / Focus | the description (part 4) |
   | Niche | part 4 |
   | Language | `en` |
   | Avoid | part 4, one phrase per line |
   | Video types for this channel | part 1 |
   | Auto release | **off**, no cap |
   | Max videos going public per day | **1** |
   | Made for Kids | **No** |
   | Genre | part 4 |

3. YouTube tab: paste the **YouTube Channel ID** from step 7 above. Leave the API key and the two OAuth
   override fields empty (the existing key and sign-in keys are used).
4. Save. In the channel switcher make the **new channel the active one**. This matters: Connect YouTube binds
   the sign-in to whichever ForgeAi channel is active.
5. Press **Connect YouTube**. In Google's window pick the **new channel** (not ForgeStudio, not your personal
   name) and allow access.
6. Open the channel's settings again and read "Bound YouTube Account". It must show the new channel's name.
   If it shows ForgeStudio, disconnect and connect again.

## 4. Names and texts per channel

### Forge Atlas

| Field | Value |
|---|---|
| Name | **Forge Atlas** (if taken: Forge Maps, Atlas Forge) |
| Handle | `@ForgeAtlas` |
| YouTube description | Strange borders, odd countries and true sizes, shown on a 3D map. One short explainer a day. |
| YouTube keywords | maps, geography, borders, countries, map facts, explained |
| ForgeAi niche | Geography oddities, borders and country comparisons shown on a map |
| ForgeAi avoid | current wars / disputed borders / territorial claims / religion / elections |
| ForgeAi genre | custom: `geography and maps` |
| Types | Factual, History |

### Forge What If

| Field | Value |
|---|---|
| Name | **Forge What If** (if taken: What If Forge, Forge Hypothetical) |
| Handle | `@ForgeWhatIf` |
| YouTube description | What if the Moon vanished? What if you fell through the Earth? Real physics, shown in 3D. One short a day. |
| YouTube keywords | what if, physics, science, space, hypothetical, explained |
| ForgeAi niche | What-if questions about physics, space and the Earth, answered with real numbers |
| ForgeAi avoid | real disasters with victims / medical advice / weapons |
| ForgeAi genre | Science & Anomalies |
| Types | What if |

### Forge Teardown (later)

| Field | Value |
|---|---|
| Name | **Forge Teardown** (if taken: Forge Cutaway, Inside Forge) |
| Handle | `@ForgeTeardown` |
| YouTube description | Machines taken apart in 3D: what each part does and why it is built that way. One short a day. |
| YouTube keywords | how it works, engineering, teardown, cutaway, machines, explained |
| ForgeAi niche | How machines and structures work, shown by taking them apart in 3D |
| ForgeAi avoid | weapon building instructions / medical advice / current wars |
| ForgeAi genre | Tech & Computers |
| Types | Teardown |

## 5. Each video: title, description, tags

The pipeline writes all three when the draft is made. You check them in the **Publish** box and can edit the
title and the tags there.

### What the dashboard sends without asking

| Field | Value sent | Note |
|---|---|---|
| Description | one-sentence summary, then the full narration, then the AI line, then up to 5 hashtags | built in `routes/youtube.js` `buildSnippet` |
| AI line | "(Visual simulation and narration created with the assistance of 3D modeling and AI.)" | |
| Altered or synthetic content | **Yes**, on every code-built video | Correct: the music is now made by an AI model (ACE-Step), and YouTube lists AI music as needing the mark. YouTube says the mark alone does not cut reach or pay. |
| Made for kids | No (the tick box in the Publish box, leave it empty) | |
| Language | the channel's language (`en`) for text and audio | |
| Category | **Entertainment** (id 24), fixed in code | Should be Education. See "Two small faults" below. |

### Title (you check it)

- One concrete subject and its premise, as a question or a claim: "Why This Town Has Twenty Borders".
- 40 to 70 characters, the subject near the front. Hard limit 100.
- A what-if says so: "What if Earth stopped spinning for 5 seconds?"
- No `#Shorts`, no hashtags, no emoji, no all-caps, no "you won't believe".
- Not the same pattern every time. Many of ours start with "Why" or "How": vary it ("The town with twenty
  borders", "No bridge crosses the Amazon. Here is why"). A channel where every title has one shape is what
  YouTube's "mass-produced" rule looks for.
- Never a date as the title (the dashboard refuses it).

### Tags (press "Suggest tags", then check)

- 8 to 12, lowercase, no `#`, no spaces inside a tag.
- Half name the exact subject, a few the wider topic, two or three broad words.
- Never: fyp, viral, foryou, shorts, trending.
- The first 5 tags also become the hashtags in the description. YouTube shows up to 3 of them above the title.
- YouTube itself says tags "play a minimal role". Do not spend time here; the title and the first seconds matter.

| Channel | Example title | Example tags |
|---|---|---|
| Forge Atlas | Why This Town Has Twenty Borders | baarle, baarlenassau, belgium, netherlands, enclave, borders, geography, maps, mapfacts, countries |
| Forge What If | What if Earth stopped spinning for 5 seconds? | earthrotation, earth, inertia, whatif, physics, space, science, hypothetical |
| Forge Teardown | Why Stealth Jets Bend Engine Intakes Into an S-Curve | stealthjet, f22, engineintake, radar, howitworks, engineering, aviation, teardown |

### In the Publish box

1. **Visibility**: Public. Or set **Publish at** to schedule (the video goes up private and YouTube makes it
   public at that time).
2. Check the **Title**.
3. **Suggest tags**, check them.
4. **Made for kids**: leave unticked.
5. **Publish**.
6. After the first upload on each new channel, open the video in YouTube Studio once and confirm: right channel,
   "not made for kids", altered content marked, shown as a Short.

## 6. Posting rules

- **One video a day per channel.** Never several within minutes. The practice channel still gets 4 to 6 uploads
  inside one minute (2026-11-14 22:25, 11-15 05:49, 11-15 23:19, 11-16 13:52). That pattern is what the spam
  rule describes, and a strike there counts against every channel.
- Have about 4 finished videos per channel before the first upload.
- Watch every video before it goes out.
- Each video must differ from the last in subject, structure and title.
- Never the same video twice.
- Stop rule: after 20 uploads on a channel, if the typical Short is under 300 views and nothing passed 10,000,
  change the kind of premise first, the niche second.

## 7. What to watch after publishing

**The most useful thing you can do today, 10 minutes, on the practice channel.** New numbers from this morning's
scan: of the 32 Shorts since 2026-11-12, 22 landed between 900 and 1,500 views and then stopped (0 to 5 views in
the last 24 hours). Maps, what-ifs, teardowns and engineering all stop at the same height. So the feed gives each
video about 1,000 test plays and does not continue. The research called this the free test for a new channel.
What decides whether a video goes past it is "stayed to watch" against "swiped away", and only you can read that:

YouTube Studio > Analytics > advanced mode, for 10 of those videos: **Shown in feed**, **Stayed to watch**,
**Average percentage viewed**, **viewer countries**. Send me the numbers (a screenshot is fine).

- Stayed to watch near 70% or more: the videos hold people; the topic match or the volume is the limit.
- Well under that: the first seconds lose people, and that is what the pipeline must fix before new channels matter.

After the new channels run: the same four numbers per video after 7 days. The Growth page shows views at 1, 2
and 7 days by itself.

## 8. Money, in short (checked again today)

- From **2027-02-01**: joining the Partner Program needs 1,000 subscribers plus **20M Shorts views in 90 days**
  or **8,000 watch hours in a year**. Earning from Shorts ads needs **10M Shorts views in the last 90 days**,
  checked every month.
- So Shorts are for finding an audience. Money comes later from longer videos on the topics that win.
- One AdSense account for all channels. Never a second one.
- AI is allowed. "Mass-produced, template" content is not, and YouTube reviews the whole channel: titles,
  descriptions and the About text included.

## 9. Research: what I checked again today, and what a full redo would be

| Point | Result today |
|---|---|
| Partner Program change on 2027-02-01 | Confirmed (YouTube blog of 2026-08-10 and press). |
| Videos uploaded by our own tool are locked private | **Not true any more.** Google's API page now says uploads from unverified projects are not restricted. Our own public uploads show the same. |
| Upload limit of the tool | 100 uploads a day per Google Cloud project. Far above our need. |
| Connection dying after 7 days | True only while the Google sign-in screen is in "Testing". See part 3. |
| AI mark | Required for realistic AI content and for **AI music**. Since May 2026 YouTube also adds the mark itself when it detects realistic AI video. The mark alone does not cut reach (YouTube's statement). |
| Hashtags and tags | Up to 3 hashtags show above the title; over 60 and all are ignored; tags "play a minimal role". Nothing official says `#shorts` is needed. |
| "Inauthentic content" rule | Clarified July 2026: template content, off-putting content, AI personas on health, money or law. AI use by itself is not the trigger. |
| Shorts length | Up to 3 minutes. |
| Our own channel | New: about 1,000 to 1,500 views per Short since 2026-11-14, then a stop (part 7). On 2026-11-14 the typical recent Short had 44. |

Not redone today: the niche ranking (which formats break out for young channels). That was a 12-lane fleet job
using about 7,700 of the day's 10,000 YouTube API units. I would not repeat it before the Studio check in part 7:
our own numbers now say all our types stop at the same place, so the next question is why viewers leave, not
which niche.

## Two small faults found in the code (not changed)

1. Every upload is sent as category **Entertainment** (`categoryId: '24'` in `dashboard/server/routes/youtube.js`).
   Education (27) fits these channels. One line; it touches publishing, so it waits for your yes.
2. The Publish box says "#shorts is always added". The code does not add it (which is right). The sentence is stale.

## Sources

- Our research: `ForgeBrain/research/youtube-shorts-2026-11-14/` (FINAL-REPORT and lane 02), `ForgeBrain/research/trend-review-2026-11-16/REPORT.md`.
- Code read today: `dashboard/server/routes/youtube.js`, `routes/channelsManager.js`, `client/src/components/ChannelModal.jsx`, `PublishYouTube.jsx`, `data/trends/channel.json` (scan of 2026-11-20 11:05 UTC).
- YouTube blog, Partner Program 2027: https://blog.youtube/news-and-events/youtube-partner-program-updates-2027-new-opportunities-earn/
- Search Engine Journal on the same: https://www.searchenginejournal.com/youtube-updates-partner-program-terms-shorts-payout-rules/585331/
- API upload page: https://developers.google.com/youtube/v3/docs/videos/insert and https://developers.google.com/youtube/v3/determine_quota_cost
- Google sign-in "Testing" status: https://support.google.com/cloud/answer/15549945
- AI disclosure: https://support.google.com/youtube/answer/14328491
- Hashtags: https://support.google.com/youtube/answer/6390658 ; tags: https://support.google.com/youtube/answer/146402
- Verification and features: https://support.google.com/youtube/answer/171664 , https://support.google.com/youtube/answer/9891124
- Create and manage channels: https://support.google.com/youtube/answer/1646861 , https://support.google.com/youtube/answer/4642409
- Inauthentic content update: https://www.tubefilter.com/2026/07/13/youtube-inauthentic-content-monetization-policy-update/
- Shorts length: https://support.google.com/youtube/answer/10059070
