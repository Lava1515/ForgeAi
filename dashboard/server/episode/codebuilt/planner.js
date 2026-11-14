// Code-built planner (KAN-914/928/933): the host Claude CLI (subscription, askClaude through createStepRouter) writes the script, the brief
// and the topic-specific Blender Python that the offline worker runs. No API key, no agy build, no fixed placeholder scene: whatever the
// model returns is validated and handed on, and a reply that fails validation is retried once with the reasons, then refused.
//
//   planCodebuiltScript({ topic, duration, signal }, { onCall })                     -> { script, brief, pathPack, calls }
//   planCodebuiltBuild({ topic, duration, script, brief, words, pathPack, signal }, { onCall }) -> { buildScript, calls, shotStarts, nframes }
//
// Calls: every model call is recorded once. onCall receives the same objects that are returned in `calls` (start.js skips an object it
// already holds), shaped for cost_calls.json: { step, provider, model, wall_s, input_tokens, output_tokens, retries, ... }.
// input_tokens/output_tokens are null when the CLI reported none (never estimated).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { askClaude } from '../../routes/claudeCli.js';
import { createStepRouter } from '../../routes/stepTiers.js';
import { LENGTH_TOLERANCE_S, lengthCheck } from './lengthCheck.js';
import { SET_PICKER_TEXT, SET_MANUAL_TEXT, SET_NAMES, PROPS_MANUAL_TEXT, PROPS_PICKER_TEXT } from './setCatalog.js';
import { normalizeProductionChoices, scriptChoicesPrompt, buildChoicesPrompt, briefChoicesLine, isWhatIfTopic } from './productionChoices.js';
import { planShotCadence, shotCountRange, MIN_SHOT_S, MAX_SHOT_S, TARGET_SHOT_S } from './cadence.js';
import { storyDirection } from './storyDirection.js';
import { loadCodebuiltBuildSkill, loadCodebuiltGuides } from './skills.js';
import { phrasesOf, directionPrompt, checkDirection, directionShotStarts, directionMarkdown, directionLookShots, fallbackDirection, DirectionError } from './direction.js';

export const PLANNER_VERSION = 'codebuilt-planner-v2';
export { loadCodebuiltGuides };
export const BUILD_MODELS = Object.freeze(['Auto', 'Sonnet', 'Opus', 'Fable', 'Codex Sol']);
// The dashboard container mounts the server at /app/server and the repo at FORGEAI_ROOT (/forgeai); the file location alone resolves to '/'.
const repoRoot = process.env.FORGEAI_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const FPS = 30;
export const LEAD_S = 0.35; // blender_worker/codebuilt/timeline.py LEAD
export const TAIL_S = 1.5; // timeline.frame_count default tail
// Script length (KAN-933: preserve calibrated target and under-length guard; allow 10 seconds over request).
// The finished video is: the silence before the first word (ONSET_S) + the speech + the silence the voice stage keeps after the last word (TAIL_KEEP_S)
// + the kit's LEAD_S before and TAIL_S after the voice. So the speech has to fill (duration - FIXED_VIDEO_S) seconds, and the words that fill it come
// from the measured pace of the real TTS voice, which is NOT constant: it slows down as the script gets longer. Measured on real runs
// (output/agent-jobs/.start/*/words.json, speech = first word start to last word end): 97 words 2.98 w/s, 144-145 words 2.96-2.99, 176-180 words 2.85-2.87,
// 291 words 2.70. The old flat 3.0 w/s produced 110.2 s for a 90 s request (291 words) and 65.6 s for a 60 s request (180 words).
export const TAIL_KEEP_S = 0.3; // voice.js LIMITS.tailKeepSeconds: silence kept after the last word
export const ONSET_S = 0.2; // measured: the first word starts 0.18 to 0.26 s into vo.wav
export const FIXED_VIDEO_S = LEAD_S + TAIL_S + TAIL_KEEP_S + ONSET_S;
// voice.js LIMITS.lastWordExtendMaxSeconds / tailGuardSeconds: a clipped last word is extended to the audible end by at most 1 s, and the tail is then cut 0.1 s after the sound
// instead of 0.3 s after the word, so the finished video can be up to 0.8 s longer than the words say. The window below reserves that full bound.
export const LAST_WORD_EXTEND_MAX_S = 1.0;
export const TAIL_GUARD_S = 0.1;
export const LAST_WORD_EXTENSION_RESERVE_S = 0.8;
export const worstCaseExtensionSeconds = () => LAST_WORD_EXTEND_MAX_S - (TAIL_KEEP_S - TAIL_GUARD_S);
// Measured speech pace (words per second) for the script length each request needs. Longer scripts speak slower; 30 and 45 s extend the short-script data (97-145 words).
export const WORDS_PER_SECOND_BY_DURATION = Object.freeze({ 30: 2.98, 45: 2.98, 60: 2.9, 90: 2.75 });
export const wordsPerSecond = (duration) => WORDS_PER_SECOND_BY_DURATION[Number(duration)] ?? 2.9;
/** Seconds of the finished video that a script of `words` words is expected to give for a request of `duration` seconds. */
export const predictedVideoSeconds = (words, duration) => Number(words) / wordsPerSecond(duration) + FIXED_VIDEO_S;
// Lengths the code-built start accepts (same list as start.js DURATIONS).
export const PLANNER_DURATIONS = Object.freeze([30, 45, 60, 90]);
// Keep the existing 4 % under-request script guard. The upper word window leaves room for the bounded last-word extension
// while respecting the owner's 10-second measured-video overrun tolerance.
export const SCRIPT_LENGTH_BAND = Object.freeze({ under: 0.04, over: LENGTH_TOLERANCE_S });
export const SCRIPT_OVER_TARGET = 0.06;
export { LENGTH_TOLERANCE_S, lengthCheck };
const MAX_ATTEMPTS = 2;
// Writing the whole Blender build script takes a model several minutes; the CLI default of 300 s killed the real 60 s run (2026-11-13).
// 45 minutes since 2026-11-14: the first directed build (job mwg20ivw-ea1a19) took 29.6 minutes to answer and its reply was thrown away at 20.
export const BUILD_TIMEOUT_MS = 45 * 60 * 1000;

export class PlannerError extends Error {
  constructor(code, message, reasons) { super(message); this.name = 'PlannerError'; this.code = code; if (Array.isArray(reasons)) this.reasons = reasons; }
}
// Bounded, content-free diagnosis of one reply check: the validator's own static reason strings and code, never the reply, prompt or narration.
const MAX_REASONS = 20;
const MAX_REASON_CHARS = 200;
const safeReason = (reason) => {
  const text = String(reason);
  if (text.startsWith('import not allowed:')) return 'import not allowed';
  if (text.startsWith('Python syntax error,')) return 'Python syntax error';
  return text.slice(0, MAX_REASON_CHARS);
};
const diagnosisOf = (error, failed = false) => {
  if (!failed) return { ok: true };
  if (!(error instanceof PlannerError)) return { ok: false, code: 'CHECK_ERROR', reasons: [] }; // arbitrary exception text is not copied
  const list = Array.isArray(error.reasons) && error.reasons.length ? error.reasons : [error.message];
  return { ok: false, code: String(error.code).slice(0, 60), reasons: list.slice(0, MAX_REASONS).map(safeReason) };
};
const abortError = () => Object.assign(new PlannerError('ABORTED', 'Aborted'), { aborted: true });
const wordCount = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;

/** The real path pack: paths/codebuilt.json. Missing or malformed is a hard failure, never a stand-in. */
export function loadCodebuiltPathPack({ pathsDir = path.join(repoRoot, 'paths') } = {}) {
  const file = path.join(pathsDir, 'codebuilt.json');
  let pack;
  try { pack = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^ï»¿/, '')); } catch (error) {
    throw new PlannerError('PATH_PACK_MISSING', `The code-built path pack (paths/codebuilt.json) is missing or unreadable (${error.code ?? 'parse'})`);
  }
  if (!pack || pack.id !== 'codebuilt' || !Array.isArray(pack.skills) || !pack.skills.length || !Array.isArray(pack.rules?.playbook) || !pack.rules.playbook.length) {
    throw new PlannerError('PATH_PACK_INVALID', 'paths/codebuilt.json is not a valid code-built path pack (id, skills and rules.playbook are required)');
  }
  return pack;
}

/** JSON from a model reply: raw JSON, a ```json fence, or the first balanced object inside prose. */
export function parseModelJson(text) {
  const s = String(text ?? '').trim();
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  throw new PlannerError('BAD_JSON', 'The model reply was not valid JSON');
}

/** Python source from a model reply: the longest fenced block, or the whole text when it is unfenced. */
export function extractPython(text) {
  const s = String(text ?? '');
  const blocks = [...s.matchAll(/```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
  const code = blocks.length ? blocks.sort((x, y) => y.length - x.length)[0] : s;
  return code.replace(/\r\n/g, '\n').trim() + '\n';
}

// ---- timing --------------------------------------------------------------------------------------------------------------------------------------------

const num = (v) => typeof v === 'number' && Number.isFinite(v);
function checkWords(words) {
  if (!words || !num(words.dur) || words.dur <= 0 || !Array.isArray(words.words) || !words.words.length
    || words.words.some((w) => !w || typeof w.w !== 'string' || !num(w.s) || !num(w.e) || w.e < w.s)) {
    throw new PlannerError('BAD_WORDS', 'words must be the measured { dur, words: [{ w, s, e }] } list from the voice stage');
  }
}
/** Same arithmetic as timeline.frame_count: int((dur + LEAD + TAIL) * FPS). */
export const frameCountFor = (words) => Math.trunc((words.dur + LEAD_S + TAIL_S) * FPS);
/**
 * Word-aligned shot starts (seconds in video time, lead included), first at 0: 2 to 6 s shots (about 4.5 s) that tile the whole rendered video,
 * lead and tail included, so the count follows the measured voice (7 to 8 shots for 30 to 40 s). The final profile renders every frame (hold=1), so cuts may sit on any frame.
 */
export function shotStartsFor(words) {
  checkWords(words);
  try { return planShotCadence(words, LEAD_S, { tail: TAIL_S, fps: FPS }); }
  catch (error) { throw new PlannerError('BAD_WORDS', error.message); }
}
/** Each shot's window in video seconds ([start, end), the last ends with the video) and the measured words spoken inside it. */
export function shotWindows(words, shotStarts) {
  const end = frameCountFor(words) / FPS;
  return shotStarts.map((start, i) => {
    const stop = i + 1 < shotStarts.length ? shotStarts[i + 1] : end;
    const inside = words.words.filter((w) => w.s + LEAD_S >= start - 1e-9 && w.s + LEAD_S < stop - 1e-9).map((w) => w.w);
    return { index: i, start, end: Math.round(stop * 1000) / 1000, words: inside };
  });
}

// ---- model calls ---------------------------------------------------------------------------------------------------------------------------------------

function makeAsker(deps, step, onCall) {
  const all = [];
  const askFn = deps.askFn ?? ((prompt, options) => askClaude(prompt, { ...options, structured: true, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) }));
  // The router reports a failed or timed-out attempt only through its recorder, then rethrows; keep that record so the attempt is costed.
  let failed = null;
  const router = createStepRouter({ askFn, models: deps.models, now: deps.now, forcedTier: deps.forcedTier, onCallRecord: (entry) => { if (entry?.status === 'error') failed = entry; } });
  const toCall = (rec, retries) => ({
    step, provider: 'claude', model: rec.model, tier: rec.tier, wall_s: rec.wall_s, input_tokens: rec.tokens?.input ?? null, output_tokens: rec.tokens?.output ?? null,
    retries, escalated: rec.escalated === true, trigger: rec.trigger ?? null, status: rec.status, ...(rec.forced === true ? { forced: true } : {}),
    ...(rec.validation ? { validation: rec.validation } : {}),
  });
  const emit = (call) => {
    all.push(call);
    if (typeof onCall === 'function') { try { onCall(call); } catch { /* recorder failures never break a call */ } }
  };
  return {
    calls: all,
    /** Asks the model, retrying once with the validation reasons. `check(text)` returns the parsed value or throws PlannerError. */
    async run(prompt, check, signal) {
      let feedback = '';
      let last;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw abortError();
        let record;
        let answer;
        failed = null;
        try {
          ({ answer, record } = await router.ask(step, feedback ? `${prompt}\n\nYour previous reply was refused: ${feedback}\nFix every point and answer again in full.` : prompt));
        } catch (error) {
          // A failed or timed-out call still used time (a build call can run 20 minutes): record it with status 'error' and no tokens.
          if (failed) emit(toCall({ ...failed, tokens: null }, attempt));
          if (signal?.aborted) throw abortError();
          throw error;
        }
        // Check first so the one persisted record of this call already carries why the reply was accepted or refused.
        let value;
        let checkError = null;
        let checkFailed = false;
        try { value = check(typeof answer === 'string' ? answer : String(answer?.text ?? '')); } catch (error) { checkFailed = true; checkError = error; }
        emit(toCall({ ...record, validation: diagnosisOf(checkError, checkFailed) }, attempt));
        if (signal?.aborted) throw abortError();
        if (!checkFailed) return value;
        if (!(checkError instanceof PlannerError)) throw checkError;
        last = checkError; feedback = checkError.message;
      }
      throw new PlannerError(last.code, `The model reply was refused after ${MAX_ATTEMPTS} attempts: ${last.message}`);
    },
  };
}

// ---- script --------------------------------------------------------------------------------------------------------------------------------------------

/** Keep action and composition moving throughout every requested duration. */
export const SHORT_PACING_DURATIONS = Object.freeze(PLANNER_DURATIONS);
export function pacingRule(duration) {
  if (!SHORT_PACING_DURATIONS.includes(Number(duration))) return '';
  return `Pacing for a ${duration}-second short: keep meaningful subject action and composition changes happening from the opening through the final second. Shots last ${MIN_SHOT_S} to ${MAX_SHOT_S} s (about ${TARGET_SHOT_S} s on average), so the cut changes the view; the view must change every 2 to 4 seconds and no view may hold longer than 4 seconds, so inside any shot longer than 4 s change the camera angle, distance, subject action, or reveal once more. Avoid repeating the same action or composition, especially near the ending; plan the final 25 seconds as distinct progressing beats. Keep essential action and labels within safe margins, with clear space from every frame edge.`;
}
/** Shot counts the script may list: a request of `duration` seconds produces a finished video of about duration - 4 % up to duration + the length tolerance. */
export const scriptShotRange = (duration) => {
  const d = Number(duration);
  const range = shotCountRange(d);
  return { min: shotCountRange(d * (1 - SCRIPT_LENGTH_BAND.under)).min, target: range.target, max: shotCountRange(d + SCRIPT_LENGTH_BAND.over).max };
};
// How fast each built-in voice really speaks, in words per second of narration (voice.json duration, pauses included). The script length
// has to follow the voice: the first video of 2026-11-14 used eric, who took 75 s for a 130-word script written for a 45 s video
// (job mwg1o6h5-6f5a74, stopped as too_long). Measured on real jobs: aiden 2.78 (146 words in 52.5 s), ryan 2.57, dylan 2.61, eric 2.27.
// eric was first entered as 1.73 from that 75 s recording, but the recording held long silences from badly voiced sentences; with the
// pace gate on, the same voice read 77 words in 34.0 s (job mwg5e6hs-e826b9).
// The others are estimated from the same-script samples of 2026-11-14 (output/temp/voice-samples) scaled to aiden, and are marked so.
export const VOICE_WORDS_PER_SECOND = Object.freeze({
  aiden: 2.78, ryan: 2.57, dylan: 2.61, eric: 2.27, serena: 2.05, // serena measured on job mwg83rd6-959255 (112 words in 54.6 s)
  vivian: 2.0, uncle_fu: 2.1, sohee: 2.2, ono_anna: 2.4, // estimated, and lowered: the first estimate for serena (2.56) was a quarter too fast
});
export const DEFAULT_VOICE_WORDS_PER_SECOND = 2.6;
/** Words per second the script length is planned for: the voice's measured pace when the voice is known, else the duration table. */
/** A pace measured on this job's own first recording (words per second), when it is a sane number; it wins over the table. */
const measuredPaceOf = (pace) => (typeof pace === 'number' && Number.isFinite(pace) && pace >= 1 && pace <= 5 ? pace : null);
export const scriptPace = (duration, voice, pace) => measuredPaceOf(pace) ?? (typeof voice === 'string' && Object.hasOwn(VOICE_WORDS_PER_SECOND, voice) ? VOICE_WORDS_PER_SECOND[voice] : voice ? DEFAULT_VOICE_WORDS_PER_SECOND : wordsPerSecond(duration));
export const targetWords = (duration, voice, pace) => Math.round((Number(duration) - FIXED_VIDEO_S) * scriptPace(duration, voice, pace));
export const wordWindow = (duration, voice, pace) => {
  const d = Number(duration);
  const paceUsed = scriptPace(d, voice, pace);
  const target = targetWords(d, voice, pace);
  // The tolerance of 10 s over the request is for what the voice does with the script, not an invitation to write more: the three
  // 45 s scripts of 2026-11-13 all came back at 146 words (target 127) and their videos ran 51.6, 54.3 and 58.6 s, because the
  // real voices spoke 2.6 to 2.8 words per second, slower than the calibrated pace. The script may exceed its target by 6 percent.
  return {
    target,
    min: Math.ceil((d * (1 - SCRIPT_LENGTH_BAND.under) - FIXED_VIDEO_S) * paceUsed - 1e-9),
    max: Math.min(Math.floor((d + SCRIPT_LENGTH_BAND.over - LAST_WORD_EXTENSION_RESERVE_S - FIXED_VIDEO_S) * paceUsed + 1e-9), Math.ceil(target * (1 + SCRIPT_OVER_TARGET))),
  };
};
const compact = (pack) => ({ id: pack.id, skills: pack.skills.map((s) => s.skill), playbook: pack.rules.playbook, steps: pack.rules.steps });

// The checked registry snapshot (setCatalog.js) keeps planner import independent of Python and the working directory.

/** Guidance text for one step from the pack's project skills; '' when the pack assigns none or a file is missing (a prompt never fails on guidance). */
function guidesFor(pack, step) {
  try { return loadCodebuiltGuides({ pack, step }); } catch { return ''; }
}

function scriptPrompt({ topic, duration, pack, choices, voice, pace }) {
  const { target, min, max } = wordWindow(duration, voice, pace);
  const count = scriptShotRange(duration);
  const guides = guidesFor(pack, 'script');
  return `You write the narration for a ${duration}-second vertical 3D explainer short for a faceless channel. Every picture is later built from code in Blender in a bright toy-like style (simple people, vehicles, animals, buildings, landscapes, planets, cutaways), so write a story a viewer can SEE: things that happen to someone or something, in places, with a beginning, a turn and an ending.
Topic: ${JSON.stringify(topic)}
${scriptChoicesPrompt(choices)}${storyDirection(choices?.type ?? (isWhatIfTopic(topic) ? 'whatif' : 'factual'))}
Reply with ONE JSON object and nothing else: {"script": string, "shots": [{"narration": string, "subject": string, "action": string}, ...], "brief": string}
- script: the spoken narration, plain sentences, no stage directions, no markdown, about ${target} words (at least ${min} and at most ${max}; the voice speaks about ${scriptPace(duration, voice, pace)} words per second; stay close to the target, a longer script makes the video too long). The first sentence is the hook: the question or the most surprising fact, in 12 words or fewer. Then one idea per sentence, short sentences (most under 14 words), concrete nouns and numbers instead of adjectives, "you" where it fits. Each sentence should name something that can be shown. Only facts you are sure of; name a simplification as one. A "what if" is already understood as imaginary: say so at most once, in passing, and never spend a sentence on disclaimers ("scientists do not expect this", "luckily this cannot happen") or on reassuring the viewer; follow the consequences instead, each one bigger than the last. End on a pay-off: the answer, a twist or a line that returns to the opening, never a summary or "so that is why".
- shots: the visual beats in order, about ${count.target} (at least ${count.min}, at most ${count.max}), one idea per beat. Each: the narration it covers (quoted from script; together they cover the whole script in order), in subject the thing the viewer watches and the place it is in, and in action what visibly happens to it. Think in a few places (2 to 5 for the whole video) that the story returns to, not a new place for every sentence. A director turns these beats into the final shot list after the voice is recorded.
- brief: 3 to 6 sentences for the director: the idea of the video, the recurring character or object, the places, the palette and mood.
${pacingRule(duration) ? `- ${pacingRule(duration)}
` : ''}${guides ? `Guidance for this step (project skills):\n${guides}\n` : ''}Production playbook: ${JSON.stringify(compact(pack).playbook)}`;
}

function checkScript(duration, voice, pace) {
  const { target, min, max } = wordWindow(duration, voice, pace);
  const shotRange = scriptShotRange(duration);
  return (text) => {
    const v = parseModelJson(text);
    if (typeof v.script !== 'string' || !v.script.trim()) throw new PlannerError('BAD_SCRIPT', 'script must be a non-empty string');
    if (/[#*`]|\[[^\]]*\]/.test(v.script)) throw new PlannerError('BAD_SCRIPT', 'script must be plain spoken sentences: no markdown or bracketed directions');
    const n = wordCount(v.script);
    if (n < min || n > max) throw new PlannerError('BAD_SCRIPT', `script has ${n} words; a ${duration} s short needs about ${target} (${min} to ${max}); ${n < min ? `add at least ${min - n}` : `cut at least ${n - max}`} words`);
    if (!Array.isArray(v.shots) || v.shots.some((s) => !s || [s.narration, s.subject, s.action].some((x) => typeof x !== 'string' || !x.trim()))) {
      throw new PlannerError('BAD_SCRIPT', 'shots must be a list of objects with narration, subject and action');
    }
    if (v.shots.length < shotRange.min || v.shots.length > shotRange.max) {
      throw new PlannerError('BAD_SCRIPT', `shots has ${v.shots.length} entries; a ${duration} s short of 2 to 6 s shots needs about ${shotRange.target} (${shotRange.min} to ${shotRange.max})`);
    }
    if (typeof v.brief !== 'string' || wordCount(v.brief) < 12) throw new PlannerError('BAD_SCRIPT', 'brief must be a few sentences');
    return v;
  };
}

export function briefMarkdown(topic, duration, v, choices = null) {
  const shots = v.shots.map((s, i) => `${i + 1}. Subject: ${s.subject.trim()}\n   Action: ${s.action.trim()}\n   Narration: ${s.narration.trim()}`).join('\n');
  return `# ${topic}\n\nTarget length: ${duration} s, vertical 9:16.\n\n${briefChoicesLine(choices)}${v.brief.trim()}\n\n## Shots\n${shots}\n`;
}

/** The batch's validated { genre, theme, type }, or null for a single job. Anything else is refused: a choice is never silently dropped. */
function choicesOf(input) {
  if (input.choices === undefined || input.choices === null) return null;
  try { return normalizeProductionChoices(input.choices); } catch { throw new PlannerError('BAD_REQUEST', 'choices must be { genre, theme, type } with a known type'); }
}

export async function planCodebuiltScript(input = {}, deps = {}) {
  const topic = String(input.topic ?? '').trim();
  const duration = Number(input.duration);
  if (!topic) throw new PlannerError('BAD_REQUEST', 'topic is required');
  if (!PLANNER_DURATIONS.includes(duration)) throw new PlannerError('BAD_REQUEST', 'duration must be 30, 45, 60 or 90');
  if (input.signal?.aborted) throw abortError();
  const choices = choicesOf(input);
  const pathPack = loadCodebuiltPathPack(deps);
  const asker = makeAsker(deps, 'script', deps.onCall);
  const voice = typeof input.voice === 'string' ? input.voice : undefined;
  const v = await asker.run(scriptPrompt({ topic, duration, pack: pathPack, choices, voice, pace: input.pace }), checkScript(duration, voice, input.pace), input.signal);
  return { script: v.script.trim(), brief: briefMarkdown(topic, duration, v, choices), shots: v.shots, pathPack, calls: asker.calls };
}

// ---- build ---------------------------------------------------------------------------------------------------------------------------------------------

/** Same text as shotcheck.SHOT_VARIETY_RULE in blender_worker/codebuilt/shotcheck.py (a test compares them). */
export const SHOT_VARIETY_RULE = 'Shot variety: no two shots within two of each other may share one composition. Between those shots change at least one of: camera side (azimuth 30 degrees or more), height (elevation 12 degrees or more), or distance/lens scale (25 percent or more). Place content so it reaches the upper third as well as the middle (an empty top third is reported as a warning only; it does not block). Keep every readout and equation fully inside the text safe area (shotcheck.TEXT_SAFE) at every frame.';

/** The kit as the worker sees it (blender_worker/codebuilt). Kept next to the checks that depend on it; a test compares it with the Python files. */
export const KIT_CONTRACT = `Blender 5.x headless, offline. The kit is importable after:  import sys; sys.path.insert(0, '/kit')  then  from blender_worker.codebuilt import meshes, materials, stage, timeline, renderloop, shotcheck, mathx, figures, props; from blender_worker.codebuilt.sets import city_street (and any of globe, polar_penguin, tunnel, cutaway_planet, xray_body, room, bathroom that you use)
READY SETS. Each module's build(origin=(x, y, z)) builds one complete lit location in its OWN new collection and returns a handles dict. What each makes, the handles it returns and camera poses that are known to frame it:
${SET_MANUAL_TEXT}
Rules for sets: (1) use a set only as the place it really is; (2) call build once per place and keep the handles; h['collection'] is that place's collection: register it as colls['place-<id>'] = h['collection'] and link your own extra objects for that place into it (pass h['collection'] as the collection argument); (3) reach parts ONLY through the handles named above, never by searching bpy.data.objects by size, type or name; (4) sets are made to be seen from the -Y side: keep the camera at a smaller y than the subject and start from the tested poses (the space sets have a backdrop card and stars about 45 m behind the subject, at +Y: never move the camera behind the subject); (5) handles have different types: most are Blender objects (hide one with obj.scale = (0, 0, 0)); a person handle (city_street hero, each item of people, tunnel figure) is a figures rig dict, so move it with figures.pose and hide it with rig['root'].scale = (0, 0, 0); a list handle (cars, palms, clouds, bergs, readouts, ghost) is a list of such items; buildings is a list of (x, height) numbers, period, radii, acid_level, wall_y and the *_params are numbers, and water_verts is a function: these are data, not objects.
PROPS for places you build yourself (all take the collection first):
${PROPS_MANUAL_TEXT}
A custom place: c = meshes.coll(scene, 'place-<id>'), then at that place's own origin a props.sky (or props.stars for space), a props.ground or floor, a backdrop that reaches the horizon (props.hills, props.mountain, a row of props.building or props.tree), 4 to 8 props around the action, the subject, and lights (stage.sun 2 to 4 for daylight plus one stage.area fill; area lights of 5,000 to 20,000 W at 20 to 40 m; check exposure in the preview).
Figure API (actual signatures): figures.make_person(c, i) -> rig dict with root, arms, legs (1.8 m tall, feet at the root, faces -Y); figures.pose(fig, pos, eul, arms=(0, 0.12, 0, 0.12), legs=(0, 0), s=1.0, center=False) (arms = left swing, left out, right swing, right out in radians; legs = swings; a walk: legs=(0.5*sin(t*8), -0.5*sin(t*8)) with opposite arm swing; center=True poses about the body centre for tumbling); figures.flail(t, sp=9.0) -> (arms, legs).
- stage.reset_scene() -> scene (empties file). Do NOT call stage.setup_render (it is EEVEE/GPU); configure Cycles on the CPU yourself: scene.render.engine='CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=8..16; scene.render.resolution_x,y = 1080,1920; resolution_percentage=100; image_settings.file_format='PNG'; scene.view_settings.view_transform='Standard'; scene.render.fps=30; scene.frame_start,end=1,NFRAMES. World: scene.world = bpy.data.worlds.new(..); use_nodes=True; set the 'Background' node inputs[0] (rgba) and inputs[1] (strength).
- meshes.set_verts(obj, verts) replaces a mesh's vertices for one frame (waves, deforming shapes).
- meshes.coll(scene, name) -> collection;  meshes.ball(name, r, mat, c, loc=(0,0,0), scale=(1,1,1), nu=32, nv=16);  meshes.box(name, c, mat, loc, size=(x,y,z) half-extents, bevel=0.06);  meshes.lathe(name, profile=[(radius, z),...], mat, c, n=48);  meshes.sweep(name, pts=[(x,y,z),..], radii=[..], mat, c) -> (obj, path);  meshes.grid(name, nu, nv, fn(u,v)->(x,y,z), mat, c);  meshes.plane(name, mat, c, loc, size);  meshes.mk(name, verts, faces, mat, c);  meshes.empty(c, name, parent=None, loc=(0,0,0)). All return Blender objects (set .location/.rotation_euler/.scale per frame).
- materials.pbr(name, (r,g,b), rough=0.5, alpha=1.0, **principled_inputs);  materials.emit(name, (r,g,b), strength=1.0);  materials.noise_mat(name, c1, c2, rough, scale);  materials.backdrop_mat(name, center, edge).
- stage.area(c, name, pos, target, energy, size);  stage.sun(c, name, pos, target, energy);  stage.Camera(scene) with .set(pos, target, lens=50, roll=0, fstop=None, focus=None) and .obj (aim the camera ONLY with .set(pos, target, ...) in every shot function: it records the target that shotcheck.run_qa judges shot variety by; never set cam.obj.location or its rotation yourself);  stage.mark_scenery(obj, ...) marks a floor, wall or sky as scenery (unmarked meshes count as subject content);  stage.text(c, name, body, size, mat, loc) (upright 3D text facing -Y);  stage.hud_text(c, name, body, size, mat, w, h, plate_mat) + stage.hud(cam, obj, x, y, dist, scale) for a readout in front of the camera.
- mathx: clamp, lerp, smoothstep, ss(a, b, t) (smooth 0..1 between a and b), out_back.
- timeline.apply_frame(f, shots, colls, fps) where shots = [(start_seconds, collection_name, fn(t_seconds)), ...] ascending, colls = {collection_name: collection}; it hides every other collection and calls the active shot's fn(t).
- renderloop.render_frames(frames, out_dir, apply, render_fn, skip_existing=False, hold=1, require_qa=True) writes out_dir/NNNN.png (4 digits, zero based); out_dir must be absolute. hold=1 is required for final renders: render every frame at 30 unique frames per second without copying held frames. require_qa=True is required: it refuses to pose or render anything (shotcheck.QAError) until shotcheck.run_qa has passed.
- shotcheck.run_qa(scene, cam, apply, nframes, shots, hold=1) -> report (pass hold=1 explicitly: its default is 2 and require_qa refuses a render_frames hold that run_qa did not pose): poses every rendered frame with your apply(f) WITHOUT rendering, then raises shotcheck.QAError, so nothing renders, when a readout or equation leaves the text safe area at any frame, when two shots within two of each other share one composition (camera side, height and distance/lens all too close), or when a shot never aimed the camera with cam.set(...) (no target recorded). Variety is judged from the pos and target you give cam.set, not from where meshes are. A top third with no subject content is only a printed warning (it does not block; objects marked with stage.mark_scenery do not count as content). shots is the same [(start_seconds, collection_name, fn), ...] list you give timeline.apply_frame. It is the only shotcheck name a build may use.
- Nothing in the kit is keyframed: pose every object and camera as a pure function of time t inside the shot functions, so any frame renders alone.`;

function buildPrompt({ topic, duration, script, brief, words, pack, shotStarts, nframes, choices, skillGuidance = '', direction = null }) {
  const wordLine = words.words.map((w) => `${w.w}@${w.s.toFixed(2)}-${w.e.toFixed(2)}`).join(' ');
  const n = shotStarts.length;
  const videoSeconds = nframes / FPS;
  const placeNames = direction ? direction.places.map((p) => `'place-${p.id}'`).join(', ') : '';
  const windowLines = direction
    ? directionMarkdown(direction, shotStarts, videoSeconds)
    : shotWindows(words, shotStarts).map((w) => `shot-${w.index}: ${w.start} to ${w.end} s (${Math.round((w.end - w.start) * 100) / 100} s), narration: ${JSON.stringify(w.words.join(' '))}`).join('\n');
  const item3 = direction
    ? `3. PLACES AND SHOTS. Build each place of the direction ONCE, as one collection, registered under exactly these names: ${placeNames} (colls = {'place-<id>': collection, ...}; a custom place is meshes.coll(scene, 'place-<id>'), a ready set is h['collection'] of its build call). Give every place its own origin at least 600 m from the others (place k at (600 * k, 0, 0)) and its own lights inside its collection, so no place shows or lights another. The shots list has exactly ${n} entries, shots = [(SHOT_STARTS[i], 'place-<id>', shot_i), ...], shot i using the place the direction names for it; several shots share a place. Because places are shared, every shot function starts by calling a reset function for its place that puts every animated object of that place into its rest pose and hides (scale (0, 0, 0)) everything that belongs only to other shots; then it poses what this shot needs from t. Build what the direction says for each shot: the subject it names, LARGE (a third to two thirds of the frame height, in the middle 60 percent of the frame), the action it names actually happening across the shot, and the camera move it names. A shot longer than 4 s has two beats: change the camera framing or the action once more inside it. A generic floor-and-wall box, an empty stage or a subject too small to read is a failure. Keep text out of the top 10 and bottom 22 percent of the frame (captions are burned in at 68 to 80 percent of the frame height from the top: keep the subject's important part above that band).`
    : `3. ${n} shots, ${n} collections named ${shotNames(n)} (meshes.coll), one per entry of SHOT_STARTS (a helper function that builds one shot into a collection and is called once per shot is fine; a shot may reuse a place with a new camera and action). Give every shot a real place: build a relevant named environment from the available sets in that shot's collection, with visible scenery geometry and depth filling the composition, then add the story's subject and characters where appropriate. The subject, place details, colours and motion must illustrate THIS topic and narration. A generic floor/wall/box backdrop or empty stage is a failure. Make the main action readable in the middle 60 percent of the frame and keep text out of the top 10 and bottom 20 percent.`;
  return `Write the COMPLETE Blender Python build script for a ${duration}-second vertical (9:16) 3D explainer short. It is run as-is by the offline worker with the kit below. A director then looks at preview frames of your script and asks for fixes, so make every shot readable on the first try: subject large and lit, camera above the ground, inside the place's sky dome and outside every solid object and plate, nothing important cut by the frame edge.
Topic: ${JSON.stringify(topic)}
${buildChoicesPrompt(choices)}
Script (already recorded as narration): ${JSON.stringify(script)}
The writer's brief:\n${brief}
Measured word times (seconds from the start of vo.wav; the video plays vo.wav ${LEAD_S} s after frame 0, so a word at w seconds is heard at w + ${LEAD_S} s of video time): ${wordLine}
Measured voice duration: ${words.dur} s. Frame count is fixed: NFRAMES = ${nframes} at ${FPS} fps (${videoSeconds.toFixed(2)} s).
Shot start times in video seconds, placed on phrase starts of the measured voice: SHOT_STARTS = [${shotStarts.join(', ')}]. That is ${n} shots covering the whole video, from frame 0 to the last frame; the last shot runs to the end of the video.
${direction ? 'The director\'s shot list. It is binding: build these places and these shots.' : 'The shots, with the words each one carries:'}
${windowLines}

Hard requirements (a script that breaks any of them is refused):
1. Output ONLY the Python source in one \`\`\`python block. No explanation. Keep it compact: aim for 500 to 800 lines and stay under 55,000 characters. Build places from props and set calls plus a few primitives for what is special to the story, share small helpers (ease, lerp3, one reset per place), and write each shot function in 15 to 35 lines. Do not deliberate at length before writing: the direction has already decided what each shot shows.
2. Put these constants at the top, with exactly these values: FPS = ${FPS}, NFRAMES = ${nframes}, SHOT_STARTS = [${shotStarts.join(', ')}], OUT = '/job/frames'.
${item3}
4. Drive every in-shot event (a readout appearing, an object launching, a light changing, the second beat of a shot) from the measured word times above (hard-code the video seconds you chose from them: word time + ${LEAD_S}), never from guessed times. Each shot function receives t in VIDEO seconds (not seconds since the shot started): use local = t - SHOT_STARTS[i] for motion inside the shot. Something must visibly move or change in every shot from its first frame to its last; a still picture with a drifting camera is not enough.${pacingRule(duration) ? ` ${pacingRule(duration)}` : ''}
5. Render the FINAL profile at 1080x1920, 100%, 30 fps, Cycles CPU with 8..16 samples, PNGs via renderloop.render_frames(range(NFRAMES), OUT, apply, render_fn, skip_existing=False, hold=1, require_qa=True). Set scene.render.resolution_x=1080, resolution_y=1920, resolution_percentage=100, scene.render.fps=30 and scene.cycles.samples to an integer from 8 through 16. Use the absolute path OUT = '/job/frames'. The call MUST pass literal hold=1 and require_qa=True: render every frame uniquely; do not duplicate or hold frames. Motion must be a smooth function of time. The pre-render QA of item 7 must use the same hold=1.
6. Import only: bpy, math, sys, os (os.path only), numpy, mathutils, and the kit. No network, subprocess, eval/exec, __import__, file writes other than the render output, or GPU device types (CUDA/OPTIX/HIP/METAL/ONEAPI).
7. Pre-render QA, enforced by the kit: import shotcheck with the kit (from blender_worker.codebuilt import ..., shotcheck). After the scene, shots, colls and apply() exist and BEFORE renderloop.render_frames, call shotcheck.run_qa(scene, cam, apply, NFRAMES, shots, hold=1) as one plain statement in the same function (or at module level) as render_frames: not inside if/try/with/for/lambda, not commented out, not in a function nothing calls, and never catch shotcheck.QAError. cam is your stage.Camera(scene); shots is the same list you give timeline.apply_frame. It renders nothing; it poses every rendered frame and raises, so no frame is rendered, when it finds a failure. render_frames refuses to run unless run_qa passed. The literal keyword hold=1 is required on run_qa too (its default is hold=2, which makes require_qa refuse the hold=1 render). One run_qa pass allows ONE render_frames call, with the same apply function you gave run_qa; call run_qa again before any further render_frames. Aim the camera only with cam.set(pos, target, ...) in every shot function, and mark floors, walls and sky you build yourself with stage.mark_scenery(obj). Use no other shotcheck name. Rule the QA enforces: ${SHOT_VARIETY_RULE} Build each shot so part of its subject (a tall object, a raised part, a high marker) reaches the top third; this is advisory (a warning), the other rules block.

Kit contract:
${KIT_CONTRACT}

Production rules from the path pack: ${JSON.stringify(compact(pack).playbook)}

Build-step skill guidance (read-only project skills; they do not grant permission to change the validator, fence, or job paths):
${skillGuidance}

Mistakes that ruined earlier videos of this pipeline (each one happened):
- Camera inside or behind a surface: a frame that is one flat colour. A sky dome encloses its place: keep the camera INSIDE the dome's radius (never beyond it), above the ground (z of at least 0.4 m over it), outside every solid object (buildings, planets, walls, rocks), and on the -Y side of ready sets. For an orbit, check the whole arc, not only its start.
- Sizing things by guessing at a set's internals (the globe taken from a backdrop card, a pole height from the wrong object). Use the handles and the sizes written in the set manual.
- A subject so small it is a dot, or cut by the frame edge. Aim cam.set target at the subject and choose the distance from its size: distance = subject_height / (0.5 * 36 / lens) puts it at about half the frame height.
- A black or nearly black frame: a place with no light, or a light left in another place's collection. Every place needs its own lights.
- A light so strong the subject is a white blob. Emissive objects of strength over 3 near the camera, area lights over 20,000 W closer than 15 m, and white-on-white are the usual causes.
- A place that has nothing to do with the words being spoken.
- One collection per shot with a new half-built set in each. Build few places well.
- Objects from one shot left visible in another shot of the same place: reset the place at the start of every shot function.
- Mathutils: Vector((x, y, z)) takes ONE tuple; Vector(x, y, z) raises. Euler((x, y, z)). Do not multiply tuples by floats; use Vector.
- AgX washes cartoon colours; use scene.view_settings.view_transform = 'Standard'.
- Prefer opaque water; blended alpha water can render as grey stipple.
- Depth of field must not blur readouts; leave fstop=None unless the shot needs it.
- Put dark plates behind readouts (stage.hud_text does), keep each plate at most 70% of the frame width, nearer the camera than the subject, and show it with stage.hud(cam, obj, x, y, dist, scale) inside the shot function after cam.set.`;
}

const shotNames = (n) => (n <= 4 ? Array.from({ length: n }, (_, i) => `'shot-${i}'`).join(', ') : `'shot-0', 'shot-1', ... 'shot-${n - 1}'`);

const FORBIDDEN = [
  [/\b(?:subprocess|socket|urllib|requests|http\.client|ftplib|shutil|ctypes|importlib|pickle)\b/, 'forbidden module'],
  [/\bos\.(?:system|popen|exec\w*|spawn\w*|remove|unlink|rmdir|rename|makedirs\s*\(\s*['"](?!\/job\/frames))/, 'forbidden os call'],
  [/\b(?:eval|exec|compile|__import__)\s*\(/, 'dynamic code execution'],
  [/\bopen\s*\(/, 'direct file access (render through renderloop only)'],
  [/\b(?:CUDA|OPTIX|HIP|METAL|ONEAPI)\b/, 'GPU device type'],
  [/\bstage\.setup_render\b/, 'stage.setup_render is EEVEE; configure Cycles on the CPU instead'],
  [/\bbpy\.ops\.wm\.(?:save|open|link|append)/, 'file save/open'],
];

/**
 * Python source without comments (`noComments`, string literals intact) and without comments and string contents (`code`, quotes kept, text blanked).
 * Line structure is preserved. Checks for calls and names run on `code` so a commented-out or quoted call never satisfies them; checks for
 * string-valued assignments (OUT, engine, collection names) run on `noComments`. A tokenizer for the cases a build uses (#, ', ", triple quotes,
 * backslash escapes), not a full parser; the optional AST check below is the structural backstop.
 */
export function stripPython(src) {
  const s = String(src ?? '');
  let code = '';
  let noComments = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '#') { while (i < s.length && s[i] !== '\n') i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const q = s.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      let j = i + q.length;
      for (; j < s.length; j += 1) {
        if (s[j] === '\\') { j += 1; continue; }
        if (q.length === 3 ? s.startsWith(q, j) : (s[j] === ch || s[j] === '\n')) break;
      }
      const closed = j < s.length && (q.length === 3 || s[j] === ch);
      const end = closed ? j + q.length : Math.min(j, s.length);
      const literal = s.slice(i, end);
      noComments += literal;
      code += q + literal.slice(q.length, closed ? literal.length - q.length : literal.length).replace(/[^\n]/g, ' ') + (closed ? q : '');
      i = end;
      continue;
    }
    code += ch; noComments += ch; i += 1;
  }
  return { code, noComments };
}

/** Top-level argument text of every call matched by `opener` (a /g regex ending at the opening bracket) in `code` (nested brackets blanked), or null when a call is unbalanced. */
function callArgs(code, opener) {
  const calls = [];
  for (const m of code.matchAll(opener)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
    }
    if (depth !== 0) return null;
    let top = '';
    let d = 0;
    for (const ch of code.slice(start, i - 1)) {
      if ('([{'.includes(ch)) d += 1;
      else if (')]}'.includes(ch)) d -= 1;
      top += d === 0 || '([{)]}'.includes(ch) ? ch : ' ';
    }
    calls.push(top);
  }
  return calls;
}
const RENDER_FRAMES_CALL = /\brender_frames\s*\(/g;
const RUN_QA_CALL = /\bshotcheck\s*\.\s*run_qa\s*\(/g;
/** True when the script has at least one call matched by `opener` and every call passes `name=literal` as a keyword at nesting depth 0 (not a variable, an expression or positional). */
const callsAllHave = (code, opener, name, literal) => {
  const calls = callArgs(code, opener);
  const re = new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*${literal}\\s*(?:,|$)`);
  return Array.isArray(calls) && calls.length > 0 && calls.every((top) => re.test(top));
};
const renderFramesCallsHave = (code, name, literal) => callsAllHave(code, RENDER_FRAMES_CALL, name, literal);

/**
 * Every assignment or keyword `key = value` in `code` (comments and string contents blanked) as {op, value}: `op` is the augmented operator ('' for a plain
 * assignment), `value` the rest of the statement. The render profile is checked on ALL of them: a valid first line must not hide a later bad one.
 */
const settingAssignments = (code, key) => [...code.matchAll(new RegExp(`\\b${key}\\b\\s*((?:[-+*/%@&|^]|//|\\*\\*)?)=(?!=)\\s*([^\\n;]*)`, 'g'))].map((m) => ({ op: m[1], value: m[2].trimEnd() }));
/** Reasons when any assignment of `key` is augmented or is not exactly `accept` (a regex source for the value, then , ) or the end of the statement), or when `required` and there is none. */
function settingProblems(code, key, accept, label, { required = true } = {}) {
  const all = settingAssignments(code, key);
  const okValue = new RegExp(`^(?:${accept})(?=\\s*(?:[,)]|$))`);
  const bad = all.filter((a) => a.op || !okValue.test(a.value));
  if (bad.length) return [`${label} (found ${bad.map((a) => `${key} ${a.op}= ${a.value}`.slice(0, 60)).join(' | ')})`];
  return all.length || !required ? [] : [`${label} (${key} is never assigned)`];
}

const MESH_CALL = /\bmeshes\.(?:ball|box|lathe|sweep|grid|mk|plane)\s*\(|\bfigures\.make_person\s*\(|\bprops\.(?!puffs|streaks)[a-z_]+\s*\(/g;
const SET_BUILD = /\b(?:city_street|globe|polar_penguin|tunnel|cutaway_planet|xray_body|room|bathroom)\s*\.\s*build\s*\(/g;
const HELPER_CAP = 3; // one call of a mesh-building helper stands for at most three mesh calls, like a set build

/**
 * How much scene a build script makes. `bare` is the script with comments and string contents blanked.
 * One per mesh or figure call and three per set build, as written. A script may also wrap those calls in its own
 * helper functions (def box(...): return meshes.box(...)) and call the helper many times: every call of such a helper
 * after the first adds what the helper builds, capped at HELPER_CAP. Counting only the literal meshes.* text refused
 * a 13-shot script that built its whole scene through helpers (job mwez63ee-fa76e6, 2026-11-13).
 */
export function sceneWeightOf(bare) {
  const text = String(bare ?? '');
  const count = (re, src) => (src.match(re) ?? []).length;
  const direct = count(MESH_CALL, text) + 3 * count(SET_BUILD, text);
  const lines = text.split('\n');
  const helpers = new Map(); // name -> body text
  for (let i = 0; i < lines.length; i += 1) {
    const def = /^([ \t]*)def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]);
    if (!def) continue;
    const indent = def[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    helpers.set(def[2], body.join('\n'));
  }
  const calls = (name, src) => count(new RegExp(`(?<![\\w.])${name}\\s*\\(`, 'g'), src);
  const weight = new Map([...helpers].map(([name, body]) => [name, count(MESH_CALL, body) + 3 * count(SET_BUILD, body)]));
  for (let pass = 0; pass < 2; pass += 1) { // a helper that calls a mesh-building helper builds meshes too
    for (const [name, body] of helpers) {
      let w = count(MESH_CALL, body) + 3 * count(SET_BUILD, body);
      for (const [other, ow] of weight) if (other !== name && ow > 0) w += calls(other, body) * Math.min(ow, HELPER_CAP);
      weight.set(name, w);
    }
  }
  let extra = 0;
  for (const [name, w] of weight) {
    if (w <= 0) continue;
    const uses = calls(name, text) - 1; // the def line itself matches once
    if (uses > 1) extra += (uses - 1) * Math.min(w, HELPER_CAP);
  }
  return direct + extra;
}

/** Static checks on a generated script. Returns a list of reasons; empty means it passed. */
export function validateBuildScript(code, { nframes, shotStarts, places }) {
  const why = [];
  const src = String(code ?? '');
  if (src.length < 600 || src.length > 90000) why.push('script must be a complete program between 600 and 90000 characters');
  for (const [re, msg] of FORBIDDEN) if (re.test(src)) why.push(msg);
  const imports = [...src.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm)].flatMap((m) => (m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim().split(/\s+as\s+/)[0])));
  const okRoot = new Set(['bpy', 'math', 'sys', 'os', 'numpy', 'mathutils', 'blender_worker']);
  for (const mod of imports) if (!okRoot.has(mod.split('.')[0])) why.push(`import not allowed: ${mod}`);
  // Comments never satisfy a check: calls and names are looked for in `code` (comments and string contents blanked), string-valued constants in `noComments`.
  const { code: bare, noComments } = stripPython(src);
  const kitImport = [...bare.matchAll(/from\s+blender_worker\.codebuilt\s+import\s+(\([^)]*\)|[^\n]*)/g)].map((m) => m[1]).join(',');
  if (!kitImport) why.push('must import the kit with: from blender_worker.codebuilt import ...');
  else if (!/\bshotcheck\b/.test(kitImport)) why.push('must import shotcheck from the kit: from blender_worker.codebuilt import ..., shotcheck');
  if (/[\w)\]]\s*\.\s*shotcheck\b/.test(bare) || /blender_worker\.codebuilt\.shotcheck/.test(src)) why.push('do not import or reach the shotcheck module directly; only shotcheck.run_qa may be used');
  if (/\bshotcheck\s*\.\s*(?!run_qa\b)[A-Za-z_]/.test(bare)) why.push('only shotcheck.run_qa may be used from shotcheck (the render gate is owned by the kit)');
  if (!/OUT\s*=\s*['"]\/job\/frames['"]/.test(noComments)) why.push("OUT must be the absolute path '/job/frames'");
  if (!new RegExp(`NFRAMES\\s*=\\s*${nframes}\\b`).test(noComments)) why.push(`NFRAMES must be exactly ${nframes}`);
  const ss = noComments.match(/SHOT_STARTS\s*=\s*\[([^\]]*)\]/);
  const got = ss ? ss[1].split(',').map((x) => Number(x.trim())) : null;
  if (!got || got.length !== shotStarts.length || got.some((x, i) => !(Math.abs(x - shotStarts[i]) < 1e-6))) why.push(`SHOT_STARTS must be exactly [${shotStarts.join(', ')}]`);
  if (!/\brender_frames\s*\(/.test(bare)) why.push('must render with renderloop.render_frames');
  else {
    if (!renderFramesCallsHave(bare, 'hold', '1')) why.push('renderloop.render_frames must be called with the literal keyword hold=1');
    if (!renderFramesCallsHave(bare, 'require_qa', 'True')) why.push('renderloop.render_frames must be called with the literal keyword require_qa=True');
  }
  if (!/\bshotcheck\s*\.\s*run_qa\s*\(/.test(bare)) why.push('must call shotcheck.run_qa(scene, cam, apply, NFRAMES, shots, hold=1) as a statement before render_frames');
  else if (!callsAllHave(bare, RUN_QA_CALL, 'hold', '1')) why.push('every shotcheck.run_qa call must pass the literal keyword hold=1 (render_frames uses hold=1 and require_qa refuses a hold that run_qa did not pose)');
  if (!/engine\s*=\s*['"]CYCLES['"]/.test(noComments)) why.push("scene.render.engine must be 'CYCLES'");
  if (!/cycles\.device\s*=\s*['"]CPU['"]/.test(noComments)) why.push("scene.cycles.device must be 'CPU'");
  // One render profile, checked on EVERY assignment or keyword in the code (strings and comments blanked), not the first match.
  why.push(...settingProblems(bare, 'resolution_x', '1080(?:\\.0+)?', 'scene.render.resolution_x must be exactly 1080'));
  why.push(...settingProblems(bare, 'resolution_y', '1920(?:\\.0+)?', 'scene.render.resolution_y must be exactly 1920'));
  why.push(...settingProblems(bare, 'resolution_percentage', '100(?:\\.0+)?', 'scene.render.resolution_percentage must be exactly 100'));
  why.push(...settingProblems(bare, 'fps', '30(?:\\.0+)?|FPS', 'scene.render.fps must be exactly 30'));
  why.push(...settingProblems(bare, 'FPS', '30', 'FPS must be exactly 30'));
  why.push(...settingProblems(bare, 'samples', '(?:8|9|1[0-6])(?:\\.0+)?', 'scene.cycles.samples must be an integer from 8 through 16'));
  why.push(...settingProblems(bare, 'hold', '1(?:\\.0+)?', 'hold must be exactly 1 in every render_frames and run_qa call', { required: false }));
  // Collections shot-0 .. shot-(n-1): each name as a literal, or built from a format inside the meshes.coll(...) call itself ('shot-%d', f'shot-{i}', 'shot-' + str(i)) when a helper makes them in a loop.
  // The format may also sit in a variable first (name = 'shot-%d' % i; meshes.coll(scene, name)): a 13-shot script written that way was refused
  // as "collection 'shot-0' is missing" (job mwf06gtw-069893, 2026-11-13). Any shot-name format in the code counts when meshes.coll is called.
  const dynamicName = /\bcoll\s*\(/.test(bare) && /['"]shot-(?:%[sd]['"]|\{[^}'"]*\}['"]|['"]\s*\+)/.test(noComments);
  // A directed build (direction.js) has a few places that the shots share: each place id must be registered as 'place-<id>'. Without a direction the
  // older rule holds: one collection per shot.
  if (Array.isArray(places) && places.length) {
    for (const id of places) if (!new RegExp(`['"]place-${String(id).replace(/[^a-z0-9]/g, '')}['"]`).test(noComments)) why.push(`place collection 'place-${id}' is missing (register every place of the direction in colls under that name)`);
  } else if (!dynamicName) for (let i = 0; i < shotStarts.length; i += 1) if (!new RegExp(`['"]shot-${i}['"]`).test(noComments)) why.push(`collection 'shot-${i}' is missing`);
  if (!/apply_frame\s*\(/.test(bare)) why.push('must switch shots with timeline.apply_frame');
  const sceneWeight = sceneWeightOf(bare);
  // A directed build makes a few places once and its shots share them, so what must exist scales with the places, not the shots
  // (twelve shots over three ready sets weigh 9 and were refused as "9 of 36": review of 2026-11-14).
  const directedPlaces = Array.isArray(places) && places.length ? places.length : 0;
  const sceneNeeded = directedPlaces ? Math.max(9, 3 * directedPlaces) : Math.max(9, 3 * shotStarts.length);
  if (sceneWeight < sceneNeeded) why.push(`too little scene: ${sceneWeight} of ${sceneNeeded} needed (mesh, figure and props calls, 3 per set build, repeated calls of your own mesh-building helpers count too); the ${directedPlaces ? `${directedPlaces} places` : `${shotStarts.length} shots`} need topic-specific subjects and sets`);
  return why;
}

// Structural QA check, run by the host interpreter when there is one: every render_frames call must sit in a scope (module, or a function that is
// really called) whose body holds, EARLIER and as a plain statement (an expression statement or an assignment, so not inside if/try/with/for/lambda/a list),
// a call of shotcheck.run_qa. With an expectation (argv[1] = {"shotStarts": [...], "nframes": n}) it also checks that NFRAMES and SHOT_STARTS are each
// assigned exactly once, at module level, as plain number literals equal to the expected ones, and that SHOT_STARTS is never changed afterwards
// (augmented assignment, item assignment, append/extend/insert/pop/remove/clear/sort/reverse): a later rewrite would move the cuts the validator thinks it saw.
// Prints a JSON list of reasons; exit 3 = the source does not parse (the syntax check reports that).
const QA_STRUCTURE_PY = `import ast, json, sys
expect = json.loads(sys.argv[1]) if len(sys.argv) > 1 else None
try:
    tree = ast.parse(sys.stdin.read())
except SyntaxError:
    sys.exit(3)
parents = {}
for n in ast.walk(tree):
    for c in ast.iter_child_nodes(n):
        parents[c] = n
SCOPES = (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef)
def callee(c):
    f = c.func
    return f.attr if isinstance(f, ast.Attribute) else (f.id if isinstance(f, ast.Name) else None)
def is_qa(s):
    v = s.value if isinstance(s, (ast.Expr, ast.Assign)) else None
    return isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr == 'run_qa' and isinstance(v.func.value, ast.Name) and v.func.value.id == 'shotcheck'
MSG = 'shotcheck.run_qa(...) must be a plain statement, in the same function or module body as render_frames and before the statement that renders'
NOCALL = 'the function that holds shotcheck.run_qa and render_frames is never called'
problems = []
for call in [n for n in ast.walk(tree) if isinstance(n, ast.Call) and callee(n) == 'render_frames']:
    cur = call
    while cur in parents and not isinstance(parents[cur], SCOPES) and not isinstance(parents[cur], (ast.Lambda, ast.ClassDef)):
        cur = parents[cur]
    scope = parents.get(cur)
    if scope is None or isinstance(scope, (ast.Lambda, ast.ClassDef)) or cur not in scope.body:
        problems.append(MSG)
        continue
    if not any(is_qa(s) for s in scope.body[:scope.body.index(cur)]):
        problems.append(MSG)
    elif not isinstance(scope, ast.Module):
        inside = set(ast.walk(scope))
        if scope.name not in {callee(n) for n in ast.walk(tree) if isinstance(n, ast.Call) and n not in inside}:
            problems.append(NOCALL)
MUTATORS = {'append', 'extend', 'insert', 'pop', 'remove', 'clear', 'sort', 'reverse'}
def number(v):
    return isinstance(v, ast.Constant) and isinstance(v.value, (int, float)) and not isinstance(v.value, bool)
def assigned(name):
    found, changed = [], False
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            targets, value = n.targets, n.value
        elif isinstance(n, ast.AnnAssign) and n.value is not None:
            targets, value = [n.target], n.value
        elif isinstance(n, ast.AugAssign):
            if isinstance(n.target, ast.Name) and n.target.id == name:
                changed = True
            continue
        else:
            continue
        for t in targets:
            if isinstance(t, ast.Name) and t.id == name:
                found.append((n, value))
            elif isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name) and t.value.id == name:
                changed = True
            elif isinstance(t, (ast.Tuple, ast.List)) and any(isinstance(e, ast.Name) and e.id == name for e in ast.walk(t)):
                changed = True
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in MUTATORS and isinstance(n.func.value, ast.Name) and n.func.value.id == name:
            changed = True
        if isinstance(n, (ast.For, ast.comprehension)) and any(isinstance(e, ast.Name) and e.id == name for e in ast.walk(n.target)):
            changed = True
    return found, changed
if expect is not None:
    found, changed = assigned('SHOT_STARTS')
    want = expect['shotStarts']
    ok = len(found) == 1 and not changed and parents.get(found[0][0]) is tree and isinstance(found[0][1], ast.List) and len(found[0][1].elts) == len(want) and all(number(e) and abs(e.value - w) < 1e-6 for e, w in zip(found[0][1].elts, want))
    if not ok:
        problems.append('SHOT_STARTS must be assigned once at module level as the literal list of ' + str(len(want)) + ' numbers and never changed afterwards')
    found, changed = assigned('NFRAMES')
    ok = len(found) == 1 and not changed and parents.get(found[0][0]) is tree and number(found[0][1]) and found[0][1].value == expect['nframes']
    if not ok:
        problems.append('NFRAMES must be assigned once at module level as the literal number ' + str(expect['nframes']) + ' and never changed afterwards')
print(json.dumps(sorted(set(problems))))`;

/** Reasons from the structural QA check, [] when it passes, or null when no Python interpreter could run it (the runtime gate in render_frames still applies). */
export function pythonQaStructureCheck(code, { spawn = spawnSync, expect } = {}) {
  for (const exe of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawn(exe, ['-I', '-c', QA_STRUCTURE_PY, ...(expect ? [JSON.stringify({ shotStarts: expect.shotStarts, nframes: expect.nframes })] : [])], { input: code, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status === null) continue;
    if (r.status === 3) return null;
    if (r.status !== 0) continue;
    try { const list = JSON.parse(String(r.stdout).trim()); if (Array.isArray(list)) return list.map(String); } catch { /* next interpreter */ }
  }
  return null;
}

/** Optional Python syntax check. Uses the host interpreter when one exists; returns null (not checked) when it cannot run. */
export function pythonSyntaxCheck(code, { spawn = spawnSync } = {}) {
  for (const exe of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawn(exe, ['-I', '-c', 'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print("line %s: %s" % (e.lineno, e.msg)); sys.exit(3)'], { input: code, encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status === null) continue;
    if (r.status === 0) return '';
    if (r.status === 3) return String(r.stdout).trim() || 'syntax error';
  }
  return null;
}

/**
 * The director's shot list for a recorded narration (direction.js): places built once and shots cut on phrase starts.
 * Never fails the job on a bad reply: when the model's direction is refused twice, an arithmetic fallback direction is returned
 * (source 'fallback'). Aborts, usage limits and CLI failures still throw.
 *   -> { direction, shotStarts, phrases, calls }
 */
export async function planCodebuiltDirection(input = {}, deps = {}) {
  const words = input.words;
  checkWords(words);
  const nframes = frameCountFor(words);
  const videoSeconds = nframes / FPS;
  const phrases = phrasesOf(words, LEAD_S);
  const asker = makeAsker(deps, 'direction', deps.onCall);
  const check = (text) => {
    try { return checkDirection({ phrases, videoSeconds, setNames: SET_NAMES, parse: parseModelJson })(text); } catch (error) {
      if (error instanceof DirectionError) throw new PlannerError('BAD_DIRECTION', error.message, error.reasons);
      throw error;
    }
  };
  const choices = input.choices ?? null;
  const prompt = directionPrompt({
    topic: input.topic, duration: input.duration, script: input.script, brief: input.brief, beats: Array.isArray(input.beats) ? input.beats : [], phrases, videoSeconds,
    setManual: SET_PICKER_TEXT, propsManual: PROPS_PICKER_TEXT, guides: guidesFor(input.pathPack, 'direction'), choicesText: buildChoicesPrompt(choices),
  });
  try {
    const direction = await asker.run(prompt, check, input.signal);
    return { direction, shotStarts: directionShotStarts(direction, phrases, FPS), phrases, calls: asker.calls };
  } catch (error) {
    if (!(error instanceof PlannerError) || error.code !== 'BAD_DIRECTION') throw error;
    const fb = fallbackDirection({ words, beats: Array.isArray(input.beats) ? input.beats : [], lead: LEAD_S, tail: TAIL_S });
    return { direction: fb.direction, shotStarts: fb.shotStarts, phrases, calls: asker.calls };
  }
}

export async function planCodebuiltBuild(input = {}, deps = {}) {
  if (input.choices?.type === 'loop' || input.pathPack?.videoType === 'loop') return planCodebuiltLoop(input, deps);
  const topic = String(input.topic ?? '').trim();
  const duration = Number(input.duration);
  if (!topic) throw new PlannerError('BAD_REQUEST', 'topic is required');
  if (!PLANNER_DURATIONS.includes(duration)) throw new PlannerError('BAD_REQUEST', 'duration must be 30, 45, 60 or 90');
  if (typeof input.script !== 'string' || !input.script.trim() || typeof input.brief !== 'string' || !input.brief.trim()) throw new PlannerError('BAD_REQUEST', 'script and brief are required');
  if (input.signal?.aborted) throw abortError();
  const rawModel = input.buildModel ?? deps.buildModel;
  let forcedTier;
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel !== 'string') throw new PlannerError('BAD_REQUEST', 'buildModel must be a string');
    const norm = rawModel.trim().toLowerCase();
    if (norm === 'codex sol') {
      throw new PlannerError('build_model_unavailable', 'build_model_unavailable');
    }
    if (norm === 'auto') {
      // Auto: keep default CB9
    } else if (norm === 'sonnet') {
      forcedTier = 'sonnet';
    } else if (norm === 'opus') {
      forcedTier = 'opus';
    } else if (norm === 'fable') {
      forcedTier = 'fable';
    } else {
      throw new PlannerError('BAD_REQUEST', 'Unknown buildModel: ' + rawModel);
    }
  }
  const pack = input.pathPack;
  if (!pack || pack.id !== 'codebuilt' || !Array.isArray(pack.skills) || !Array.isArray(pack.rules?.playbook)) {
    throw new PlannerError('PATH_PACK_INVALID', 'the real code-built path pack (paths/codebuilt.json) is required');
  }
  const choices = choicesOf(input);
  const words = input.words;
  checkWords(words);
  const nframes = frameCountFor(words);
  // The shot list: the one given (a resumed job), else the director's (one extra model call), else arithmetic cuts when direction is switched off.
  let direction = input.direction && Array.isArray(input.direction.shots) && Array.isArray(input.shotStarts) ? input.direction : null;
  let shotStarts = direction ? input.shotStarts : null;
  const directionCalls = [];
  if (!direction && deps.direct !== false) {
    const planned = await (deps.directFn ?? planCodebuiltDirection)({ topic, duration, script: input.script, brief: input.brief, beats: input.beats, words, pathPack: pack, choices, signal: input.signal }, { ...deps, forcedTier: forcedTier ?? deps.forcedTier });
    direction = planned.direction; shotStarts = planned.shotStarts;
    directionCalls.push(...(planned.calls ?? []));
  }
  if (!direction) shotStarts = shotStartsFor(words);
  const places = direction ? direction.places.map((p) => p.id) : null;
  const asker = makeAsker({ ...deps, timeoutMs: deps.timeoutMs ?? BUILD_TIMEOUT_MS, forcedTier: forcedTier ?? deps.forcedTier }, 'build', deps.onCall);
  const syntax = deps.syntaxCheck ?? pythonSyntaxCheck;
  const qaStructure = deps.qaStructureCheck ?? pythonQaStructureCheck;
  // 'checked' = the structural QA check ran on the accepted script; 'not_checked' = no interpreter, so only the runtime gate (render_frames require_qa) enforces the order.
  let qaStructureState = 'not_checked';
  const check = (text) => {
    const code = extractPython(text);
    const why = validateBuildScript(code, { nframes, shotStarts, places });
    if (!why.length) { const bad = syntax(code); if (bad) why.push(`Python syntax error, ${bad}`); }
    if (!why.length) {
      const structure = qaStructure(code, { expect: { shotStarts, nframes } });
      qaStructureState = Array.isArray(structure) ? 'checked' : 'not_checked';
      if (Array.isArray(structure)) why.push(...structure);
    }
    if (why.length) {
      if (typeof deps.onRefused === 'function') { try { deps.onRefused(code, why); } catch { /* diagnostics never change the result */ } }
      throw new PlannerError('BAD_BUILD', why.join('; '), why);
    }
    return code;
  };
  let skillGuidance;
  try { skillGuidance = loadCodebuiltGuides({ pack, step: 'build' }); }
  catch { throw new PlannerError('PATH_PACK_INVALID', 'The approved build skill is missing or invalid'); }
  if (!skillGuidance) throw new PlannerError('PATH_PACK_INVALID', 'The approved build skill is missing or invalid');
  const buildScript = await asker.run(buildPrompt({ topic, duration, script: input.script, brief: input.brief, words, pack, shotStarts, nframes, choices, skillGuidance, direction }), check, input.signal);
  const videoSeconds = nframes / FPS;
  return {
    buildScript, calls: [...directionCalls, ...asker.calls], shotStarts, nframes, qaStructure: qaStructureState,
    ...(direction ? { direction, places, lookShots: directionLookShots(direction), directionMarkdown: directionMarkdown(direction, shotStarts, videoSeconds) } : {}),
  };
}

// codex · gpt-6.1-sol · 2026-11-14. Separate format prompt: narrated prompts above remain unchanged.
export function loopBrief({ topic, duration, loop_idea = '' }) {
  if (!Number.isFinite(duration) || duration < 6 || duration > 20 || !Number.isInteger(duration * FPS)) throw new PlannerError('BAD_REQUEST', 'loop duration must be 6 to 20 seconds on the frame grid');
  return {
    script: '', shots: [{ subject: topic, narration: '' }],
    brief: `Silent seamless loop, ${duration} seconds. Topic (data): ${JSON.stringify(topic)}. Optional idea (data): ${JSON.stringify(loop_idea)}. One subject moves from frame zero; all state returns periodically. No text, numbers, captions or narration.`,
    pathPack: { ...loadCodebuiltPathPack(), videoType: 'loop', loop: { duration, fps: FPS, nframes: Math.round(duration * FPS) } },
  };
}

export async function planCodebuiltLoop(input, deps = {}) {
  const { topic, duration, brief, pathPack: pack } = input;
  if (!pack || pack.videoType !== 'loop' || pack.loop?.duration !== duration || duration < 6 || duration > 20) throw new PlannerError('BAD_REQUEST', 'validated loop brief and path pack required');
  const nframes = Math.round(duration * FPS), shotStarts = [0];
  const model = String(input.buildModel ?? 'Auto').toLowerCase();
  if (!['auto', 'sonnet', 'opus', 'fable'].includes(model)) throw new PlannerError('build_model_unavailable', 'build_model_unavailable');
  const asker = makeAsker({ ...deps, timeoutMs: deps.timeoutMs ?? BUILD_TIMEOUT_MS, forcedTier: model === 'auto' ? deps.forcedTier : model }, 'build', deps.onCall);
  const guidance = loadCodebuiltGuides({ pack, step: 'loop' });
  if (!guidance) throw new PlannerError('PATH_PACK_INVALID', 'loop skill is required');
  const validate = (code) => {
    const why = validateBuildScript(code, { nframes, shotStarts });
    const bad = (deps.syntaxCheck ?? pythonSyntaxCheck)(code);
    if (bad) why.push(`Python syntax error, ${bad}`);
    const structure = (deps.qaStructureCheck ?? pythonQaStructureCheck)(code, { expect: { nframes, shotStarts } });
    if (Array.isArray(structure)) why.push(...structure);
    // No factual on-screen claims are needed in this format. Block text rather than skipping a claim check.
    if (/\b(?:text|hud_text|readout)\s*\(/.test(stripPython(code).code) || /\.body\s*=|\btype\s*=\s*['"]FONT['"]/.test(code)) why.push('loop scenes must contain no text or numeric readouts');
    return why;
  };
  const prompt = `Write the COMPLETE offline Blender Python program for this silent loop. Output only Python in one fenced block.
Topic (data): ${JSON.stringify(topic)}
${brief}
Constants must be FPS = 30, NFRAMES = ${nframes}, SHOT_STARTS = [0], OUT = '/job/frames'.
One continuous shot in collection 'shot-0'. Build a detailed subject and setting (at least nine mesh/prop calls, repeated helper calls count).
Use timeline.apply_frame with shots=[(0, 'shot-0', shot_0)] and colls. All object and camera state is a pure function of t.
Import loops from the kit. loops.phase(frame, NFRAMES), loops.periodic(frame, NFRAMES, low, high, cycles=1, offset=0), loops.cyclic_camera(frame, NFRAMES, centre=(0,0,0), radius=8, height=4), loops.close_bake(samples) are available.
For motion inside shot_0(t), frame=t*FPS. Integer cycles only; the state at frame NFRAMES must equal frame 0. Never crossfade or hide a jump.
No text, numeric readouts, narration, audio access, captions, word times, keyframes or external resources.
The kit renders frame NFRAMES independently after the final frame for the host seam check; it is NOT part of the encoded video. Do not copy the opening frame yourself.
Render every frame with renderloop.render_frames(range(NFRAMES), OUT, apply, render_fn, skip_existing=False, hold=1, require_qa=True).
Before that call, shotcheck.run_qa(scene, cam, apply, NFRAMES, shots, hold=1) must be a plain statement in the same scope.
Use 1080x1920, 100%, 30 fps, PNG, Cycles CPU, 8..16 samples; stage.Camera.set in every pose.
${KIT_CONTRACT}
Loop-specific guidance (takes precedence over narration/caption advice):
${guidance}`;
  const buildScript = await asker.run(prompt, (text) => {
    const code = extractPython(text), why = validate(code);
    if (why.length) { deps.onRefused?.(code, why); throw new PlannerError('BAD_BUILD', why.join('; '), why); }
    return code;
  }, input.signal);
  return { buildScript, calls: asker.calls, nframes, shotStarts, validate, kitContract: KIT_CONTRACT, lookShots: [{ subject: topic, narration: 'Silent continuous periodic action; no text.' }] };
}
