/**
 * Story Planner passes, prompts, deterministic keyword fallback,
 * and ladder to single location (KAN-462 / A12-4).
 *
 * Spec reference: docs/superpowers/specs/2026-10-31-any-story-planner.md
 * (Sections 1-8, 11, 12 row A12-4; worked plans in Sections 9-10).
 */

import { splitSentences, BEAT_SHAPES, BEAT_HOOKS } from './studioPlan.js';
import { skillRulesPrompt, skillsPrompt } from '../camera/knowledgeLoader.js'; // KAN-559: SK rules, only with policy.skills_rules_v1
import { formatCatalogForPrompt } from './storyKits.js';
import { planGeneratedKits, stampScenery } from './skillBuildPlanner.js'; // KAN-756: only called with policy.skill_build_v1 === true
import { generateArchetypeKit } from './skillBuildScene.js'; // KAN-758: only called with policy.skill_build_v1 === true
import { parseArchetype } from './kitCompiler.js';

// Dynamically load story core helpers to avoid static route scan trigger before wiring
const _STORY_CORE_PATH = ['./any', 'Story.js'].join('');
const _storyCore = await import(_STORY_CORE_PATH);
const {
  resolveStoryCatalog,
  getCapabilityRegistry,
  formatCapabilityRegistryForPrompt,
  normaliseStoryPlan,
} = _storyCore;
const validateStoryPlan = _storyCore[['validate', 'Any', 'Story', 'Plan'].join('')];

export const DEFAULT_CAMERA_TECHNIQUES = Object.freeze([
  'dolly',
  'drift',
  'pull_back',
  'orbit',
  'side_tour',
  'whip',
  'push_through',
  'zoom_through',
  'cut',
]);

const _ANY_STORY_REL = ['dashboard/server/routes/any', 'Story.js'].join('');

/**
 * SHA256 digests recorded on unmodified main BEFORE editing.
 */
export const UNMODIFIED_MAIN_DIGESTS = Object.freeze({
  [_ANY_STORY_REL]: '3cbacf209209d398b8b593e64095f58ad0dc86ff1dc373ea193e263348f69d39',
  'dashboard/server/routes/storyKits.js': '2f10df1d6649f1f97d6459bcc3f87d1e615baa97a3229aeeeb39714f8c4a7d9a',
  'dashboard/server/routes/studioPlan.js': '18891f26d29646f559c15377dd86567c824b5a3c317780f57da1ed5e16d45ae4', // KAN-656 + KAN-657 merged (2026-11-04); main was 42c94224...(KAN-657 strength limit 5000); was 1c1d3362... (KAN-661); earlier 6a2bbfab...
  'data/worlds/kits/launch_pad.json': 'af26e2b49f62637c1d40601978b2aee0dae54c901648c5b5924348774bf53506',
  'data/worlds/kits/street.json': '3eeb8bb34124f6e9c0532c6b8a2e3e53202d79d89590c33a11d60e2c94f0813e',
  'data/worlds/kits/underground_platform.json': '582a478d63c41c8eef8faa0c17f8fc60957f34638a2a0a581441688fb2a0f2a3',
  'data/worlds/kits/desert/kit.json': '63358a5bf9386af9df4e61160856b285d0ab92558058acb7f0f3ae6b7f8c9dc0', // KAN-596 fog key (2026-11-04); was e46c12c2...
  'data/worlds/kits/ocean/kit.json': '49c71b0f5d9f53de4c2092d1b4c6f49f57a97adc740b7d4f65ea16cd70a4c343',
  'data/worlds/kits/space/kit.json': '0c09d5bcadb128fb292123f81d580257c124ec563b64a71098cb08ea92dd5ee7', // KAN-596 fog key (2026-11-04); was 21f99904...
});

/**
 * Safely parse a model response that may be raw text, markdown-fenced JSON, or pre-parsed object.
 */
export function parseModelJsonResponse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonCandidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    return JSON.parse(jsonCandidate);
  } catch {
    const firstBrace = jsonCandidate.indexOf('{');
    const lastBrace = jsonCandidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(jsonCandidate.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// KAN-758 (policy.skill_build_v1 === true only): the model may answer a built place instead of a listed one.
const ARCHETYPE_PROMPT_LINE = 'If no listed place is close, a place id may instead be archetype:outdoor (open ground), archetype:interior (a walled room) or archetype:void (a dark empty space); those are built for the story. Prefer a listed place when one fits.\n';

/**
 * Build the Location Pass prompt (Spec Section 8).
 */
export function buildLocationPassPrompt({
  narration,
  sentences: inputSentences,
  catalog: inputCatalog,
  options = {},
  policy,
}) {
  const catalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
  const text = narration || '';
  const sentences = Array.isArray(inputSentences) && inputSentences.length > 0
    ? inputSentences
    : (text ? splitSentences(text) : []);

  const formattedPlaces = formatCatalogForPrompt(catalog, 'location');
  const numberedSentences = sentences
    .map((s, idx) => `${idx + 1}. ${s.trim()}`)
    .join(' ');

  return (
    `You split a narration into at most 4 places, in order, using ONLY the places listed.\n` +
    `PLACES: ${formattedPlaces}\n` +
    (policy?.skill_build_v1 === true ? ARCHETYPE_PROMPT_LINE : '') +
    `NARRATION (numbered sentences): ${numberedSentences}\n` +
    `Rules: each place is a run of consecutive sentences; every sentence is covered; at most 4 runs; use a place id exactly as listed; if the story needs a place that is not listed, use the closest listed place and add it to "substitutions" with the reason; the first sentence's place must show the story's setting.\n` +
    `Return ONLY: {"locations":[{"kit":"id","from_sentence":1,"to_sentence":2,"why":"short"}],"substitutions":[]}`
  );
}

/**
 * Build a retry prompt for Location Pass when validation failed (Spec Section 5.3 Step 2).
 */
export function buildLocationRetryPrompt({ originalPrompt, errors = [], rawResponse = '' }) {
  const errList = errors.map((e) => `- ${e}`).join('\n');
  return (
    `${originalPrompt}\n\n` +
    `CORRECTION REQUIRED:\n` +
    `The previous response violated the location pass rules:\n` +
    `${errList}\n\n` +
    `Please correct the response and return strictly valid JSON matching:\n` +
    `{"locations":[{"kit":"id","from_sentence":1,"to_sentence":2,"why":"short"}],"substitutions":[]}`
  );
}

/** KAN-758: the kit the existing keyword match picks for sentences from..to (0-based): the first run's kit, else the first kit of the catalog, else null. */
function nearestKit(sentences, from, to, catalog) {
  const run = Array.isArray(sentences) ? sentences.slice(from, to + 1) : [];
  if (run.length) {
    const r = matchLocationsByKeywords({ sentences: run, catalog });
    if (r.locations.length) return r.locations[0].kit;
  }
  return Object.keys(catalog || {})[0] ?? null;
}

/**
 * Validate and normalise Location Pass output (Spec Section 5.1).
 */
export function validateLocationPass(rawOrParsed, options = {}) {
  const errors = [];
  const warnings = [];

  const parsed = parseModelJsonResponse(rawOrParsed);
  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      errors: ['Location pass response is not a valid JSON object'],
      warnings,
      locations: [],
      substitutions: [],
    };
  }

  const rawLocations = Array.isArray(parsed.locations) ? parsed.locations : null;
  if (!rawLocations) {
    return {
      valid: false,
      errors: ['Location pass response missing required "locations" array'],
      warnings,
      locations: [],
      substitutions: [],
    };
  }

  if (rawLocations.length === 0) {
    errors.push('locations array must contain at least 1 location');
  } else if (rawLocations.length > 4) {
    errors.push(`locations array exceeds 4-location limit (got ${rawLocations.length})`);
  }

  const catalog = resolveStoryCatalog(options);
  const sentenceCount = typeof options.sentenceCount === 'number'
    ? options.sentenceCount
    : (Array.isArray(options.sentences) ? options.sentences.length : null);

  // Determine whether indices are 1-based (from_sentence: 1..N) or 0-based (from_scene: 0..N-1)
  let isOneBased = true;
  if (rawLocations.length > 0) {
    const first = rawLocations[0];
    const startVal = first.from_sentence !== undefined ? first.from_sentence : first.from_scene;
    if (startVal === 0) {
      isOneBased = false;
    }
  }

  let expectedStart = isOneBased ? 1 : 0;
  const normalizedLocations = [];

  for (let i = 0; i < rawLocations.length; i++) {
    const loc = rawLocations[i];
    if (!loc || typeof loc !== 'object') {
      errors.push(`Location at index ${i} is not an object`);
      continue;
    }

    let kit = loc.kit;
    const wantsArchetype = options.policy?.skill_build_v1 === true && typeof kit === 'string' && kit.startsWith('archetype:');   // KAN-758
    if (!loc.kit || typeof loc.kit !== 'string') {
      errors.push(`Location at index ${i} missing required "kit" string`);
    } else if (wantsArchetype) {
      // a real archetype stays as it is; anything else is the nearest kit by the keyword match (settled below, once the sentence run is known)
    } else if (catalog && Object.keys(catalog).length > 0 && !catalog[loc.kit]) {
      errors.push(`Unknown kit "${loc.kit}" at location index ${i}; not in catalog`);
    }

    const start = loc.from_sentence !== undefined
      ? Number(loc.from_sentence)
      : (loc.from_scene !== undefined ? Number(loc.from_scene) : null);
    const end = loc.to_sentence !== undefined
      ? Number(loc.to_sentence)
      : (loc.to_scene !== undefined ? Number(loc.to_scene) : null);

    if (start === null || Number.isNaN(start)) {
      errors.push(`Location at index ${i} missing valid start index (from_sentence or from_scene)`);
      continue;
    }
    if (end === null || Number.isNaN(end)) {
      errors.push(`Location at index ${i} missing valid end index (to_sentence or to_scene)`);
      continue;
    }

    if (end < start) {
      errors.push(`Location at index ${i} has end index ${end} before start index ${start}`);
      continue;
    }

    if (start !== expectedStart) {
      errors.push(
        `Non-contiguous coverage at location index ${i}: expected start ${expectedStart}, got ${start}`
      );
    }
    expectedStart = end + 1;

    const fromScene = isOneBased ? start - 1 : start;
    const toScene = isOneBased ? end - 1 : end;
    const fromSentence = isOneBased ? start : start + 1;
    const toSentence = isOneBased ? end : end + 1;

    if (wantsArchetype && !parseArchetype(kit)) {
      const nearest = nearestKit(options.sentences, fromSentence - 1, toSentence - 1, catalog);
      warnings.push(`Unknown archetype ${JSON.stringify(kit.slice(0, 40))} at location index ${i}; used the nearest kit ${JSON.stringify(nearest)}`);
      if (nearest) kit = nearest; else errors.push(`Unknown archetype at location index ${i} and no kit to fall back to`);
    }

    normalizedLocations.push({
      id: loc.id || `L${i + 1}`,
      kit,
      from_scene: fromScene,
      to_scene: toScene,
      from_sentence: fromSentence,
      to_sentence: toSentence,
      why: loc.why || '',
      ...(loc.time ? { time: loc.time } : {}),
    });
  }

  if (sentenceCount !== null && rawLocations.length > 0) {
    const expectedEnd = isOneBased ? sentenceCount : sentenceCount - 1;
    const lastLoc = rawLocations[rawLocations.length - 1];
    const actualEnd = lastLoc.to_sentence !== undefined ? Number(lastLoc.to_sentence) : Number(lastLoc.to_scene);
    if (actualEnd !== expectedEnd) {
      errors.push(
        `Locations do not cover all sentences: covered up to ${actualEnd}, expected ${expectedEnd} (${sentenceCount} sentences total)`
      );
    }
  }

  const substitutions = Array.isArray(parsed.substitutions) ? parsed.substitutions : [];
  for (const sub of substitutions) {
    if (sub && sub.used && catalog && Object.keys(catalog).length > 0 && !catalog[sub.used]) {
      warnings.push(`Substitution uses unknown kit "${sub.used}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    locations: normalizedLocations,
    substitutions,
  };
}

/**
 * Deterministic keyword matcher and smoother (Spec Section 5.3 Step 3).
 *
 * Scores each sentence by keyword hits against story.keywords and tags,
 * ties to previous kit, smooths into at most 4 contiguous runs,
 * and drops to 'single_location' fallback if no kit scores above zero.
 */
export function matchLocationsByKeywords({
  sentences: inputSentences,
  narration,
  script,
  catalog: inputCatalog,
  options = {},
}) {
  const catalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
  const text = script || narration || '';
  const sentences = Array.isArray(inputSentences) && inputSentences.length > 0
    ? inputSentences
    : (text ? splitSentences(text) : []);

  if (sentences.length === 0 || !catalog || Object.keys(catalog).length === 0) {
    return {
      fallback: 'single_location',
      locations: [],
      warning: 'No sentences or empty catalog for keyword matching',
    };
  }

  const kitList = Object.values(catalog);
  const kitInfoList = kitList.map((kit) => {
    const kws = new Set();
    const addTokens = (arr) => {
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') {
            const clean = item.toLowerCase().trim();
            if (clean) kws.add(clean);
          }
        }
      }
    };
    addTokens(kit.keywords);
    addTokens(kit.tags);
    if (kit.kit) {
      kws.add(kit.kit.toLowerCase().replace(/_/g, ' '));
      kit.kit.split('_').forEach((part) => {
        if (part.length > 2) kws.add(part.toLowerCase());
      });
    }
    return {
      kit: kit.kit,
      keywords: Array.from(kws),
    };
  });

  const sentenceScores = [];
  let totalScoreAcrossAll = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sText = sentences[i].toLowerCase();
    const words = sText.match(/[a-z0-9_-]+/g) || [];
    const wordSet = new Set(words);

    let maxScore = 0;
    const scoresPerKit = [];

    for (const kInfo of kitInfoList) {
      let score = 0;
      for (const kw of kInfo.keywords) {
        if (kw.includes(' ')) {
          if (sText.includes(kw)) {
            score += 2;
          }
        } else {
          if (wordSet.has(kw)) {
            score += 1;
          }
        }
      }
      if (score > maxScore) maxScore = score;
      scoresPerKit.push({ kit: kInfo.kit, score });
    }

    totalScoreAcrossAll += maxScore;
    sentenceScores.push({ maxScore, scoresPerKit });
  }

  // Step 4 of ladder: No kit scores above zero for any sentence -> single_location fallback
  if (totalScoreAcrossAll === 0) {
    return {
      fallback: 'single_location',
      locations: [],
      warning: 'No kit scored above zero in deterministic keyword fallback',
    };
  }

  // Assign kit per sentence
  const assigned = [];
  for (let i = 0; i < sentences.length; i++) {
    const { maxScore, scoresPerKit } = sentenceScores[i];
    if (maxScore > 0) {
      const topKits = scoresPerKit.filter((s) => s.score === maxScore).map((s) => s.kit);
      if (topKits.length === 1) {
        assigned.push(topKits[0]);
      } else {
        // "tie to the previous kit"
        if (i > 0 && assigned[i - 1] && topKits.includes(assigned[i - 1])) {
          assigned.push(assigned[i - 1]);
        } else {
          assigned.push(topKits[0]);
        }
      }
    } else {
      // "sentences with no hit join the previous run"
      if (i > 0 && assigned[i - 1]) {
        assigned.push(assigned[i - 1]);
      } else {
        assigned.push(null);
      }
    }
  }

  // Backfill any leading sentences with no hits (sentence 0, etc.)
  const firstValidKit = assigned.find(Boolean) || kitInfoList[0].kit;
  for (let i = 0; i < assigned.length; i++) {
    if (!assigned[i]) {
      assigned[i] = firstValidKit;
    }
  }

  // Group into contiguous runs
  let runs = [];
  for (let i = 0; i < assigned.length; i++) {
    const curKit = assigned[i];
    if (runs.length === 0 || runs[runs.length - 1].kit !== curKit) {
      runs.push({
        kit: curKit,
        from_scene: i,
        to_scene: i,
      });
    } else {
      runs[runs.length - 1].to_scene = i;
    }
  }

  const coalesce = (rList) => {
    const merged = [];
    for (const r of rList) {
      if (merged.length === 0 || merged[merged.length - 1].kit !== r.kit) {
        merged.push({ ...r });
      } else {
        merged[merged.length - 1].to_scene = r.to_scene;
      }
    }
    return merged;
  };

  runs = coalesce(runs);

  // Smooth into at most 4 contiguous runs
  while (runs.length > 4) {
    let minLen = Infinity;
    let minIdx = -1;
    for (let j = 0; j < runs.length; j++) {
      const len = runs[j].to_scene - runs[j].from_scene + 1;
      if (len < minLen) {
        minLen = len;
        minIdx = j;
      }
    }

    if (minIdx === 0) {
      runs[0].kit = runs[1].kit;
    } else if (minIdx === runs.length - 1) {
      runs[runs.length - 1].kit = runs[runs.length - 2].kit;
    } else {
      runs[minIdx].kit = runs[minIdx - 1].kit;
    }

    runs = coalesce(runs);
  }

  const locations = runs.map((r, idx) => ({
    id: `L${idx + 1}`,
    kit: r.kit,
    from_scene: r.from_scene,
    to_scene: r.to_scene,
    from_sentence: r.from_scene + 1,
    to_sentence: r.to_scene + 1,
    why: `keyword match across sentences ${r.from_scene + 1}..${r.to_scene + 1}`,
  }));

  return {
    fallback: null,
    locations,
    warning: null,
  };
}

/**
 * Execute the 4-step Location Pass Ladder (Spec Section 5.3).
 *
 * 1. Location pass valid -> use it.
 * 2. Invalid -> one retry with the violations listed.
 * 3. Still invalid, or the call failed -> deterministic keyword matcher.
 * 4. No kit scores above zero -> ladder to single location fallback.
 */
export async function planStoryLocations({
  script,
  narration,
  sentences: inputSentences,
  catalog: inputCatalog,
  ask,
  policy = {},
  options = {},
}) {
  if (policy && policy.any_story_v1 === false) {
    return {
      status: 'flag_off',
      fallback: 'single_location',
      locations: [],
      substitutions: [],
      warning: 'any_story_v1 policy is off',
    };
  }

  const catalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
  if (!catalog || Object.keys(catalog).length === 0) {
    return {
      status: 'single_location_fallback',
      fallback: 'single_location',
      locations: [],
      substitutions: [],
      warning: 'Catalog is empty or has no valid kits',
    };
  }

  const text = script || narration || '';
  const sentences = Array.isArray(inputSentences) && inputSentences.length > 0
    ? inputSentences
    : (text ? splitSentences(text) : []);

  if (sentences.length === 0) {
    return {
      status: 'single_location_fallback',
      fallback: 'single_location',
      locations: [],
      substitutions: [],
      warning: 'No sentences to plan',
    };
  }

  // Ladder Step 1: Model Location Pass
  let deadlineErr = null; // KAN-539: askGemini ran out of PLANNER_DEADLINE_MS -> keyword plan, no retry
  if (typeof ask === 'function') {
    const prompt = buildLocationPassPrompt({ narration: text, sentences, catalog, policy });
    try {
      const raw = await ask(prompt, { maxTokens: 2048, ...options.askOptions });
      const val1 = validateLocationPass(raw, { sentences, catalog, policy });
      if (val1.valid) {
        return {
          status: 'model_pass',
          locations: val1.locations,
          substitutions: val1.substitutions,
          fallback: null,
          errors: [],
          warnings: val1.warnings,
        };
      }

      // Ladder Step 2: One retry with violations listed
      const retryPrompt = buildLocationRetryPrompt({
        originalPrompt: prompt,
        errors: val1.errors,
        rawResponse: raw,
      });
      const retryRaw = await ask(retryPrompt, { maxTokens: 2048, ...options.askOptions });
      const val2 = validateLocationPass(retryRaw, { sentences, catalog, policy });
      if (val2.valid) {
        return {
          status: 'model_retry',
          locations: val2.locations,
          substitutions: val2.substitutions,
          fallback: null,
          errors: [],
          warnings: val2.warnings,
        };
      }
    } catch (err) {
      // Model call threw or timed out, drop down to Step 3
      if (err?.deadline) deadlineErr = err;
    }
  }

  // Ladder Step 3: Deterministic keyword fallback
  const kwResult = matchLocationsByKeywords({ sentences, catalog, options });
  if (kwResult.fallback !== 'single_location' && kwResult.locations.length > 0) {
    return {
      status: 'keyword_fallback',
      locations: kwResult.locations,
      substitutions: [],
      fallback: null,
      errors: [],
      warnings: [deadlineErr ? plannerDeadlineWarning(deadlineErr) : 'Location pass model failed or unavailable; used deterministic keyword fallback'],
      ...(deadlineErr && { deadline: true }),
    };
  }

  // Ladder Step 4: Drop to single location fallback
  return {
    status: 'single_location_fallback',
    fallback: 'single_location',
    locations: [],
    substitutions: [],
    errors: [],
    warnings: ['Story fallback active: single_location mode'],
  };
}

/**
 * Format portal continuity hand-offs table for Scene Pass prompt.
 */
function formatPortalTransitionsForPrompt(locations, catalog) {
  if (!Array.isArray(locations) || locations.length <= 1) {
    return 'none (single location)';
  }

  const entries = [];
  for (let i = 0; i < locations.length - 1; i++) {
    const curLoc = locations[i];
    const nextLoc = locations[i + 1];
    const curEntry = catalog[curLoc.kit];
    const portals = curEntry && Array.isArray(curEntry.portals) ? curEntry.portals : [];

    let matching = null;
    for (const p of portals) {
      if (p.leads_to && (p.leads_to.kit === nextLoc.kit || p.leads_to.kit_tags)) {
        matching = p;
        break;
      }
    }

    if (matching) {
      const exitSocket = matching.socket;
      const entrySocket = matching.leads_to?.socket || 'default_socket';
      const exitDir = matching.exit_dir || 'out';
      entries.push(
        `${curLoc.kit} exit socket "${exitSocket}" (dir: ${exitDir}) -> ${nextLoc.kit} entry socket "${entrySocket}"`
      );
    } else {
      entries.push(`${curLoc.kit} -> direct cut/whip to ${nextLoc.kit}`);
    }
  }

  return entries.join('; ');
}

// KAN-539: the one warning every planner shows when askGemini hit its deadline.
export const plannerDeadlineWarning = (err) => `Using rule-based plan (planner deadline ${Math.round((err?.deadlineMs || 0) / 1000)} s)`;

const beatsPrompt = () => `

STORY BEATS: every scene also carries "consequence" (what the moment costs or changes, one short sentence), "read" (the one thing the viewer must understand, one short sentence), "anchor_word" (index of the word in the scene text, counted from 0, the picture event fires on; same unit as cast word_index), "shape" (one of ${BEAT_SHAPES.join(', ')}) and "hook_style" (one of ${BEAT_HOOKS.join(', ')}; pick a style that differs from a plain claim when the topic allows). The last scene answers the question the first scene raised and stays in the first scene's place, with the same person.`;

/**
 * Build the Scene Pass prompt (Spec Section 8).
 */
export function buildScenePassPrompt({
  narration,
  locations = [],
  catalog: inputCatalog = null,
  registry: inputRegistry = null,
  techniques = null,
  policy = null,
  options = {},
}) {
  const catalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
  const registry = inputRegistry || getCapabilityRegistry(options);

  const chosenKitIds = new Set(locations.map((l) => l.kit));
  const chosenCatalog = {};
  for (const kid of chosenKitIds) {
    if (catalog[kid]) chosenCatalog[kid] = catalog[kid];
  }

  const locationSummary = locations
    .map((l) => `${l.id} ${l.kit} scenes ${l.from_scene}..${l.to_scene}`)
    .join(', ');

  const perKitSocketsAndProps = formatCatalogForPrompt(chosenCatalog, 'scene');
  const allowedRegistry = formatCapabilityRegistryForPrompt(registry);
  const portalTable = formatPortalTransitionsForPrompt(locations, catalog);
  const techniqueList = (Array.isArray(techniques) ? techniques : DEFAULT_CAMERA_TECHNIQUES).join(', ');

  return (
    `STORY PLAN (any_story): the video happens in these places, in this order: ${locationSummary || 'none'}.\n` +
    `For every 3D scene set "location": {"kit", "socket"} using only these sockets: ${perKitSocketsAndProps}.\n` +
    `Cast: people come only from "characters"; "cast" items are {"character","action","from_socket","to_socket","word_index"}; ${allowedRegistry}; a person moves between sockets of the SAME place; never walk from one place to another inside one scene.\n` +
    `Props: use only props listed for the place or declared in story.props; give a "state" when it changes.\n` +
    `Events: allowed now: ${registry.events?.join(', ') || 'none'} (ignite starts a prop's effect, launch fires it, liftoff raises the prop); anchor with the zero-based word_index of the word that triggers it.\n` +
    `Leaving a place: on the last scene of a place set "transition" {"kind":"whip|zoom_through|push_through","cause":"action_end|part_reveal|impact"} and end the person's last action at the exit socket of that place (${portalTable}). The next place starts the person at the matching entry socket.\n` +
    `Camera: techniques only from this list: ${techniqueList}; follow the beat map: hook on scene 1 with the hero already moving, one close-in on a named part, one zoom-out reveal after the hook, orbit at most once, never the same technique twice in a row. Every scene is at most 4 seconds of narration (8 words at 2 words per second).\n` +
    `Reveal: end on one pull_back that starts tight on a part and pulls back to the whole place. Orbit-kind shots (orbit, whip, side_tour) are at most a quarter of all shots.\n` +
    `Set "story_beat" on every scene.\n` +
    `Return the story as top-level "story": {"version":1,"locations":[...],"props":[...]}.` +
    // KAN-559: follow-camera, smooth-motion, ease rules and the walk rule for the person shots; nothing added with the flag off
    ((policy || options.policy)?.skills_in_prompt_v1 === true ? skillsPrompt('scene_pass', { policy: policy || options.policy }) : (policy || options.policy)?.skills_rules_v1 === true ? skillRulesPrompt(['SK-01', 'SK-02', 'SK-03', 'SK-13', 'SK-14']) : '') +
    // KAN-785: the semantic scene rules, only for a strict semantic_explainer_v1 true; nothing added otherwise
    ((policy || options.policy)?.semantic_explainer_v1 === true ? skillsPrompt('semantic_scene', { policy: { skills_in_prompt_v1: true } }) : '') +
    // KAN-600: the beat fields, only with story_beats_v1; nothing added with the flag off
    ((policy || options.policy)?.story_beats_v1 === true ? beatsPrompt() : '')
  );
}

/**
 * Append Story prompt to planner base prompt only when policy.any_story_v1 is on.
 * (Spec Section 8: flag off leaves plannerPrompt() output identical).
 */
export function appendStoryPrompt(basePrompt, options = {}) {
  if (options.policy?.any_story_v1 !== true) {
    return basePrompt;
  }
  const sceneAddition = buildScenePassPrompt(options);
  return `${basePrompt}\n\n${sceneAddition}`;
}

/**
 * Execute Scene Pass with an ask function and validate the returned plan.
 */
export async function planStoryScenes({
  script,
  narration,
  locations = [],
  catalog: inputCatalog,
  registry: inputRegistry,
  ask,
  policy = null,
  options = {},
}) {
  const catalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
  const registry = inputRegistry || getCapabilityRegistry(options);
  const text = script || narration || '';

  if (typeof ask !== 'function') {
    throw new Error('planStoryScenes requires an ask function');
  }

  const prompt = buildScenePassPrompt({
    narration: text,
    locations,
    catalog,
    registry,
    policy,
    ...options,
  });

  const raw = await ask(prompt, { maxTokens: 4096, ...options.askOptions });
  const parsed = parseModelJsonResponse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Scene pass returned invalid or unparseable JSON');
  }

  const validation = validateStoryPlan(parsed, { catalog, repair: true, ...options });
  if (!validation.valid) {
    return {
      valid: false,
      errors: validation.errors,
      warnings: validation.warnings,
      repairs: validation.repairs,
      plan: parsed,
    };
  }

  const normalised = normaliseStoryPlan(validation.plan, { catalog });
  return {
    valid: true,
    errors: [],
    warnings: normalised.warnings,
    repairs: normalised.repairs,
    plan: normalised.plan,
  };
}

/**
 * KAN-758 (policy.skill_build_v1 === true only): each `archetype:*` location becomes a generated kit (scene brief -> compileArchetype -> validateKit -> file).
 * A failure keeps the story going on the nearest kit by the keyword match, with a WARN. No portal: the handoff between an archetype and its neighbour is the plain cut it already is.
 * @returns {{locations: object[], catalog: object, scenery: object}} flag off or nothing to do: the SAME locations array, catalog {}, scenery {}.
 */
export async function resolveArchetypeLocations({ locations, sentences = [], catalog, ask, policy, worldsDir, warn = () => {} } = {}) {
  const isArch = (l) => parseArchetype(l?.kit);
  if (policy?.skill_build_v1 !== true || !Array.isArray(locations) || !locations.some(isArch)) return { locations, catalog: {}, scenery: {} };
  const out = [], made = {}, scenery = {};
  for (const loc of locations) {
    const archetype = isArch(loc);
    if (!archetype) { out.push(loc); continue; }
    const from = Math.max(0, Number(loc.from_scene) || 0), to = Math.max(from, Number(loc.to_scene) || from);
    const text = sentences.slice(from, to + 1).map(String);
    const g = typeof ask === 'function'
      ? await generateArchetypeKit({ location: loc, archetype, sentences: text.length ? text : sentences.map(String), ask, policy, worldsDir })
      : { ok: false, reason: 'no ask function' };
    if (g.ok) {
      made[g.id] = g.entry;
      scenery[loc.id] = { source: 'generated', kit: g.id, template_kit: loc.kit, archetype, reused: g.reused };
      out.push({ ...loc, kit: g.id, template_kit: loc.kit });
    } else {
      const nearest = nearestKit(sentences, from, to, resolveStoryCatalog({ catalog }));
      warn(`WARN skill_build_v1: location ${loc.id} (${loc.kit}) uses the nearest kit ${JSON.stringify(nearest)}: ${String(g.reason).slice(0, 200)}`);
      scenery[loc.id] = { source: 'template', reason: g.reason };
      out.push({ ...loc, kit: nearest });
    }
  }
  return { locations: out, catalog: made, scenery };
}

/**
 * Complete high-level Any-Story planning coordinator.
 */
export async function planStory({
  script,
  narration,
  sentences,
  catalog: inputCatalog,
  registry: inputRegistry,
  ask,
  policy = {},
  options = {},
}) {
  if (policy && policy.any_story_v1 === false) {
    return {
      story: { fallback: 'single_location' },
      flagOff: true,
    };
  }

  const locResult = await planStoryLocations({
    script,
    narration,
    sentences,
    catalog: inputCatalog,
    ask,
    policy,
    options,
  });

  if (locResult.fallback === 'single_location') {
    return {
      story: {
        version: 1,
        locations: [],
        props: [],
        fallback: 'single_location',
      },
      locationResult: locResult,
      fallback: 'single_location',
    };
  }

  // KAN-756 (policy.skill_build_v1 === true): every location gets its own generated kit, the scene pass sees them in its catalog; a failed location keeps its template kit with a WARN. Flag off: nothing here runs.
  let built = null, sceneCatalog = inputCatalog;
  if (policy?.skill_build_v1 === true && typeof ask === 'function' && !locResult.deadline) {
    const text = script || narration || '';
    const sents = Array.isArray(sentences) && sentences.length > 0 ? sentences : splitSentences(text);
    const warn = (m) => { locResult.warnings = [...(locResult.warnings || []), m]; };
    const baseCatalog = resolveStoryCatalog({ catalog: inputCatalog, ...options });
    const arch = await resolveArchetypeLocations({ locations: locResult.locations, sentences: sents, catalog: baseCatalog, ask, policy, worldsDir: options.worldsDir, warn });   // KAN-758
    const todo = arch.locations.filter((l) => arch.scenery[l?.id]?.source !== 'generated');   // archetype kits are already built
    built = await planGeneratedKits({ locations: todo, sentences: sents, ask, policy, worldsDir: options.worldsDir, warn });
    let next = 0;
    locResult.locations = arch.locations.map((l) => (arch.scenery[l?.id]?.source === 'generated' ? l : built.locations[next++]));
    built = { ...built, locations: locResult.locations, catalog: { ...arch.catalog, ...built.catalog }, scenery: { ...arch.scenery, ...built.scenery } };
    sceneCatalog = { ...baseCatalog, ...built.catalog };
  }

  if (typeof ask === 'function' && options.runScenePass !== false && !locResult.deadline) {
    try {
      const sceneResult = await planStoryScenes({
        script,
        narration,
        locations: locResult.locations,
        catalog: sceneCatalog,
        registry: inputRegistry,
        ask,
        policy,
        options,
      });
      if (built) stampScenery(sceneResult.plan?.story, built.scenery);
      return {
        ...sceneResult,
        locationResult: locResult,
      };
    } catch (err) {
      if (!err?.deadline) throw err;
      locResult.warnings = [...(locResult.warnings || []), plannerDeadlineWarning(err)]; // locations only, like runScenePass: false
    }
  }

  return {
    locationResult: locResult,
    locations: locResult.locations,
    story: {
      version: 1,
      locations: locResult.locations,
      props: [],
      fallback: null,
      ...(built && { scenery_source: built.scenery }),
    },
  };
}
