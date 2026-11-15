# Consolidated Evidence Report: R2 Shorts Endings Research & Missing Transcript Audit

- **Document Type**: Research Consolidation & Evidence Synthesis
- **Date**: 2026-11-15
- **Author**: agy · gemini-3.8-flash-high
- **Branch**: `t3/r2-ending-evidence`
- **Worktree**: `C:/Users/Lava/.t3/worktrees/ForgeAi/t3-4c975cd4`
- **Scope**: Comprehensive consolidation of R2 research shards (r2-1 through r2-10) and companion audit artifacts across local worktrees under `C:/Users/Lava/.t3/worktrees/ForgeAi/*/output/agent-jobs/`.
- **Operating Constraints**: Strictly read-only local evidence consolidation; zero external downloading or network scraping; strict monetization licence gate compliance (`CLAUDE.md` Rule 1); zero edits to main, ForgeBrain, or foreign worktree branches.

---

## 1. Executive Summary & Core Methodological Verdicts

### 1.1 Complete Absence of External Acoustic Metrics
- **Strict Compliance with Licence Gate**: An inspection of all 35 candidate Shorts sampled in the research cohort confirms that every single video carries `license: None` (Standard YouTube License) with all rights reserved. No creator granted Creative Commons (CC-BY), public domain, or commercial reuse rights at source.
- **Enforcement of `CLAUDE.md` Rule 1**: In strict adherence to project rules, no external audio streams (`.mp3`, `.m4a`, `.wav`, `.mp4`) were downloaded or ingested into the repository.
- **Zero External Pitch/Energy Telemetry**: Because zero external audio files were retrieved, **no external acoustic fundamental frequency ($F_0$ in Hz) or root-mean-square energy (RMS in dB) was measured, extracted, or estimated**.
- **Negative Finding on Caption Inference**: Caption events and subtitle timestamps do not represent acoustic waveforms. A caption end timestamp (e.g., subtitles ending at 64.24 s) indicates only the end of transcribed text display; it does **not** prove a visual cut or the end of vocal energy. Furthermore, shouted tokens, exclamation points, or uppercase transcription tags (e.g., `>> [screaming]`, `KILL THAT BOY!`) are orthographic cues added by transcriptionists, not acoustic proof of elevated decibels or rising pitch.

### 1.2 Shard 10 Local Narration Metrics: Provisional Descriptive Signal, Not Causal Sadness
- **Local Measurement Provenance**: Shard 10 (`r2-10`, worktree `t3-fad60bda`) evaluated an internal generated synthesis track (`output/episodes/cb-mwhwm4io-294b04/voice.wav`, 37.088 s, voice `aiden`) using `librosa.pyin` and RMS power. It reported an apparent 60.5% drop in RMS energy and a -34.2 Hz drop in pitch over the final 2.0 seconds.
- **Audit Findings (`r2-acoustic-review`, `t3-67b94a8f`)**:
  1. *Silence Confound*: The final 2.0 wall-clock seconds [35.088 s, 37.088 s] contain **0.989 s of post-speech silence** following the final spoken word (*"circumference."* at 36.099 s). Half of the analyzed window was dead air, heavily depressing the wall-clock RMS calculation.
  2. *True Spoken Window*: Evaluating the actual last 2.0 spoken seconds [34.099 s, 36.099 s] reveals an RMS amplitude of 0.0784 (a 38.1% decline relative to the preceding track, not 60.5%).
  3. *Prosodic vs. Affective Trajectory*: The -34.2 Hz drop in mean pitch reflects standard phonetic declination at declarative sentence boundaries. It serves as a descriptive observation within a single synthetic sample, but does **not** scientifically prove listener perception of "sadness", lethargy, or unentertaining narration.

### 1.3 Baseline Calm-Close Causation: UNSUPPORTED by Code Architecture
- **Refutation of Prior Claim**: Previous planning documents asserted that ForgeAi drafts sounded flat or trail off because the engine explicitly executed the "calm, thoughtful close" directive from `story_tone.py`'s `THEMED_ARCS["default"]` on every draft.
- **Architectural Reality (Audited via E1b & `r2-method-review`)**:
  - `dashboard/server/episode/voice.js` posts to `/api/tts-timed` omitting the `deliveries` parameter entirely.
  - In `narrative_factory/tts_engine.py` (line 357), `compute_story_arc_tones` is invoked with `directions=flat_dirs`.
  - Because `deliveries` is omitted, `tts_engine.py` constructs `flat_dirs` as a list of `None` values (one per sentence).
  - In `narrative_factory/story_tone.py` (line 273), the condition `has_explicit = (directions is not None) or any(inline_tags)` evaluates to **TRUE** whenever `directions` is passed as a list, even if all elements are `None`.
  - Consequently, `candidates` are populated as empty strings `["", "", ...]`, which `normalize_deliveries` returns as all empty strings.
  - Every sentence is mapped to `narrator("")`, which applies the static baseline narrator instruction (`NARRATOR`) across the entire script.
  - **Verdict**: The fallback story arc in `THEMED_ARCS["default"]` (containing "calm, thoughtful close") was **never reached** on the code-built path. The baseline was flat because the pipeline sent zero delivery directives, leaving all sentences in the uniform baseline narrator, not because "calm, thoughtful close" was executed. Future documentation must **not** repeat the old causation claim.

### 1.4 Narrative Grammar of Winning Endings (Paraphrased Evidence)
Across the analyzed top Shorts, high retention and punchy endings are achieved through structural story craft:
1. **Open-Loop Hook Promise**: The hook introduces an intriguing paradox, challenge, or explicit ranking promise (e.g., promising that the final item will be shocking).
2. **Delayed Payoff / Climax Preservation**: The core revelation, physical consequence, or punchline is held strictly until the final sentence or terminal syllable, rather than expended mid-script.
3. **Keyword & Image Callback**: The final phrase echoes the specific contractual premise or imagery established in the opening hook, providing satisfying closure.
4. **Immediate Punch Cut**: The video terminates immediately on the punchline with zero explanatory coda, summary triplet, philosophical lesson, or subscription request.

---

## 2. Canonical Manifest of the 18 Missing Transcripts (`miss.txt`)

The 18 missing transcripts were recorded in `output/temp/endings-research/miss.txt` after hitting YouTube HTTP 429 rate limits during initial sampling. Below is the canonical **1-based index** manifest, mapped against retrieval outcomes across shards:

| Canonical 1-Based # | Video ID | Channel | Views | Dur (s) | Title | Retrieval Outcome | Reporting Shards & Provenance |
|---|---|---|---|---|---|---|---|
| **1** | `8U9--bBl7XY` | Kaddu3d | 49,553,653 | 33 | Win Every Tic Tac Toe Game (3D Animation) | **Failed (HTTP 429)** | Shard 1 (`r2-1`) assigned 1-based index 1. |
| **2** | `_nz3g-3SAHQ` | Kaddu3d | 5,970,507 | 31 | Win Chess in JUST 6 Moves! (3D Animation) | **Failed (HTTP 429)** | Shard 1 (`r2-1` 0-based ref); Shard 2 (`r2-2` 1-based ref). |
| **3** | `ApqMluy83Hk` | Kaddu3d | 77,968 | 28 | How the Internet Really Works (3D Animation) | **Failed (HTTP 429)** | Shard 2 (`r2-2` 0-based ref); Shard 3 (`r2-3` 1-based ref). |
| **4** | `RWFC4aucOoY` | Kaddu3d | 54,879 | 26 | Can BrahMos Missile Reach the Space Station? | **Failed (HTTP 429)** | Shard 3 (`r2-3` 0-based ref). Shard 4 report pending. |
| **5** | `a0fMTaxnuXw` | AI HISTORY | 2,770,563 | 71 | He Boiled Fruit Peels... The Smell Stopped Everyone | **Failed (HTTP 429)** | Shard 5 (`r2-5`) assigned 1-based index 5. |
| **6** | `BQl2yAr6GdI` | AI HISTORY | 2,551,880 | 78 | He Left Grain in Water... It Changed on Its Own | **Failed (HTTP 429)** | Shard 5 (`r2-5` 0-based ref); Shard 6 (`r2-6` 1-based ref). |
| **7** | `LGVja7oEjGQ` | AI HISTORY | 422,367 | 76 | Something Strange Happened to This Dough Overnight | **Failed (HTTP 429)** | Shard 7 (`r2-7`) assigned 1-based index 7. |
| **8** | `yUe0knrKwGA` | AI HISTORY | 258,443 | 75 | He Accidentally Made Something That Changed Everything | **Failed (HTTP 429 / No English)** | Shard 7 (`r2-7` 0-based ref); Shard 8 (`r2-8` 1-based ref; ASR Hindi only). |
| **9** | `V0ALvVPHz-8` | BeHealthy | 78,257,998 | 30 | 5 Foods for Your Arteries - Meet the Tiny Cleanup Crew | **Unavailable (No Subtitles/ASR)** | Shard 9 (`r2-9`) assigned 1-based index 9. Zero captions at source. |
| **10** | `WZvsGjMyeB8` | BeHealthy | 470,004 | 30 | 5 Foods, One Tiny Brain Electrician | **Unavailable (No Subtitles/ASR)** | Shard 9 (`r2-9` 0-based ref); Shard 10 (`r2-10` 1-based ref). Zero captions at source. |
| **11** | `IOyoId0o3Ok` | BeHealthy | 357,207 | 30 | Who's Fixing This Heart? A Tiny Mechanic at Work | **Unavailable (No Subtitles/ASR)** | Shard 1 (`r2-1` 1-based ref); Shard 10 (`r2-10` 0-based ref). Zero captions at source. |
| **12** | `YAA-nIUg-oc` | BeHealthy | 304,208 | 34 | Fatty Liver vs. Tiny Workers | 5 Foods & Drinks | **Unavailable (No Subtitles/ASR)** | Shard 1 (`r2-1` 0-based ref); Shard 2 (`r2-2` 1-based ref). Zero captions at source. |
| **13** | `0hY70aYpsLE` | BeHealthy | 285,863 | 30 | 5 More Foods That May Support Your Thyroid | **Unavailable (No Subtitles/ASR)** | Shard 2 (`r2-2` 0-based ref); Shard 3 (`r2-3` 1-based ref). Zero captions at source. |
| **14** | `GD4Q-GQ0FDo` | CoreMine 3D | 10,073,254 | 115 | How Bone China Is Made From Animal Bones | **Unavailable (No Subtitles/ASR)** | Shard 3 (`r2-3` 0-based ref). Zero captions at source. |
| **15** | `Yfi0L3CIseY` | CoreMine 3D | 4,427,024 | 74 | The Impossible Journey of a Blueberry Seed | **Failed (HTTP 429)** | Shard 5 (`r2-5`) assigned 1-based index 15. |
| **16** | `8-0M4hIDEa4` | CoreMine 3D | 3,502,578 | 91 | This Ancient Trick Could Make Ice Without Electricity | **Failed (HTTP 429)** | Shard 5 (`r2-5` 0-based ref); Shard 6 (`r2-6` 1-based ref). |
| **17** | `26T3CgViQ3E` | CoreMine 3D | 3,477,662 | 96 | Nobody Wanted These Fish Scales, Until He Did This! | **Failed (HTTP 429)** | Shard 7 (`r2-7`) assigned 1-based index 17. |
| **18** | `RkFaZJQTEzQ` | CoreMine 3D | 3,338,438 | 65 | Sweet Potato and Banana Fishing Bait Recipe | **Recovered (`.en.vtt`)** | Shard 7 (`r2-7` 0-based ref, retrieved VTT); Shard 8 (`r2-8` 1-based ref, 429). |

### 2.1 Shard Worker Indexing Ambiguity & Provenance Notes
- **Root Cause of Divergence**: The supervisor dispatch prompt partitioned 18 tasks across 10 workers using modulo formula `i` and `i+10`, but did not specify whether the index was 0-indexed (0–17) or 1-indexed (1–18).
- **Dual Probing Behavior**:
  - Shard 1 (`r2-1`) evaluated 1-based #1 and #11, but also probed 0-based #1 (line 2) and #11 (line 12).
  - Shard 2 (`r2-2`) evaluated 0-based #2 and #12, plus 1-based #2 and #12.
  - Shard 3 (`r2-3`) evaluated 1-based #3 and #13, plus 0-based #3 and #13.
  - Shard 5 (`r2-5`) evaluated 1-based #5 and #15, plus 0-based #5 and #15.
  - Shard 6 (`r2-6`) evaluated 1-based #6 and #16.
  - Shard 7 (`r2-7`) evaluated 1-based #7 and #17, plus 0-based #7 (line 8) and #17 (line 18).
  - Shard 8 (`r2-8`) evaluated 1-based #8 and #18.
  - Shard 9 (`r2-9`) evaluated 1-based #9 and 0-based #9; noted that index 19 exceeds list bounds ($19 > 18$).
  - Shard 10 (`r2-10`) evaluated 1-based #10 and 0-based #10; noted that index 20 exceeds list bounds ($20 > 18$).
- **Impact on Upstream Rate Limiting**: The overlap in attempts resulted in repeated bounded requests against identical URLs across shards, confirming persistent HTTP 429 responses rather than transient individual errors.

---

## 3. Shard-by-Shard Consolidation Table (Shards 1 to 10)

| Shard | Worktree & Report Source Path | Top Short Analyzed | Duration & Views | External Audio / Licence Status | Measured Pitch / Energy | Ending Structure & Story Grammar | Missing URL Recovery Findings |
|---|---|---|---|---|---|---|---|
| **r2-1** | `t3-2700a677`<br>`output/agent-jobs/r2-1/REPORT.md` | `9-fBJw75dBc`<br>(Zack D. Films) | 81 s<br>12.5M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Payoff held until final 9.2s. Final line directly callbacks the confession booth promise (*"wouldn't tell a soul"*). Cuts instantly without moralizing. | Index 1 (`8U9--bBl7XY`): HTTP 429.<br>Index 11 (`IOyoId0o3Ok`): 0 subtitles at source.<br>0-based refs: `_nz3g-3SAHQ` (429), `YAA-nIUg-oc` (no subs). |
| **r2-2** | `t3-eddf8d49`<br>`output/agent-jobs/r2-2/REPORT.md` | `BQKSiefBaBE`<br>(World Ji Ke) | 42 s<br>6.95M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Hook promises item #1 will shock. Information structured so #1 (England) is revealed in final 2.5s. Cuts immediately on *"United Kingdom"*. | 0-based Index 2 (`ApqMluy83Hk`): HTTP 429.<br>0-based Index 12 (`0hY70aYpsLE`): 0 subtitles at source.<br>1-based refs: `_nz3g-3SAHQ` (429), `YAA-nIUg-oc` (no subs). |
| **r2-3** | `t3-bfd7d091`<br>`output/agent-jobs/r2-3/REPORT.md` | `BmVz7QMOg3c`<br>(Zack D. Films) | 39 s<br>15.9M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Instructional premise resolves in final 2.0s (*"you'll have a photograph"*). Cuts immediately following the payoff word. | 1-based Index 3 (`ApqMluy83Hk`): HTTP 429.<br>1-based Index 13 (`0hY70aYpsLE`): 0 subtitles at source.<br>0-based refs: `RWFC4aucOoY` (429), `GD4Q-GQ0FDo` (no subs). |
| **r2-4** | `t3-9f14747f`<br>`t3/shorts-ending-analysis-4` | `Fh88VTjex9w`<br>(World Ji Ke) *(Planned)* | 60 s<br>15.6M *(Planned)* | **PENDING**.<br>No output folder or report generated on disk. | **PENDING** | **PENDING**.<br>Local transcript exists in `ForgeBrain/research/shorts-endings-2026-11-15/transcript-ends.txt` (ends with *"Poor Bosnia"*). | **PENDING**.<br>Assigned indices 4 & 14 covered via Shard 3 0-based checks (`RWFC4aucOoY` = 429, `GD4Q-GQ0FDo` = no subs). |
| **r2-5** | `t3-fdcc2252`<br>`output/agent-jobs/r2-5/REPORT.md` | `FwaQ6ATCSGk`<br>(Kaddu3d) | 37 s<br>361K | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Tactical chess trap culminates in final 3.6s. Cut occurs immediately on punchline word (*"checkmated"*). Zero post-match recap. | 1-based Index 5 (`a0fMTaxnuXw`): HTTP 429.<br>1-based Index 15 (`Yfi0L3CIseY`): HTTP 429.<br>0-based refs: `BQl2yAr6GdI` (429), `8-0M4hIDEa4` (429). |
| **r2-6** | `t3-68dc9fae`<br>`output/agent-jobs/r2-6/REPORT.md` | `JPaKOfMFw1Y`<br>(AI HISTORY) | 80 s<br>1.29M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Suspenseful travelogue delays core historical discovery until final 4.8s (*"created the first cheese in human history"*). Cuts on punchline. | 1-based Index 6 (`BQl2yAr6GdI`): HTTP 429.<br>1-based Index 16 (`8-0M4hIDEa4`): HTTP 429. |
| **r2-7** | `t3-496ac908`<br>`output/agent-jobs/r2-7/REPORT.md` | `MT02otAtUUY`<br>(Hoodie Guy) | 64 s<br>35.7M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Humorous banter builds into rapid shouting tokens (58.3s–61.5s), terminating with shouted phrase (*"KILL THAT BOY!"*) and cut at caption end (64.24s). | 1-based Index 7 (`LGVja7oEjGQ`): HTTP 429.<br>1-based Index 17 (`26T3CgViQ3E`): HTTP 429.<br>0-based Index 7 (`yUe0knrKwGA`): HTTP 429.<br>0-based Index 17 (`RkFaZJQTEzQ`): **Recovered `.en.vtt`**. |
| **r2-8** | `t3-0242be0d`<br>`output/agent-jobs/r2-8/REPORT.md` | `Myjedyp5Iwo`<br>(Zack D. Films) | 35 s<br>16.3M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Hook describes truck rolling over person without injury. Payoff in final 2.3s explicitly mirrors hook: *"can roll over people without crushing them"*. Cuts instantly. | 1-based Index 8 (`yUe0knrKwGA`): HTTP 429; Hindi ASR only.<br>1-based Index 18 (`RkFaZJQTEzQ`): HTTP 429 on probe; Hindi ASR at source. |
| **r2-9** | `t3-de25c582`<br>`output/agent-jobs/r2-9/REPORT.md` | `Qig7KhABjFg`<br>(Hoodie Guy) | 71 s<br>27.0M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None**.<br>Acoustic metrics unmeasured. | Conversational interview cuts abruptly mid-sentence (*"Oh, uh, hey, my name is"* at 70.0s/70.8s), leaving zero dead air and driving a seamless loop restart. | 1-based Index 9 (`V0ALvVPHz-8`): 0 subtitles at source.<br>0-based Index 9 (`WZvsGjMyeB8`): 0 subtitles at source.<br>Index 19: Out of bounds ($19 > 18$). |
| **r2-10** | `t3-fad60bda`<br>`output/agent-jobs/r2-10/REPORT.md` | `Zy__AZ9WiCM`<br>(Zack D. Films) | 24.5 s<br>13.9M | Standard YouTube License (`license: None`). Gated per Rule 1; no audio downloaded. | **None on external**.<br>Internal WAV measured; see Section 1.2 & 4. | Hook states turtle cries not because she's sad. Final sentence resolves the biological mystery (*"makes her cry 2 gallons every hour as a way to survive"*). Cuts instantly. | 1-based Index 10 (`WZvsGjMyeB8`): 0 subtitles at source.<br>0-based Index 10 (`IOyoId0o3Ok`): 0 subtitles at source.<br>Index 20: Out of bounds ($20 > 18$). |

---

## 4. Companion Audits & Cross-Family Reviews

### 4.1 Method Review (`r2-method-review`, `t3-11451956`)
- **Reviewer**: claude · claude-haiku-5-5
- **Key Findings on Shard 7 (`r2-7`)**:
  - Confirmed that caption end at 64.24 s does not prove an optical scene cut, requiring the phrasing to be corrected to *"captions end at 64.24 s"*.
  - Challenged the claim that shouted caption tags prove "rising vocal energy", noting that acoustic metrics cannot be derived from subtitles.
  - Identified the operational clash between 0-based and 1-based indexing, noting that Shard 7 probed four URLs instead of two.
  - Noted that raw probe outputs (stdout/stderr) from live `yt-dlp` commands were not saved as separate log files within the shard folder.

### 4.2 Audio Source Index & Licence Audit (`r2-source-index`, `t3-fe1394b9`)
- **Reviewer**: agy · gemini-3.8-flash-high
- **Key Findings**:
  - Verified that all 35 sampled Shorts are under Standard YouTube License (`license: None`).
  - Confirmed that the local repository contains 664 audio files, consisting entirely of internal TTS voiceovers, Qwen voice samples, and licensed background music (`blender_worker/audio/`); zero YouTube audio files are present.
  - Pointed out that even if research fair use were invoked, external Shorts feature heavy music and sound effect mixes; valid acoustic narration analysis would strictly require vocal stem separation (e.g., Demucs / MDX-Net).

### 4.3 Independent Acoustic Audit (`r2-acoustic-review`, `t3-67b94a8f`)
- **Reviewer**: codex · gpt-6-luna
- **Key Findings on Shard 10 Local WAV Analysis**:
  - Re-analyzed `output/episodes/cb-mwhwm4io-294b04/voice.wav` (SHA-256 `a0141c25...`, voice `aiden`, 37.088 s).
  - Validated that the final 2.0 s wall-clock window contains **0.989 s of post-speech silence**, artificially skewing the energy ratio to 0.395 (60.5% drop).
  - Measured the actual spoken ending window [34.099 s, 36.099 s]: RMS is 0.0784 (a 38.1% drop against the rest of the spoken track).
  - Confirmed that `librosa.pyin` voiced frame coverage was only 35.6% across the wall-clock ending window, vs. 79.3% in the spoken window.
  - Verified the code path: `voice.js` omits deliveries, `tts_engine.py` passes `directions=flat_dirs` (a non-None list), causing `story_tone.py` to default to uniform baseline narration. The fallback arc with "calm, thoughtful close" was never executed.

### 4.4 Proof Rubric & Gating Specification (`r2-proof-rubric`, `t3-9ea2015d`)
- **Reviewer**: agy · gemini-3.8-flash-high
- **Key Deliverable**: Established the 100-point rubric and two binary zero-tolerance gates for evaluating post-merge E1 proof videos:
  1. *Gate 1 (Zero-Tolerance Banned Endings)*: No post-hoc error corrections ("off by about nine meters"), no lingering stagnation words ("stays", "remains", "still breaks there"), no bare data points, no summary triplets, and no outro CTAs.
  2. *Gate 2 (Voice E1b Telemetry)*: `voice.json` must record `delivery.mode === 'beats'`, ending feel must be in `["amazed", "playful", "satisfied"]`, ending tone must carry the appropriate smile/lift, and `"calm, thoughtful close"` must be strictly absent.

---

## 5. Conflicting Track Findings & Missing Logs

1. **External Audio Availability**:
   - Initial lane plans contemplated analyzing pitch/energy in 10 top Shorts.
   - Shard reports unanimously verified that external audio could not be downloaded without violating the commercial monetization licence gate (`CLAUDE.md` Rule 1).
   - Consequently, external acoustic metrics are completely absent across all shards.
2. **Missing Probe Logs**:
   - Shards executed bounded `yt-dlp` queries in the shell. While exit codes and error summaries (e.g., HTTP 429, no subtitles available) were documented in the markdown reports, raw probe stdout/stderr logs were not systematically retained on disk in `output/agent-jobs/r2-*/`.
3. **Pending Shard 4 Report**:
   - Worktree `t3-9f14747f` was created for branch `t3/shorts-ending-analysis-4`, intended for Shard 4.
   - Filesystem verification confirms no output folder or `REPORT.md` was generated. Shard 4 remains pending. Its assigned candidate (`Fh88VTjex9w`, World Ji Ke, Useless Coastlines) is documented in `transcript-ends.txt`, and its missing URL assignments (`RWFC4aucOoY` and `GD4Q-GQ0FDo`) were verified by Shard 3.

---

## 6. Guidance for E1 Implementation & Verification

1. **Do Not Rely on External Audio Telemetry**: Evaluation of ForgeAi's ending quality cannot and should not depend on external YouTube audio measurements. Evaluation must rely on:
   - Script structure verification (open-loop hook, callback echo, delayed punchline, cut-on-punch).
   - Internal delivery telemetry (`voice.json` confirming `beats` mode and ending feel assignment per E1b commit `0eeae8d`).
2. **Prevent Recurrence of Banned Ending Patterns**: Enforce strict filtering in `planner.js` to eliminate anticlimactic data points, margin corrections, and summary triplets.
3. **Verify Voice Delivery Wiring**: Ensure `dashboard/server/episode/voice.js` forwards the planner's beat deliveries to `/api/tts-timed` so that `story_tone.py` injects the required ending lift rather than defaulting to the uninflected baseline narrator.

---
*Verified against local git worktrees and project files. Cross-family review follows.*
