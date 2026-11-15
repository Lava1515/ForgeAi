# Reading the numbers

Which numbers exist, where they come from, what each one tells.

Public numbers (YouTube Data API with the channel's API key; ForgeAi reads them on every scan and the watcher stores them over time):
- views, likes, comments per video; publish time; length.
- views_per_hour: views divided by hours since publish. Good for ranking videos of different ages, misleading for very young videos (the first hours are noisy).
- analytics_history: the stored views at 1, 2, 7 and 28 days after publish. Compare videos at the SAME age, never a 2-day-old video with a 30-day-old one.
- views_24h: views gained in the last 24 hours. A Short whose views_24h is near zero after day 3 has stopped spreading; it will almost never revive [CREATOR].

Private numbers (YouTube Analytics; need the channel owner's `yt-analytics.readonly` permission, not granted yet in ForgeAi):
- Shown in feed, stayed to watch against swiped away, average percentage viewed, average view duration, subscribers gained, viewer countries.
- How to read them: low "shown in feed" means YouTube could not tell who the video is for (topic signal, title, first frame). High "shown in feed" with low "stayed to watch" means viewers saw it and swiped (premise, first frame, first sentence).
- When these are missing, say "unavailable" and do not guess them from public numbers.

Benchmarks, all with their strength:
- Young channels in the niches measured have a typical Short at 200 to 9,000 views [DATA, research 2026-11-14]; the narrated map-explainer floor was 2,800 [DATA, small sample, found by search so too high].
- Shorts that spread: 70% or more stayed to watch; average viewed 70 to 80% for 50 to 60 s clips, over 100% for clips under 20 s [CREATOR].

Pilot rules (owner-approved research, 2026-11-14):
- Judge each video after 7 days on the same numbers.
- Reach: the typical Short passes 1,000 views.
- Stop rule: after 20 uploads in one format on one channel, if the typical Short is under 300 views and nothing passed 10,000, that format is not working there. Change the premise family first, the niche second.
- Decide between formats on the typical video, the best video and viewer countries together, never on one hit.

Typical, not average: use the median. One hit makes an average lie.
