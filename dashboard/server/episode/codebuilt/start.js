// Code-built start: the owner presses Start in the UI, this module runs the whole job.
//
//   script (host) -> voice (existing TTS stage; vo.wav + measured words.json) -> path pack -> planner (host CLI, writes build.py)
//   -> runner (composeCodebuiltRunner: CB6 fence, offline container, host producer) -> codebuiltToDraft -> a normal draft behind the review gate.
//
// Nothing here starts by itself: only start() does, and the route behind it is admin-only. Every step is injectable so the tests run the
// real pipeline with stubs and no network, Docker, GPU or API key. Nothing is faked: a missing module, an unapproved launch, a failed step
// or an abort ends the job as failed/aborted with a generic code, and no draft exists unless codebuiltToDraft produced one.
//
// Dynamic imports (planner, composeRunner) are resolved at run time so this file loads before those modules are merged.
// planner module contract (episode/codebuilt/planner.js):
//   planCodebuiltScript({ topic, duration }, deps)            -> { script, brief, pathPack?, calls? }     (optional; `scriptStage` dep overrides)
//   planCodebuiltBuild({ topic, duration, script, brief, words, pathPack, ... }, deps) -> { buildScript, calls?, ... }
// calls ([{step, provider, model, wall_s, input_tokens, output_tokens, retries}]) are written to <job>/cost_calls.json (read by codebuiltToDraft).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, episodeRoot, createEpisodeDir } from '../artifacts.js';
import { jobsRoot, codebuiltToDraft, draftIdForJob } from './draftAdapter.js';
import { runCodebuiltVoice, LEAD_S, TAIL_S, REASONS as VOICE_ERROR_REASONS } from './voice.js';
import { normalizeJobCalls } from '../../perf/creationCost.js';
import { lengthCheck } from './lengthCheck.js';
import { GENERATED_GPU_EXECUTOR_ID } from '../engines/codebuilt/launch.js';
import { produceLightMetadata, validateTitle, validateTags } from './lightMetadata.js';
import { askRole } from '../../routes/askRole.js';
import { askClaude } from '../../routes/claudeCli.js';
import { runVisualBuildLoop } from './visualLoop.js';
import { probeLookSupport, askClaudeLook } from './lookCall.js';
import { createPreviewSheetMaker } from './previewSheet.js';
import { hostExecFile } from './hostEffects.js';
import { createPreviewRunFn } from '../engines/codebuilt/composePreview.js';
import { sanitizeRouterCall } from './routerCalls.js';
import { defaultFactCheckStage } from './factCheckStage.js';
import { normalizeProductionChoices } from './productionChoices.js';

// Production default is the real router. Under `node --test` (NODE_TEST_CONTEXT is set by the runner) the default refuses before any CLI
// is spawned, so a rig that never injects askRoleFn cannot reach a model; tests that want metadata inject askRoleFn or lightMetadataStage.
const defaultAskRole = (...args) => process.env.NODE_TEST_CONTEXT
  ? Promise.reject(new Error('model calls are disabled under the test runner'))
  : askRole(...args);

// KAN-934: the same guard for the visual loop's model calls. A rig that never injects them cannot reach a model.
const NO_MODEL_UNDER_TEST = () => Promise.reject(Object.assign(new Error('model calls are disabled under the test runner'), { unavailable: true }));
const defaultAskLook = (...args) => (process.env.NODE_TEST_CONTEXT ? NO_MODEL_UNDER_TEST() : askClaudeLook(...args));
const defaultAskText = (prompt, { model, timeoutMs } = {}) => (process.env.NODE_TEST_CONTEXT ? NO_MODEL_UNDER_TEST() : askClaude(prompt, { model, timeoutMs, structured: true }));
const LOOP_START_CODES = new Set(['look_unavailable', 'look_failed', 'loop_timeout', 'preview_failed']);
const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '');

export const START_VERSION = 'codebuilt-start-v1';
export const DURATIONS = Object.freeze([30, 45, 60, 90]);
export const BUILD_MODELS = Object.freeze(['Auto', 'Sonnet', 'Opus', 'Fable', 'Codex Sol']);
export const TOPIC_MAX = 200;
export const ACTIVE = Object.freeze(['queued', 'scripting', 'factchecking', 'voicing', 'planning', 'previewing', 'looking', 'building', 'drafting']);
export const FINAL = Object.freeze(['done', 'failed', 'aborted', 'interrupted']);
export const STAGE_DIR = '.start';
// The finished video may be this many seconds under the requested duration before the job stops (TTS pace varies; see planner.js targetWords).
// 60 and 90 s keep 4 s; the shorter videos scale it (about 7 percent) so a 30 s request cannot finish at 26 s.
export const SHORT_TOLERANCE_S = 4;
export const SHORT_TOLERANCE_BY_DURATION_S = Object.freeze({ 30: 2, 45: 3, 60: SHORT_TOLERANCE_S, 90: SHORT_TOLERANCE_S });
export const shortToleranceFor = (duration) => SHORT_TOLERANCE_BY_DURATION_S[duration] ?? SHORT_TOLERANCE_S;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
// The isolated Blender build renders on 4 CPUs at about 4 s a frame (measured 2026-11-13: 15 frames a minute), about 1930 frames for 60 s and 2900 for 90 s.
// The first limits (90 and 120 minutes) killed a healthy run; these are about 1.5 times the measured need and stay under the runner's 6 hour ceiling.
// 30 s is about 900 frames (60 minutes -> 1.5 h) and 45 s about 1350 frames (90 minutes -> 2.25 h).
export const TIMEOUT_MS = Object.freeze({ 30: 1.5 * 60 * 60 * 1000, 45: 2.25 * 60 * 60 * 1000, 60: 3 * 60 * 60 * 1000, 90: 4.5 * 60 * 60 * 1000 });
const MESSAGES = Object.freeze({
  bad_request: 'Invalid request', invalid_id: 'Invalid job id', not_found: 'Not found', conflict: 'The job is not in a state that allows this',
  launch_not_approved: 'The code-built launch is not approved yet (waiting for the security activation); nothing was started',
  planner_unavailable: 'The code-built planner is not available', script_unavailable: 'The code-built script writer is not available',
  runner_unavailable: 'The code-built runner is not available', script_failed: 'The script step failed', voice_failed: 'The voice step failed',
  planner_failed: 'The planner step failed', too_short: 'The voice is too short for the requested video length', build_failed: 'The build failed', draft_failed: 'The draft could not be written', aborted: 'Aborted by the owner', interrupted: 'The server restarted while the job ran', internal: 'The job failed', build_model_unavailable: 'The requested build model is not available',
  fact_check_blocked: 'The fact check did not verify the script', fact_check_failed: 'The fact check step failed', fact_check_unavailable: 'The fact check is not available',
  retrieval_unavailable: 'The fact check could not retrieve and validate independent sources; no voice or build was started',
  look_unavailable: 'The visual check could not run (the Claude CLI could not look at pictures, is not logged in, or hit its usage limit); nothing was rendered',
  look_failed: 'The visual check did not approve the build within three looks; nothing was rendered',
  loop_timeout: 'The visual check ran out of time; nothing was rendered',
  preview_failed: 'The preview render could not be made; nothing was rendered',
});
// Private planner diagnostics use fixed text only. Never persist an exception message or CLI output.
const PLANNER_REASONS = Object.freeze({
  BAD_WORDS: 'Measured voice word timings were invalid.',
  PATH_PACK_MISSING: 'The required code-built path pack could not be loaded.',
  PATH_PACK_INVALID: 'The required code-built path pack did not match its schema.',
  BAD_JSON: 'The planner reply was not valid JSON.',
  BAD_SCRIPT: 'The planner script did not meet the required script checks.',
  BAD_BUILD: 'The generated Blender build script did not meet its checks.',
  ABORTED: 'The planner was aborted.',
  CLI_TIMEOUT: 'The model call timed out.',
  CLI_LIMIT: 'The model call hit a usage limit.',
  CLI_UNAVAILABLE: 'The model command was not available.',
  build_model_unavailable: 'The requested build model is not available.',
  BUILD_MODEL_UNAVAILABLE: 'The requested build model is not available.',
});
// Private voice diagnostics: one fixed sentence per code in voice.js REASONS, plus VOICE_ERROR for anything else. Never an exception message, detail, CLI or HTTP text.
const VOICE_REASONS = Object.freeze({
  invalid_input: 'The voice stage was given an invalid script or file path.',
  bad_output_dir: 'The voice output folder was missing or not allowed.',
  voice_stage_failed: 'The voice stage (text to speech and word timing) failed before it produced files.',
  bad_voice_files: 'The voice audio or timing files were missing or not valid.',
  bad_timing_file: 'The voice timing file was not in the expected format.',
  timing_not_measured: 'The word times were not measured by an aligner.',
  timing_mismatch: 'The word timings did not match the audio or the approved script.',
  bad_word_times: 'The measured word times were invalid.',
  estimated_timings: 'The word times looked estimated from text length, not measured.',
  bad_lead: 'The voice has too much silence before the first word.',
  bad_tail: 'The voice has too much silence after the last word.',
  audio_not_matching: 'The sound in the voice audio did not line up with the measured word times.',
  unknown_voice_option: 'The requested voice option is not available.',
  VOICE_ERROR: 'The voice step failed for an unclassified reason.',
});
export class StartError extends Error {
  constructor(code, status = 400) { super(MESSAGES[code] || MESSAGES.internal); this.name = 'StartError'; this.code = MESSAGES[code] ? code : 'internal'; this.status = status; }
}
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const now = () => new Date().toISOString();

/** Validates a start request: topic text and a supported duration. Duration is requested, never silently changed. */
export function checkStartRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new StartError('bad_request');
  if (Object.keys(input).some((k) => !['topic', 'duration', 'voice', 'channelId', 'buildModel'].includes(k))) throw new StartError('bad_request');
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topic || topic.length > TOPIC_MAX || /[\x00-\x1F\x7F]/.test(topic)) throw new StartError('bad_request');
  const duration = input.duration === undefined ? 60 : input.duration;
  if (!DURATIONS.includes(duration)) throw new StartError('bad_request');
  if (input.voice !== undefined && (typeof input.voice !== 'string' || !/^[a-z_]{2,20}$/.test(input.voice))) throw new StartError('bad_request');
  if (input.channelId !== undefined && (typeof input.channelId !== 'string' || !input.channelId || input.channelId.length > 80)) throw new StartError('bad_request');
  let buildModel = 'Auto';
  if (input.buildModel !== undefined) {
    if (typeof input.buildModel !== 'string') throw new StartError('bad_request');
    const match = BUILD_MODELS.find((m) => m.toLowerCase() === input.buildModel.trim().toLowerCase());
    if (!match) throw new StartError('bad_request');
    buildModel = match;
  }
  if (buildModel === 'Codex Sol') throw new StartError('build_model_unavailable', 422);
  return { topic, duration, voice: input.voice ?? 'aiden', channelId: input.channelId, buildModel };
}

// The shape that leaves the server: no path, no stack, only the generic message.
export function publicJob(rec) {
  if (!rec) return null;
  const { id, topic, duration, status, step, createdAt, updatedAt, error, draftId, steps, buildModel, length_check: lengthCheckRec, runId, batchIndex } = rec;
  return { id, topic, duration, status, step: step ?? null, createdAt, updatedAt, draftId: draftId ?? null, steps: steps ?? [], error: error ? { code: error.code, message: error.message } : null, ...(buildModel ? { buildModel } : {}), ...(lengthCheckRec ? { length_check: lengthCheckRec } : {}), ...(runId ? { runId, batchIndex } : {}) };
}

export function createCodebuiltStarter({
  jobsDir = jobsRoot(), episodesRoot = episodeRoot(), draftsDir, defaultChannelId,
  scriptStage, planner, composeRunner, voiceStage = runCodebuiltVoice, toDraft = codebuiltToDraft, clock = now, newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
  postFactoryFn, inputRoot, lightMetadataStage, askRoleFn = defaultAskRole, factCheckStage = defaultFactCheckStage,
  // KAN-934: the visual loop. On by default; only an injected `false` turns it off (tests). An object injects its pieces (probe, askLook, askText, runPreview, sheetMaker, validate, runLoop).
  visualLoop,
} = {}) {
  const stateRoot = () => path.join(jobsDir, STAGE_DIR);
  const recFile = (id) => path.join(stateRoot(), id, 'status.json');
  const live = new Map(); // id -> { rec, controller }
  const waiting = []; // queued ids, one job runs at a time (the fence holds the GPU lease anyway)
  let running = null;

  const save = (rec) => {
    rec.updatedAt = clock();
    fs.mkdirSync(path.dirname(recFile(rec.id)), { recursive: true });
    atomicWrite(path.dirname(recFile(rec.id)), 'status.json', `${JSON.stringify(rec, null, 1)}\n`);
  };
  const load = (id) => {
    if (!JOB_ID.test(id)) throw new StartError('invalid_id');
    if (live.has(id)) return live.get(id).rec;
    try {
      const rec = JSON.parse(fs.readFileSync(recFile(id), 'utf8'));
      if (rec.id !== id) return null;
      // Recorded as running but nothing here owns it: the server restarted. Never report it as still running.
      if (ACTIVE.includes(rec.status)) return { ...rec, status: 'interrupted', error: { code: 'interrupted', message: MESSAGES.interrupted } };
      return rec;
    } catch { return null; }
  };
  const step = (rec, status, name) => { rec.status = status; rec.step = name ?? status; rec.steps.push({ step: rec.step, at: clock() }); save(rec); };

  async function importPlanner() {
    if (planner) return planner;
    try { return await import('./planner.js'); } catch { throw new StartError('planner_unavailable', 501); }
  }
  async function composeFor(inputRoots) {
    if (composeRunner) return composeRunner({ root: jobsDir, inputRoots });
    let mod;
    try { mod = await import('../engines/codebuilt/compose.js'); } catch { throw new StartError('runner_unavailable', 501); }
    return mod.composeCodebuiltRunner({ root: jobsDir, inputRoots, launchId: GENERATED_GPU_EXECUTOR_ID });
  }

  function writeCalls(id, calls, createJobDir = false) {
    if (!Array.isArray(calls) || !calls.length) return;
    const bytes = `${JSON.stringify({ calls: normalizeJobCalls(calls).map(({ tokens, ...call }) => ({ ...call, input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null })) }, null, 1)}\n`;
    for (const dir of [path.join(stateRoot(), id), path.join(jobsDir, id)]) {
      try {
        // The runner owns creation and validation of its job root. Never create it just to record costs.
        if (dir === path.join(jobsDir, id) && !createJobDir && !fs.existsSync(dir)) continue;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'cost_calls.json'), bytes);
      } catch { /* cost is best effort and never blocks or fakes a result */ }
    }
  }

  // Every build script the checks refuse is kept beside the job state (refused-build-1.py, -2.py with the reasons on
  // top), so a failed planning step can be diagnosed without paying for another model call.
  function refusedBuildWriter(id) {
    let n = 0;
    return (code, why) => {
      n += 1;
      const dir = path.join(stateRoot(), id);
      fs.mkdirSync(dir, { recursive: true });
      const head = why.map((line) => `# REFUSED: ${String(line).replace(/\s+/g, ' ')}`).join('\n');
      fs.writeFileSync(path.join(dir, `refused-build-${n}.py`), `${head}\n${String(code ?? '')}\n`);
    };
  }

  function writePlannerDiagnostic(id, error) {
    const code = typeof error?.code === 'string' && Object.hasOwn(PLANNER_REASONS, error.code) ? error.code
      : error?.timedOut === true ? 'CLI_TIMEOUT' : error?.quota === true ? 'CLI_LIMIT' : error?.unavailable === true ? 'CLI_UNAVAILABLE' : 'PLANNER_ERROR';
    const reason = PLANNER_REASONS[code] ?? 'The planner failed for an unclassified reason.';
    try {
      fs.mkdirSync(path.join(stateRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(stateRoot(), id, 'planner-error.json'), `${JSON.stringify({ stage: 'planning', code, reason }, null, 1)}\n`);
    } catch { /* Private diagnostics are best effort and never change the job result. */ }
  }

  function writeVoiceDiagnostic(id, error) {
    const code = typeof error?.reason === 'string' && VOICE_ERROR_REASONS.includes(error.reason) && Object.hasOwn(VOICE_REASONS, error.reason) ? error.reason : 'VOICE_ERROR';
    try {
      fs.mkdirSync(path.join(stateRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(stateRoot(), id, 'voice-error.json'), `${JSON.stringify({ stage: 'voicing', code, reason: VOICE_REASONS[code] }, null, 1)}
`);
    } catch { /* Private diagnostics are best effort and never change the job result. */ }
  }

  // Fixed text and numbers only, like planner-error.json. Never model output, never a path.
  function writeTooShortDiagnostic(id, requested, measured, source) {
    try {
      fs.mkdirSync(path.join(stateRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(stateRoot(), id, 'too-short.json'), `${JSON.stringify({
        stage: 'voicing', code: 'too_short', reason: 'The measured video length is more than the allowed seconds under the requested duration.',
        requested_seconds: requested, video_seconds: measured, short_by_seconds: Math.round((requested - measured) * 1000) / 1000, allowed_short_seconds: shortToleranceFor(requested), source,
      }, null, 1)}
`);
    } catch { /* Private diagnostics are best effort and never change the job result. */ }
  }
  // Counts and fixed text only, like too-short.json. Never claim text, source text or model output.
  function writeFactDiagnostic(id, summary) {
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    try {
      fs.mkdirSync(path.join(stateRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(stateRoot(), id, 'fact-check-error.json'), `${JSON.stringify({
        stage: 'factchecking', code: summary?.retrieval === false ? 'retrieval_unavailable' : summary?.claims === undefined ? 'fact_check_failed' : 'fact_check_blocked',
        reason: summary?.retrieval === false ? 'No independent source retrieval was available, so nothing could be verified.' : summary?.claims === undefined ? 'The fact check step could not run.' : 'The fact check did not verify every claim in the script.',
        false_claims: n(summary?.false_claims), uncertain_claims: n(summary?.uncertain_claims), other_reasons: n(summary?.other_reasons), claims: n(summary?.claims),
      }, null, 1)}
`);
    } catch { /* Private diagnostics are best effort and never change the job result. */ }
  }
  /** The finished video length the voice gives: voice.json video_seconds, else words.json dur + lead + tail. null when neither is measured. */
  function measuredVideoSeconds(voice, words) {
    try {
      if (voice?.manifestPath) {
        const seconds = JSON.parse(fs.readFileSync(voice.manifestPath, 'utf8'))?.video_seconds;
        if (Number.isFinite(seconds) && seconds > 0) return { seconds, source: 'voice.json' };
      }
    } catch { /* fall back to the measured words */ }
    const seconds = Number.isFinite(voice?.metrics?.video_seconds) && voice.metrics.video_seconds > 0 ? voice.metrics.video_seconds : null;
    if (seconds) return { seconds, source: 'voice metrics' };
    return Number.isFinite(words?.dur) && words.dur > 0 ? { seconds: words.dur + LEAD_S + TAIL_S, source: 'words.json' } : null;
  }

  // ---- KAN-934: the visual loop ---------------------------------------------------------------------------------------------------
  const loopPieces = () => (visualLoop && typeof visualLoop === 'object' ? visualLoop : {});
  /** Proves, before any script call is paid for, that the installed CLI really takes pictures. Cached per process and CLI version. */
  async function probeFor({ rec, stage, signal }) {
    const injected = loopPieces();
    if (typeof injected.probe === 'function') return injected.probe({ rec, stage, signal });
    const sheetMaker = injected.sheetMaker ?? createPreviewSheetMaker({ execFileFn: hostExecFile });
    return probeLookSupport({
      nonce: `p${crypto.randomBytes(6).toString('hex')}`, stageDir: path.join(stage, 'loop'), model: 'sonnet', signal,
      makeCanary: (args) => sheetMaker.makeCanary(args), askFn: (prompt, images, options) => (injected.askLook ?? defaultAskLook)(prompt, images, options),
    });
  }
  /** The loop between planning and building. Returns { buildScript, receipt }; throws a StartError and never returns a script that was not looked at. */
  async function runLoopFor({ rec, stage, signal, scripted, voice, pathPack, plan, pl, runtime, probe, addCall, onPhase }) {
    const injected = loopPieces();
    const { nframes, shotStarts } = plan;
    if (!Number.isInteger(nframes) || !Array.isArray(shotStarts) || !shotStarts.length) throw new StartError('look_failed', 502);
    const shots = shotStarts.map((start, i) => {
      const s = Array.isArray(scripted.shots) ? scripted.shots[i] : null;
      return { subject: clip(s?.subject, 200) || `part ${i + 1}`, narration: clip(s?.narration, 400) || `the narration from ${Number(start).toFixed(1)} s` };
    });
    const validate = typeof plan.validate === 'function' ? plan.validate : injected.validate ?? ((code) => {
      if (typeof pl.validateBuildScript !== 'function') return ['no build validator is available'];
      const why = [...pl.validateBuildScript(code, { nframes, shotStarts })];
      if (!why.length && typeof pl.pythonSyntaxCheck === 'function') { const bad = pl.pythonSyntaxCheck(code); if (bad) why.push(`Python syntax error, ${bad}`); }
      if (!why.length && typeof pl.pythonQaStructureCheck === 'function') { const structure = pl.pythonQaStructureCheck(code); if (Array.isArray(structure)) why.push(...structure); }
      return why;
    });
    const sheetMaker = injected.sheetMaker ?? createPreviewSheetMaker({ execFileFn: hostExecFile });
    const runPreview = injected.runPreview ?? createPreviewRunFn({ runner: runtime.runner, inputs: { script: scripted.script, voWav: voice.voPath, words: voice.wordsPath, pathPack, brief: scripted.brief }, jobRoot: jobsDir });
    const run = injected.runLoop ?? runVisualBuildLoop;
    try {
      return await run({
        jobId: rec.id, stageDir: stage, brief: scripted.brief, script: scripted.script, shots, shotStarts, nframes, buildScript: plan.buildScript, kitContract: plan.kitContract ?? pl.KIT_CONTRACT,
        validate, probe, lookModel: 'sonnet', signal,
      }, {
        runPreview, makeSheets: (args) => sheetMaker.makeSheets(args), askLook: injected.askLook ?? defaultAskLook, askText: injected.askText ?? defaultAskText,
        onCall: addCall, onPhase,
      });
    } catch (error) {
      if (signal.aborted || error?.code === 'aborted') throw new StartError('aborted');
      throw new StartError(LOOP_START_CODES.has(error?.code) ? error.code : 'look_failed', 502);
    }
  }
  /** Host-written beside cost_calls.json after the final render; the draft adapter reduces it to hashes, counts and verdicts. */
  function writeLoopReceipt(id, receipt) {
    if (!receipt) return;
    try { fs.writeFileSync(path.join(jobsDir, id, 'visual_loop.json'), `${JSON.stringify(receipt, null, 1)}\n`); } catch { /* the draft is made without it; nothing is faked */ }
  }

  async function execute(rec, controller) {
    const { signal } = controller;
    const allCalls = [];
    // Planners report calls both through onCall and in their result. Preserve each event once by object identity.
    const addCall = (c) => {
      if (c && typeof c === 'object' && !allCalls.includes(c)) { allCalls.push(c); writeCalls(rec.id, allCalls); }
    };
    // One sanitized record per router attempt, appended through addCall so earlier calls are never overwritten.
    const onCallRecord = (record) => { const call = sanitizeRouterCall(record); if (call) addCall(call); };
    const stage = path.join(stateRoot(), rec.id);
    const checkAbort = () => { if (signal.aborted) throw new StartError('aborted'); };
    // Attempts made before this job existed (the batch's topic pick) are costed with the job, like any other router call.
    for (const c of rec.preCalls ?? []) addCall(c);
    const pl = await importPlanner();
    // 1. Fail early and free when the launch is not approved: no TTS, no model call, no folder beyond the status file.
    const runtime = await (async () => {
      try { return await composeFor([stage]); } catch (error) {
        if (error instanceof StartError) throw error;
        throw new StartError(error?.code === 'LAUNCH_NOT_APPROVED' || /LAUNCH_NOT_APPROVED|not approved/i.test(String(error?.message)) ? 'launch_not_approved' : 'runner_unavailable', 409);
      }
    })();
    checkAbort();

    // 1b. The visual check must be possible before anything is paid for: one small probe proves the CLI takes pictures (KAN-934).
    let probe = null;
    if (visualLoop !== false) {
      try { probe = await probeFor({ rec, stage, signal }); } catch (error) {
        if (signal.aborted || error?.code === 'aborted') throw new StartError('aborted');
        throw new StartError('look_unavailable', 502);
      }
      checkAbort();
    }

    // 2. Script
    step(rec, 'scripting');
    let scripted;
    try {
      const fn = scriptStage ?? pl.planCodebuiltScript;
      if (typeof fn !== 'function') throw new StartError('script_unavailable', 501);
      scripted = await fn({ topic: rec.topic, duration: rec.duration, signal, ...(rec.choices ? { choices: rec.choices } : {}) }, { onCall: addCall });
    } catch (error) { throw error instanceof StartError ? error : signal.aborted ? new StartError('aborted') : new StartError('script_failed', 502); }
    if (!scripted || typeof scripted.script !== 'string' || !scripted.script.trim() || typeof scripted.brief !== 'string') throw new StartError('script_failed', 502);
    for (const c of scripted.calls ?? []) addCall(c);
    // The real paths/codebuilt.json pack comes from the planner. A script result without one cannot be built, and nothing is spent on voice first.
    if (!scripted.pathPack || typeof scripted.pathPack !== 'object' || scripted.pathPack.id !== 'codebuilt' || !Array.isArray(scripted.pathPack.skills)) throw new StartError('script_failed', 502);
    // Private stage artifacts remain reviewable even when a later step fails. They contain no CLI output.
    try {
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(path.join(stage, 'script.txt'), scripted.script);
      fs.writeFileSync(path.join(stage, 'shots.json'), `${JSON.stringify(scripted.shots, null, 2)}\n`);
      fs.writeFileSync(path.join(stage, 'brief.md'), scripted.brief);
      fs.writeFileSync(path.join(stage, 'pathpack.json'), `${JSON.stringify(scripted.pathPack, null, 2)}\n`);
    } catch { /* audit artifacts are best effort and do not block a run */ }
    checkAbort();

    // 2b. Fact check (owner-started batch videos only; the single-job route is unchanged). Nothing is spent on voice or build when it does not verify.
    if (rec.factCheck) {
      step(rec, 'factchecking');
      if (typeof factCheckStage !== 'function') throw new StartError('fact_check_unavailable', 501);
      let verdict;
      try { verdict = await factCheckStage({ topic: rec.topic, script: scripted.script, contentMode: rec.choices?.type ?? rec.contentMode ?? 'factual', signal, onCallRecord }); } catch (error) {
        if (signal.aborted) { writeFactDiagnostic(rec.id, { error: true }); throw new StartError('aborted'); }
        // No retrieval backend (or none that can be validated) is its own named failure, never filed as a fact problem and never passed.
        if (error?.code === 'retrieval_unavailable') { writeFactDiagnostic(rec.id, { retrieval: false }); throw new StartError('retrieval_unavailable', 503); }
        writeFactDiagnostic(rec.id, { error: true });
        throw new StartError('fact_check_failed', 502);
      }
      if (verdict?.facts && typeof verdict.facts === 'object') {
        try { fs.writeFileSync(path.join(stage, 'facts.json'), `${JSON.stringify(verdict.facts, null, 1)}
`); } catch { /* audit artifact only */ }
      }
      checkAbort();
      if (verdict?.verified !== true) { writeFactDiagnostic(rec.id, verdict?.summary); throw new StartError('fact_check_blocked', 422); }
    }

    // 3. Voice: the existing TTS stage and measured word times (an estimate is refused by the voice module).
    step(rec, 'voicing');
    fs.mkdirSync(stage, { recursive: true });
    createEpisodeDir(episodesRoot, `cb-${rec.id}`);
    let voice;
    try {
      voice = await voiceStage({ script: scripted.script, voice: rec.voice, outDir: stage, allowedRoot: jobsDir, episodeDir: `cb-${rec.id}`, episodesRoot, runId: rec.id, onCall: addCall, ...(postFactoryFn ? { postFactoryFn } : {}) });
    } catch (error) {
      writeVoiceDiagnostic(rec.id, error);
      throw new StartError('voice_failed', 502);
    }
    checkAbort();

    // 4. Planner writes the build script from the topic, script, measured words and path pack.
    step(rec, 'planning');
    const words = JSON.parse(fs.readFileSync(voice.wordsPath, 'utf8'));
    // The requested length is a promise: a voice that leaves the finished video well under it stops the job before the planner and the build spend anything.
    const measured = measuredVideoSeconds(voice, words);
    if (measured && rec.duration - measured.seconds > shortToleranceFor(rec.duration)) {
      writeTooShortDiagnostic(rec.id, rec.duration, Math.round(measured.seconds * 1000) / 1000, measured.source);
      throw new StartError('too_short', 422);
    }
    const pathPack = scripted.pathPack;
    let plan;
    try {
      if (typeof pl.planCodebuiltBuild !== 'function') throw new StartError('planner_unavailable', 501);
      plan = await pl.planCodebuiltBuild({ topic: rec.topic, duration: rec.duration, script: scripted.script, brief: scripted.brief, words, pathPack, signal, buildModel: rec.buildModel, ...(rec.choices ? { choices: rec.choices } : {}) }, { onCall: addCall, onRefused: refusedBuildWriter(rec.id) });
    } catch (error) {
      if (signal.aborted) throw new StartError('aborted');
      writePlannerDiagnostic(rec.id, error);
      if (error?.code === 'build_model_unavailable' || error?.message === 'build_model_unavailable') {
        throw new StartError('build_model_unavailable', 501);
      }
      throw error instanceof StartError ? error : new StartError('planner_failed', 502);
    }
    if (!plan || typeof plan.buildScript !== 'string' || !plan.buildScript.trim()) {
      writePlannerDiagnostic(rec.id, { code: 'PLANNER_ERROR' });
      throw new StartError('planner_failed', 502);
    }
    for (const c of plan.calls ?? []) addCall(c);
    checkAbort();

    // 4b. The visual loop (KAN-934): preview the planned build in the same offline executor, look at the sheets, fix what is wrong, look again
    // (three looks at most). Only the accepted script goes on to the final render; a build that cannot be looked at is never rendered unseen.
    let buildScript = plan.buildScript;
    let loopReceipt = null;
    if (visualLoop !== false) {
      const outcome = await runLoopFor({ rec, stage, signal, scripted, voice, pathPack, plan, pl, runtime, probe, addCall, onPhase: (name) => { if (name === 'previewing' || name === 'looking') step(rec, name); } })
        .finally(() => writeCalls(rec.id, allCalls));
      if (!outcome || outcome.accepted !== true || typeof outcome.buildScript !== 'string' || !outcome.buildScript.trim() || sha(outcome.buildScript) !== outcome.sha256) throw new StartError('look_failed', 502);
      buildScript = outcome.buildScript;
      loopReceipt = outcome.receipt;
      checkAbort();
    }

    // 5. Build in the isolated runner. The job request has no say in image, command or limits.
    step(rec, 'building');
    try {
      await runtime.runner.run({
        jobId: rec.id, kind: 'generated-code', timeoutMs: TIMEOUT_MS[rec.duration], signal,
        script: scripted.script, voWav: voice.voPath, words: voice.wordsPath, pathPack, brief: scripted.brief, buildScript,
      });
    } catch (error) {
      writeCalls(rec.id, allCalls);
      if (signal.aborted || error?.code === 'ABORTED') throw new StartError('aborted');
      if (error?.code === 'LAUNCH_NOT_APPROVED') throw new StartError('launch_not_approved', 409);
      throw new StartError('build_failed', 502);
    }
    writeCalls(rec.id, allCalls, true);
    writeLoopReceipt(rec.id, loopReceipt);
    checkAbort();

    // 6. Titles and tags are the only model-authored draft metadata. Failures retain the topic fallback.
    step(rec, 'drafting');
    let metadata = {};
    try { metadata = (await (lightMetadataStage ?? produceLightMetadata)(rec.topic, { askRoleFn, onCallRecord })) ?? {}; } catch { metadata = {}; }
    checkAbort();
    // Whatever produced the metadata, only a schema-valid title and tag list reach the draft; otherwise the topic fallback stands.
    const title = validateTitle(metadata) ? metadata.title : undefined;
    const tags = validateTags(metadata) ? metadata.tags : undefined;
    try {
      const out = toDraft({ jobId: rec.id, channelId: rec.channelId ?? defaultChannelId, topic: rec.topic, ...(title ? { title, metadataSource: 'light_router' } : {}), ...(tags ? { tags } : {}), jobsDir, ...(draftsDir ? { draftsDir } : {}) });
      rec.draftId = out?.id ?? out?.draftId ?? draftIdForJob(rec.id);
      // KAN-933: requested versus actual seconds. The probed video length (draft metadata) wins over the voice estimate; a miss is recorded, never patched by stretching audio.
      const probed = out?.metadata?.social?.duration_seconds;
      const check = lengthCheck(rec.duration, Number.isFinite(probed) && probed > 0 ? probed : null);
      if (check) rec.length_check = check;
    } catch { throw new StartError('draft_failed', 500); }
  }

  async function pump() {
    if (running || !waiting.length) return;
    const id = waiting.shift();
    const entry = live.get(id);
    if (!entry) return pump();
    const { rec, controller } = entry;
    if (controller.signal.aborted) { settle(rec, new StartError('aborted')); return pump(); }
    running = id;
    try { await execute(rec, controller); settle(rec, null); } catch (error) { settle(rec, error); } finally { running = null; void pump(); }
  }
  function settle(rec, error) {
    if (!error) { rec.status = 'done'; rec.step = 'done'; rec.error = null; }
    else {
      const e = error instanceof StartError ? error : new StartError('internal', 500);
      rec.status = e.code === 'aborted' ? 'aborted' : 'failed'; rec.error = { code: e.code, message: e.message };
    }
    try { save(rec); live.delete(rec.id); } catch { /* Keep the terminal record live and queryable when persistence fails. */ }
  }

  return {
    version: START_VERSION,
    /** Queues a job and returns at once; the work continues in the background. */
    start(input, internal = {}) {
      const req = checkStartRequest(input);
      // `internal` is never read from an HTTP body: only the batch coordinator passes it, in process.
      const batch = internal && internal.factCheck === true && typeof internal.runId === 'string' && JOB_ID.test(internal.runId);
      // The batch's validated genre/theme/type travel with the job to the script, the fact check and the planner. A malformed value is refused, never dropped.
      let choices = null;
      if (batch && internal.choices !== undefined) { try { choices = normalizeProductionChoices(internal.choices); } catch { throw new StartError('bad_request'); } }
      const id = newId();
      if (!JOB_ID.test(id)) throw new StartError('internal', 500);
      const rec = { version: START_VERSION, id, topic: req.topic, duration: req.duration, voice: req.voice, channelId: req.channelId ?? null, buildModel: req.buildModel, status: 'queued', step: 'queued', steps: [{ step: 'queued', at: clock() }], createdAt: clock(), updatedAt: clock(), draftId: null, error: null, topicSha: sha(req.topic).slice(0, 12),
        ...(batch ? { factCheck: true, runId: internal.runId, batchIndex: Number.isInteger(internal.batchIndex) ? internal.batchIndex : null, contentMode: choices ? choices.type : internal.contentMode === 'whatif' ? 'whatif' : 'factual', ...(choices ? { choices } : {}), preCalls: Array.isArray(internal.preCalls) ? internal.preCalls.slice(0, 20) : [] } : {}) };
      save(rec);
      live.set(id, { rec, controller: new AbortController() });
      waiting.push(id);
      void pump();
      return publicJob(rec);
    },
    get(id) { const rec = load(id); if (!rec) throw new StartError('not_found', 404); return publicJob(rec); },
    list() {
      const out = new Map([...live.values()].map(({ rec }) => [rec.id, rec]));
      try { for (const name of fs.readdirSync(stateRoot())) if (!out.has(name) && JOB_ID.test(name)) { const rec = load(name); if (rec) out.set(name, rec); } } catch { /* none yet */ }
      return [...out.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50).map(publicJob);
    },
    /** Aborts a queued or running job. The runner stops the fence; a finished job cannot be aborted. */
    abort(id) {
      const rec = load(id);
      if (!rec) throw new StartError('not_found', 404);
      const entry = live.get(id);
      if (!entry) throw new StartError('conflict', 409);
      entry.controller.abort();
      if (rec.status === 'queued') { const at = waiting.indexOf(id); if (at >= 0) waiting.splice(at, 1); settle(rec, new StartError('aborted')); }
      return publicJob(rec);
    },
    /** Resolves when the job has settled (tests and graceful shutdown). */
    async idle() { while (running || waiting.length) await new Promise((r) => setTimeout(r, 5)); },
  };
}

let shared = null;
/** The process-wide starter used by the routes. Tests pass their own through setCodebuiltStarter(). */
export function codebuiltStarter() { return (shared ??= createCodebuiltStarter()); }
export function setCodebuiltStarter(starter) { shared = starter; }
