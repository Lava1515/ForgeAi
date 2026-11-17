---
name: codebuilt-journey
description: Plan a factual short around one visible move, a running number, and a scale-flipping ending.
---

# Codebuilt journey format

Use this format only when the job carries the `journey` format. The topic may be anything that can be shown with one continuous move; do not assume a niche.

## Choose the picture first

- Name one physical thing the viewer can recognize in the opening second.
- Follow one visible move through most of the video. It may continue for 14 seconds without a cut.
- Put a running number on screen from the first seconds. It measures the move and only moves one way.
- End with a number that flips the scale: a large thing feels tiny, or a tiny thing feels huge.
- Change the picture within 3 seconds. Make it work on mute. Use two to four comparisons as labels along the move. Return to the opening in the last frame when that makes a natural loop.
- Use one to three scenes. Keep the same physical thing visible as the move continues.

## Script and evidence

- Write 60 to 75 words for a 27 second video. At least half of the sentences must have five words or fewer.
- Build the script around the opening hook, the move and its landmarks, then the final number. No call to action.
- Spell numbers the way the voice reads them most cleanly. Prefer “one hundred sixteen” to “a hundred and sixteen”; the latter stretched to seven seconds in a hand-made test.
- The topic premise must name the thing and move, three or four landmarks with a number and direct source link for each, what the counter counts and its unit, and the last number. If a premise is missing any of those, reject it and try the next.
- Also require a story: `story_question` is raised in the first two script sentences and `ending_answer` answers it in the final line; `turn` is a stop, failure, or surprise written as its own line of at most eight words; `who` names the person or group and `want` says what they wanted to do. Reject a missing field or a turn line longer than eight words. A row of size comparisons alone is not enough.
- Check every spoken and displayed fact at its primary source. Keep the links beside their numbers. Use careful rounded values when authoritative sources differ.

## Direction and build

- Direct one continuous move. The move may run 14 seconds without a cut. Slow the camera at each landmark so its label can be read; do not cut simply to change the view.
- Put no text in 3D. Mark screen anchors for the thing and landmarks, and list every displayed word and number in `overlay.json`. The counter starts at t = 0 and is monotone.
- Make surfaces for the specific shot. Avoid plain grey; use visible material variation with patterns large enough to read on a phone.
- Build repeated forms once and copy them. Adding thousands of objects one by one made a hand-made build take minutes; prepare and reuse the shape.
- Use one to three scenes and no more than three places. A journey may use one long shot up to 16 seconds. Keep the action visible and the subject large enough to follow.
- Put labels on the narration word that names their landmark. Leave enough time at each stop to read them.

## Lessons from the three hand-made videos

- Keep the counter inside the safe area from frame zero. Hide or move it when it collides with the payoff.
- Do not draw an anchor label when its point is behind the camera or off screen. Check every test sheet at phone size for collisions, clipping and whether the subject remains visible.
- Check the opening, midpoint, every comparison and the ending. Watch for haze that erases the subject, burned highlights, surfaces that read as the wrong object, and a final shot that does not return to the first when a loop was intended.
- Build shared meshes from prepared geometry instead of creating thousands of objects one at a time.
- A short hand-made test missed the 60-word floor at 53 words; count the finished script. Another test found labels colliding with the counter, and moved the counter from the top edge and delayed a ruler until the camera had settled.

## Story examples

The Kola short's 65-word script is a positive example because it starts with a hidden thing and a question of scale, follows one fall, gives the drillers' goal a complication, then answers with a final fraction:

> This rusty lid hides the deepest hole humans ever dug. Nine inches wide. Straight down. Past the deepest mine on Earth. Past Mount Everest, flipped upside down. Past the bottom of the ocean. Twelve kilometers down, the rock hit a hundred and eighty degrees. Too hot to drill. Nineteen years of work. Zero point two percent of the way to the center of the Earth.

Name the actor in the premise (`who`: Soviet drillers; `want`: reach deeper rock) so the script's goal is explicit. The turn has its own short line: “Too hot to drill.” The ending answers the scale question with the 0.2% figure.

Use this comparison-only script as a negative example:

> This is Earth. Nearly thirteen thousand kilometers wide. Everyone you have met lives on it. Neptune is almost four times wider. Jupiter, eleven times. Then the Sun. A hundred and nine Earths, side by side. Hollow it out, and over a million Earths fit inside. Find Earth. There. Everything you have ever known.

It has vivid measurements and a scale flip, but no one is trying to do anything and nothing stops, fails, or surprises. Do not copy that structure by simply lining up comparisons.
