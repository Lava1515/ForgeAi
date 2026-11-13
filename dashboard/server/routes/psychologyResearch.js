import { askGemini } from './gemini.js';

// Base psychology retention rules for voiceover (shared across all genres)
export const BASE_VOICEOVER_RULES = `BASE PSYCHOLOGICAL VOCAL RETENTION RULES:
1. STEADY VOCAL DELIVERY:
   One confident, natural narrator speaking clearly at full normal conversational volume and a brisk, steady pace throughout.
   Never whisper, slow down, shout, or act out theatrical emotions.
2. HOOK & CLIMAX EMPHASIS:
   Deliver the hook and climax with clear, confident emphasis on key nouns. Maintain steady natural momentum on all intermediate sentences. At most ONE deliberate tone change per video (hook or climax).
3. THE ZEIGARNIK EFFECT & SUSPENSIVE RISE:
   On questions, clues, or open curiosity loops, end on a sustained mid-tone or slight upward inflection.
   This holds active working memory in the brain. Never sound final until the very end.
4. SEAMLESS INFINITE LOOP STITCHING (Linguistic & Syntactic Loop Bridge):
   Structure the closing sentence so its final words seamlessly bridge syntactically and rhythmically into Sentence 1 (The Hook) without a conclusive terminal pitch drop (e.g., "...and that's the exact reason why..." flowing into the hook). Viewers don't register the video ended and watch 2-5 seconds into the second loop, pushing completion rate over 100%.
5. THE PAYOFF GAP & INFORMATION GAP (The "What" vs. The "How"):
   Front-load Sentence 1 (The Hook) with the extraordinary result, anomaly, or high-stakes consequence ("The What"), while strictly withholding the underlying cause, solution, or mechanism ("The How") until the final beats to prevent premature drop-off.`;

// Base psychology retention rules for video generation (shared across all genres)
export const BASE_VIDEO_RULES = `BASE VISUAL & VIDEO PSYCHOLOGICAL RETENTION RULES:
1. VISUAL ANTICIPATION WITHHOLDING & DOPAMINE DELAY:
   Withhold complete visual resolution. Set up an imminent physical completion or reveal, but deliberately delay the final satisfaction (e.g. keeping an uncleaned soapy patch on glass for an extended time to force the viewer to wait for the complete wipe).
2. THE ZEIGARNIK VISUAL LOOP & OPEN GESTALT:
   Frame visual compositions with an unresolved focal anomaly, hidden element, or question mark that the visual cortex demands closure for.
3. PATTERN INTERRUPT CADENCE (Micro-Disruptions):
   Viewer drop-off spikes after 2.5 seconds of static motion. Introduce camera shifts, unexpected lighting changes, macro closeups, or abrupt velocity alterations to reset retinal habituation.
4. TENSION-HOLD BEFORE VISUAL PAYOFF:
   Right before a key action, reveal, or transformation, hold or stretch the visual tension (micro-slowdown or close-in camera creep) before the visual payoff occurs.
5. HOOK FRAME SEEDING:
   The first 1.5 seconds must feature high visual intrigue, an anomalous visual juxtaposition, or immediate motion that defies passive scrolling.
6. NEED FOR COGNITIVE CLOSURE & VISUAL ASYMMETRY:
   Capitalize on the human neurological drive to resolve ambiguity and chaos. Frame scenes with blatant asymmetry or an unfinished state (e.g., half-cleaned surface, lopsided balance, incomplete pattern). The visual cortex experiences cognitive itch and demands closure, holding the viewer until equilibrium is achieved.
7. VISUAL PROGRESS ANCHORS & DOPAMINE RAMP (Continuous Physical Progress Graph):
   Dopamine peaks during active anticipation, not just upon final reward. Display a perceptible visual progression (a steadily shrinking uncleaned boundary, an advancing physical meter, or visible phase completion). Seeing measurable progress keeps viewers hooked through the danger zone (70-90% duration).
8. THE VERIFICATION URGE & WATCH-TIME TRAP (Controlled Imperfection / The Soap Patch):
   Deliberately preserve a conspicuous, small imperfection or unaddressed focal point until the final 1-2 seconds. The viewer stays to verify whether it gets resolved or to confirm if the creator noticed, and often re-watches or leaves comments, dramatically boosting retention and algorithm ranking.
9. SEAMLESS VISUAL LOOP CONTINUITY:
   Align the final scene's visual vector, motion velocity, and central subject with the opening frame so the loop boundary is invisible to passive scrolling.
10. SHORTS-TO-LONG FUNNEL CONTINUITY & TRANSITION SHOCK PREVENTION:
   When creating short-form assets meant to drive channel growth, present the climax or peak anomaly cleanly in the short, but explicitly bridge to long-form content using visual cues (arrows/callouts) and immediate narrative continuity to eliminate transition bounce.`;

// Genre-specific templates used as high-grade fallbacks if Gemini is offline or during testing
export const GENRE_TEMPLATES = {
  mystery: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (MYSTERY & UNEXPLAINED):
- STEADY INVESTIGATIVE CADENCE: Calm, clear curiosity with steady pace and normal volume throughout.
- CLEAR EVIDENCE EMPHASIS: Confident, unhurried articulation on clues and anomalies without dropping volume.
- SEAMLESS LOOP CONNECTOR: End with an open-ended syntactic connector like "...and that is the darkest secret behind..." bridging right back to the opening mystery hook.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (MYSTERY & UNEXPLAINED):
- OCCLUDED HORIZON & SHADOW WITHHOLDING: Keep crucial visual evidence partially hidden in fog, deep shadow, or behind foreground objects to compel the eye to search.
- CREEPING PERIPHERAL MOTION: Subtly introduce movement in background corners 1-2 seconds before camera pans to it.
- THE UNRESOLVED GAZE: Characters or silhouettes staring intently off-camera, delaying the reveal of what they are witnessing.
- VISUAL ITCH / ANTICIPATION DELAY: Frame a doorknob slowly turning or a safe dial rotating, pausing right at the click.
- VERIFICATION DETAIL: Plant an unsettling, subtle anomaly in the background that forces viewers to pause or loop to verify.`
  },
  history: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (HISTORICAL & DRAMA):
- ARCHIVAL GRAVITAS: Deep resonant timbre conveying immense historical consequence and forgotten secrets at normal volume.
- MOMENTOUS FOCUS: Clear, resonant articulation on decisive turning points while maintaining steady pacing.
- HISTORICAL LOOP BRIDGE: End on a lingering paradox ("...and that is why centuries later, historians still ask...") linking cleanly to the opening premise.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (HISTORICAL & DRAMA):
- RELIC MACRO DRIFT: Extremely slow macro pan over historical artifacts, ancient maps, or faded letters, holding back the full map reveal.
- SILHOUETTES OF DECISION: Frame leaders or figures in grand historical lighting, withholding their face until the turning point.
- TIME-WARP DISSOLVE SUSPENSE: Transition between ancient ruins and their past glory with lingering intermediate smoke or dust.
- VISUAL PROGRESS ANCHOR: Track the geographic collapse or battle advance via an animated archival map steadily changing color.`
  },
  computers: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (TECH, CODING & AI):
- TECHNICAL CLARITY: Crisp, confident authority at a brisk, steady pace.
- FOCUSED REVELATION: Direct, clear emphasis when explaining exploits or security mechanisms at normal conversational volume.
- CODE LOOP STITCH: End on a rhythmic setup like "...which triggers the exact fatal loop where..." flowing into the hook.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (TECH, CODING & AI):
- CURSOR & TERMINAL ANTICIPATION: Screen recording style showing an incomplete terminal command or compilation progress bar lingering at 99%.
- GLITCH PATTERN INTERRUPTS: Micro visual artifacts every 2 seconds to retain high-stimulus tech-focused viewers.
- CIRCUIT TRACE CAMERA FLIGHT: Rapid fly-through of glowing cyber architecture, withholding the central server core until the climax.
- VERIFICATION SYNTAX TRAP: Flash a code snippet with a deliberate edge-case anomaly that programmers pause to inspect.`
  },
  oddly_satisfying: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (ODDLY SATISFYING & ASMR):
- RELAXED STEADY TIMBRE: Smooth, clean conversational cadence with clear presence and normal volume.
- NATURAL PAUSE TIMING: Clean pauses matching the physical action in the video.
- SEAMLESS LOOP SYNTAX: Finish on an open-ended tone that flows naturally into the first line without a concluding cadence drop.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (ODDLY SATISFYING & CLEANING):
- THE SOAP PATCH & VERIFICATION TRAP: In cleaning/restoration videos, deliberately leave a conspicuous small patch of soap, grime, or tape uncleaned for 85% of the clip. The viewer's brain cannot click away until they see that final patch wiped spotless!
- COGNITIVE CLOSURE CONTRAST: Exaggerate the split between pristine clean and heavy grime across a sharp dividing line to trigger an acute psychological need for closure.
- VISUAL PROGRESSION RAMP: Maintain a clear, sweeping physical boundary of restoration so the dopamine anticipation curve builds steadily until the final wipe.
- PERFECT ALIGNMENT SUSPENSE: Move an object excruciatingly close to a perfectly fitting slot, hesitating right before the snap.
- REPEAT SURFACE TEXTURE GLIDE: Extreme macro lens tracking a blade peeling material with zero camera shake.`
  },
  psychology: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (PSYCHOLOGY & HUMAN BEHAVIOR):
- THE COGNITIVE JOLT HOOK: State an unsettling psychological bias or brain flaw with clear, direct second-person address ("Your brain is tricking you right now").
- COGNITIVE INSIGHT: Clear, engaging explanation of the hidden psychological trigger or subconscious mechanism at normal conversational volume.
- OPEN LOOP RETAINER: Pose a probing behavioral question mid-scene and hold pitch up until the final psychological reveal.
- SEAMLESS LOOP CONNECTOR: End with "...and that's the psychological phenomenon known as..." directly looping into the opening hook.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (PSYCHOLOGY & HUMAN BEHAVIOR):
- VISUAL ILLUSION & OPEN GESTALT: Open with an ambiguous optical illusion, anomalous facial expression, or paradoxical diagram that the visual cortex struggles to decode.
- ASYMMETRICAL BRAIN MAPS & PROGRESSION: Animate neural pathways or conceptual split-screens that progressively illuminate as the explanation unfolds.
- SUBLIMINAL PATTERN INTERRUPTS: Micro-glitches and fast focal shifts every 2-3 seconds matching the psychological concept.
- THE VERIFICATION HOOK: Show a behavioral experiment outcome or puzzle where the viewer is compelled to pause or watch twice to test themselves.`
  },
  space: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (ASTRONOMY & COSMIC):
- ASTRONOMICAL WONDER: Confident, clear narrator conveying cosmic scale at steady conversational volume and pace.
- INFINITE VOID LOOP: Conclude with "...which is why deep in the void, nothing ever escapes..." flowing seamlessly back to the opening anomaly.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (ASTRONOMY & COSMIC):
- THE DEEP FIELD SLOW PUSH: Camera drifting toward a seemingly empty dark void of space, gradually resolving into billions of galaxies.
- GRAVITATIONAL TENSION: Show a celestial body or event horizon warping light, holding the visual before the collapse.
- SPECTRAL SHIFTS: Ultraviolet and infrared false-color pulses revealing hidden phenomena.
- COSMIC SCALE PROGRESSION: Zoom out continuously through powers of ten, driving dopamine anticipation as scale expands exponentially.`
  },
  science: {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (SCIENCE & ANOMALIES):
- COUNTERINTUITIVE ATTACK: State an impossible-sounding scientific law or paradox with sharp conviction.
- EMPIRICAL CLARITY: Confident explanation of classified experimental data at clear, normal volume and steady pace.
- EXPERIMENT LOOP CONNECTOR: End on "...which explains why physics breaks down when..." connecting right back into the opening premise.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (SCIENCE & ANOMALIES):
- THE PENDING REACTION: High-speed macro footage of a chemical droplet about to hit a reactive surface, holding the frame at the microsecond of impact.
- SPLIT-SPECTRUM CONTRAST: Half thermal / half visible spectrum camera creating visual asymmetry and demanding closure.
- MOLECULAR LATTICE PROGRESSION: Visual crystal growth or reaction front sweeping across the vertical screen.`
  }
};

/**
 * Pure function: sanitizes voiceover psychology rules read from channels/configs.
 * If the rules match known old base rules (with phrases like 'CONTRAST IS MANDATORY',
 * 'CONSPIRATORIAL DROP', 'whisper'), replaces with the new default BASE_VOICEOVER_RULES.
 * If a custom ruleset contains blocks with these old phrases, strips those rule blocks.
 */
export function sanitizeVoiceoverPsychologyRules(rules, defaultRules = BASE_VOICEOVER_RULES) {
  if (!rules || typeof rules !== 'string' || !rules.trim()) {
    return defaultRules;
  }
  const trimmed = rules.trim();

  // Distinctive old base rules signature (e.g. ORIENTING REFLEX, CONTRAST IS MANDATORY, CONSPIRATORIAL DROP)
  const isOldBaseRules =
    /CONTRAST IS MANDATORY/i.test(trimmed) ||
    (/CONSPIRATORIAL DROP/i.test(trimmed) && /AUDITORY BRAKING/i.test(trimmed));
  if (isOldBaseRules) {
    return defaultRules;
  }

  // Strip rule blocks/lines containing old whisper, decelerate, conspiratorial drop, staccato asks
  const badAskPattern = /(?:CONTRAST IS MANDATORY|CONSPIRATORIAL DROP|conspiratorial whisper|intimate conspiratorial|hushed conspiratorial|auditory braking|decelerat\w*|staccato\s+articulation|staccato\s+punch|drop volume to an intimate|hushed anticipation)/i;

  const blocks = trimmed.split(/\n\s*\n/);
  const cleanedBlocks = blocks
    .map((block) => {
      const lines = block.split('\n');
      const filteredLines = lines.filter((l) => {
        // Keep negative directives like "never whisper" or "no whisper"
        if (/\b(?:never|no|not|don't|without)\s+(?:whisper|slow down|shout)/i.test(l)) {
          return true;
        }
        return !badAskPattern.test(l) && !/\bwhisper\b/i.test(l);
      });
      return filteredLines.join('\n').trim();
    })
    .filter(Boolean);

  if (!cleanedBlocks.length) {
    return defaultRules;
  }

  return cleanedBlocks.join('\n\n').trim();
}

/**
 * Dynamically researches psychology rules for a specific channel and genre using Gemini.
 * Combines the base rules with bespoke retention strategies for that genre.
 */
export async function researchChannelPsychologyRules({ genre = 'general', name = '', description = '' } = {}, ask = askGemini) {
  const cleanGenre = String(genre || 'general').trim().toLowerCase();
  const normalizedGenre = cleanGenre.replace(/[^a-z0-9]/g, '');

  const prompt = `You are a world-class cognitive psychologist, YouTube viral retention engineer, and short-form video director.
Analyze this YouTube channel and create actionable, high-retention psychological directives tailored specifically to this genre:
- Channel Name: "${name || cleanGenre}"
- Channel Genre: "${cleanGenre}"
- Channel Description: "${description || 'Short-form vertical video series for YouTube Shorts and TikTok'}"

You must formulate TWO distinct, comprehensive sets of psychological retention rules:

1. "voiceover_rules":
   - Include the BASE rules:
${BASE_VOICEOVER_RULES}
   - RESEARCH AND ADD 3-5 GENRE-SPECIFIC vocal directives tailored to "${cleanGenre}". Detail vocal cadence, steady pacing, clear volume, seamless loop bridges (linguistic loop stitching), and auditory habituation breakers proven to maximize retention in ${cleanGenre}. Never ask for whispers, volume drops, or theatrical speed changes.

2. "video_rules":
   - Include the BASE visual rules:
${BASE_VIDEO_RULES}
   - RESEARCH AND ADD 3-5 GENRE-SPECIFIC visual retention rules tailored to "${cleanGenre}".
   - MANDATORY REQUIREMENT: Detail concrete visual anticipation withholding tactics (such as the cleaning example: keeping soap on a window patch for a long time to make the viewer wait for it to be cleaned; or in tech: blinking terminal cursor on a syntax error; or in mystery: keeping a shadowy silhouette partially occluded).
   - Detail cognitive closure tactics, visual progress anchors (dopamine anticipation ramps), the verification urge (controlled imperfections), and seamless visual loops.
   - Explain how to structure scene prompts, camera motion, and visual payoffs to maximize watch time and prevent scroll-away.

Return strictly valid JSON with this schema, no markdown wrappers:
{
  "voiceover_rules": "Full combined text containing base rules + genre-specific vocal directives",
  "video_rules": "Full combined text containing base visual rules + genre-specific visual anticipation rules",
  "summary": "1-2 sentence summary of this channel's retention hook"
}`;

  let raw = null;
  try {
    raw = await ask(prompt, { maxTokens: 2500 });
  } catch (err) {
    // Fall back to template
  }

  // Find best matching template or fallback
  const templateKey = Object.keys(GENRE_TEMPLATES).find((k) => normalizedGenre.includes(k) || k.includes(normalizedGenre));
  const template = GENRE_TEMPLATES[templateKey] || {
    voiceover: `GENRE-SPECIFIC VOCAL DIRECTIVES (${cleanGenre.toUpperCase()}):
- STEADY NICHE NARRATION: Confident, engaging storytelling tailored to ${cleanGenre} at full normal volume.
- CLEAR INSIDER EMPHASIS: Confident emphasis on key facts without dropping volume or slowing down.
- SUSPENSIVE QUESTION TERMINATION: End inquiries with natural pitch to maintain open loops.
- SEAMLESS LOOP CONNECTOR: Craft the final line as a natural syntactic bridge back into the opening hook.`,
    video: `GENRE-SPECIFIC VISUAL DIRECTIVES (${cleanGenre.toUpperCase()}):
- ANTICIPATION WITHHOLDING & DOPAMINE DELAY: Frame key actions in ${cleanGenre} with an incomplete element (e.g. keeping uncleaned soap on a window, an unclicked button, or an unsolved puzzle) to compel viewers to stay for completion.
- NEED FOR COGNITIVE CLOSURE: Present strong visual contrast or asymmetry in ${cleanGenre} that demands resolution.
- PATTERN INTERRUPT VISUALS: Rapid camera angle switch every 2-3 seconds to reset visual habituation in ${cleanGenre}.
- DELAYED VISUAL REVEAL: Linger on the build-up before showing the final result.
- VERIFICATION DETAIL: Place an intriguing anomaly in frame that encourages re-watching and commenting.`
  };

  const voRules = raw?.voiceover_rules
    ? String(raw.voiceover_rules).trim()
    : `${BASE_VOICEOVER_RULES}\n\n${template.voiceover}`;

  const vidRules = raw?.video_rules
    ? String(raw.video_rules).trim()
    : `${BASE_VIDEO_RULES}\n\n${template.video}`;

  const summary = raw?.summary
    ? String(raw.summary).trim()
    : `Tailored retention and anticipation directives for ${cleanGenre}.`;

  return {
    voiceover_rules: voRules,
    video_rules: vidRules,
    voiceover_psychology_rules: voRules,
    video_psychology_rules: vidRules,
    summary,
    genre: cleanGenre,
  };
}
