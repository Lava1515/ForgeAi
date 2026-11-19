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
//   planCodebuiltDirection and authorBuildPrompt prepare the sole author (authorLoop.js).
// calls ([{step, provider, model, wall_s, input_tokens, output_tokens, retries}]) are written to <job>/cost_calls.json (read by codebuiltToDraft).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, episodeRoot, createEpisodeDir } from '../artifacts.js';
import { jobsRoot, codebuiltToDraft, draftIdForJob } from './draftAdapter.js';
import { runCodebuiltVoice, checkVoiceFiles, LEAD_S, TAIL_S, REASONS as VOICE_ERROR_REASONS } from './voice.js';
import { normaliseScript } from '../voice.js';
import { normalizeJobCalls } from '../../perf/creationCost.js';
import { lengthCheck, LENGTH_TOLERANCE_S } from './lengthCheck.js';
import { GENERATED_GPU_EXECUTOR_ID } from '../engines/codebuilt/launch.js';
import { produceLightMetadata, validateTitle, validateTags } from './lightMetadata.js';
import { loadCodebuiltGuides, runWithJobFormats, cleanJobFormats } from './skills.js';
import { channelJobFormats } from './autoTopic.js';
import { askRole } from '../../routes/askRole.js';
import { postFactory } from '../../routes/factoryClient.js';
import { checkFinalExposure } from './exposureCheck.js';
import { runAuthorFor, authorCaps } from './authorLoop.js';
import { checkAuthorConfig } from './authorCall.js';
import { hostExecFile } from './hostEffects.js';
import { sanitizeRouterCall } from './routerCalls.js';
import { defaultFactCheckStage } from './factCheckStage.js';
import { normalizeProductionChoices } from './productionChoices.js';
import { overlayPair, validateOverlayPair, validateOverlaySpec } from './overlaySpec.js';
import { frameCountFor } from './planner.js';
import { jobWriteBlockedReason, writeHostJobReceipt } from './hostJobReceipts.js';
import { readJobState } from '../engines/codebuilt/jobState.js';
import { STATE_DIR as STATE_DIR_NAME } from '../engines/codebuilt/jobFolder.js';

// Production default is the real router. Under `node --test` (NODE_TEST_CONTEXT is set by the runner) the default refuses before any CLI
// is spawned, so a rig that never injects askRoleFn cannot reach a model; tests that want metadata inject askRoleFn or lightMetadataStage.
const defaultAskRole = (...args) => process.env.NODE_TEST_CONTEXT
  ? Promise.reject(new Error('model calls are disabled under the test runner'))
  : askRole(...args);

const clip = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '');

// codex · gpt-6.1-sol · 2026-11-17 18:03 +02:00: exact route contract, shared with the batch boundary.
// C4: old route strings remain readable; every run uses one author.
export const JOB_ROUTES = Object.freeze(['authored']);
export function checkJobRoute(route, ErrorType = StartError) {
  if (route != null && typeof route !== 'string') throw new ErrorType('bad_request');
  return 'authored';
}
export function effectiveJobRoute(route) { return checkJobRoute(route); }

export const START_VERSION = 'codebuilt-start-v1';
export const DURATIONS = Object.freeze([30, 45, 60, 90]);
export const BUILD_MODELS = Object.freeze(['Auto', 'Sonnet', 'Opus', 'Fable', 'Codex Sol']);
export const TOPIC_MAX = 200;
export const ACTIVE = Object.freeze(['queued', 'scripting', 'factchecking', 'voicing', 'planning', 'previewing', 'looking', 'building', 'drafting']);
export const FINAL = Object.freeze(['done', 'failed', 'aborted', 'interrupted']);
export const STAGE_DIR = '.start';
// How many times a job may rewrite its script for the voice's measured pace after a too_long or too_short voice (see execute).
export const LENGTH_RETRIES = 1;
// Refusals of a voice recording that a second recording can cure (see the voice step in execute).
// The voice engine derives its seeds from the text, so recording the same script again gives the same audio: a retry asks for
// another base seed (VOICE_RETRY_SEED + attempt) and so gets a different take. The pace gate alone does not cure every bad take:
// job mwgt0zmz-c75642 (2026-11-14 21:40) had sound from 0.03 s but its first word aligned at 0.40 s (audio_not_matching).
export const VOICE_RETRIES = 1;
export const VOICE_RETRY_SEED = 7919;
export const VOICE_RETRY_REASONS = Object.freeze(['audio_not_matching', 'bad_tail', 'bad_lead', 'bad_word_times', 'timing_mismatch']);
// The finished video may be this many seconds under the requested duration before the job stops (TTS pace varies; see planner.js targetWords).
// 60 and 90 s keep 4 s; the shorter videos scale it (about 7 percent) so a 30 s request cannot finish at 26 s.
// Widened on 2026-11-14 (was 2, 3, 4, 4 s): a voice's pace varies by 10 to 20 percent from script to script, so a 45 s request that
// came out at 41 s stopped the job before anything was built. The owner's stated limit is on running OVER (5 to 10 s is fine, 20 s
// is not); a short that is a few seconds under its length is still a finished short.
export const SHORT_TOLERANCE_S = 8;
export const SHORT_TOLERANCE_BY_DURATION_S = Object.freeze({ 30: 5, 45: 7, 60: SHORT_TOLERANCE_S, 90: SHORT_TOLERANCE_S });
export const shortToleranceFor = (duration) => SHORT_TOLERANCE_BY_DURATION_S[duration] ?? SHORT_TOLERANCE_S;
export function measuredLengthFailure(requested, measured) {
  if (!measured) return null;
  if (requested - measured.seconds > shortToleranceFor(requested)) return 'too_short';
  if (measured.seconds - requested > LENGTH_TOLERANCE_S) return 'too_long';
  return null;
}
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/;
// The isolated Blender build renders on 4 CPUs at about 4 s a frame (measured 2026-11-13: 15 frames a minute), about 1930 frames for 60 s and 2900 for 90 s.
// The first limits (90 and 120 minutes) killed a healthy run; these are about 1.5 times the measured need and stay under the runner's 6 hour ceiling.
// 30 s is about 900 frames (60 minutes -> 1.5 h) and 45 s about 1350 frames (90 minutes -> 2.25 h).
export const TIMEOUT_MS = Object.freeze({ 30: 1.5 * 60 * 60 * 1000, 45: 2.25 * 60 * 60 * 1000, 60: 3 * 60 * 60 * 1000, 90: 4.5 * 60 * 60 * 1000 });
const MESSAGES = Object.freeze({
  author_layout_unavailable: 'The author layout check could not cover the required frames; nothing was rendered',
  author_render_over_ceiling: 'The last preview cannot establish a final render within the configured ceiling; nothing was rendered',
  bad_request: 'Invalid request', invalid_id: 'Invalid job id', not_found: 'Not found', conflict: 'The job is not in a state that allows this',
  launch_not_approved: 'The code-built launch is not approved yet (waiting for the security activation); nothing was started',
  planner_unavailable: 'The code-built planner is not available', script_unavailable: 'The code-built script writer is not available',
  runner_unavailable: 'The code-built runner is not available', script_failed: 'The script step failed', voice_failed: 'The voice step failed',
  author_caps_unmeasured: 'Author caps have not been measured', author_state_outside_code: 'Author config must resolve inside the repository', author_model_unavailable: 'Only Sonnet may author', author_transport_unavailable: 'Author transport probe failed', author_rounds: 'Author preview limit reached', author_time: 'Author time limit reached', author_calls: 'Author call limit reached', author_tokens: 'Author token limit reached', author_context_full: 'Author context limit reached', author_tool_event: 'Author tool event refused', tools_offered: 'Author tools refused', author_receipt: 'Author receipt mismatch', author_hash: 'Author accepted pair changed', author_reply: 'Author replies refused', author_failed: 'Author failed',
  planner_failed: 'The planner step failed', too_short: 'The voice is too short for the requested video length', too_long: 'The voice is too long for the requested video length', build_failed: 'The build failed', draft_failed: 'The draft could not be written', aborted: 'Aborted by the owner', interrupted: 'The server restarted while the job ran', internal: 'The job failed', build_model_unavailable: 'The requested build model is not available',
  fact_check_blocked: 'The fact check did not verify the script', fact_check_failed: 'The fact check step failed', fact_check_unavailable: 'The fact check is not available',
  retrieval_unavailable: 'The fact check could not retrieve and validate independent sources; no voice or build was started',
  look_unavailable: 'The visual check could not run (the Claude CLI could not look at pictures, is not logged in, or hit its usage limit); nothing was rendered',
  look_failed: 'The visual check did not approve the build within three looks; nothing was rendered',
  claude_limit: 'Claude usage limit reached; resume after the reset',
  loop_timeout: 'The visual check ran out of time; nothing was rendered',
  preview_failed: 'The preview render could not be made; nothing was rendered',
  // Fix 2 (fable-check-2): a post layout refusal is its own named end, with the blocking list, and the render is kept.
  overlay_layout_blocked: 'The overlay layout has blocking findings; the frames are kept, resume with a corrected overlay to finish without a new render',
  overlay_correction_required: 'This job stopped on an overlay layout refusal; resume needs a corrected overlay (the frames are kept, no new render)',
  overlay_correction_invalid: 'The corrected overlay was refused',
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
/** The job's own end for a post layout refusal: its code, and the bounded blocking list the post kit reported. */
const layoutBlockedError = (error) => Object.assign(new StartError('overlay_layout_blocked', 422), { blocking: Array.isArray(error?.detail?.blocking) ? error.detail.blocking : [] });
const now =() => new Date().toISOString();

// codex · gpt-6.1-sol · 2026-11-16 08:56 +02:00: shared across starter instances.
// Voice bypasses the render fence, so it must share this lease with previews/render.
const gpuWaiters = [];
let gpuBusy = false;
function drainGpu() {
  if (gpuBusy || !gpuWaiters.length) return;
  gpuBusy = true;
  const next = gpuWaiters.shift();
  next.signal.removeEventListener('abort', next.abort);
  next.resolve(() => { gpuBusy = false; drainGpu(); });
}
async function withGpu(signal, jobsDir, action) {
  const release = await new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new StartError('aborted')); return; }
    const waiter = { signal, resolve, abort: () => {
      const index = gpuWaiters.indexOf(waiter);
      if (index >= 0) gpuWaiters.splice(index, 1);
      reject(new StartError('aborted'));
    } };
    signal.addEventListener('abort', waiter.abort, { once: true });
    gpuWaiters.push(waiter);
    drainGpu();
  });
  try {
    if (signal.aborted) throw new StartError('aborted');
    // A quarantined container may still own the GPU. Voice fails closed too,
    // including after restart, until fence cleanup has been confirmed.
    const locks = path.join(jobsDir, '.cb6-locks');
    if (jobWriteBlockedReason(jobsDir, 'gpu-phase-check')) throw new StartError('conflict', 409);
    try {
      if (fs.readdirSync(locks).some((name) => name.endsWith('.lock'))) throw new StartError('conflict', 409);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await action();
  } finally { release(); }
}

/** Validates a start request: topic text and a supported duration. Duration is requested, never silently changed. */
export function checkStartRequest(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new StartError('bad_request');
  if (Object.keys(input).some((k) => !['topic', 'duration', 'voice', 'channelId', 'buildModel', 'type', 'formats', 'route'].includes(k))) throw new StartError('bad_request');
  if (input.type !== undefined && (typeof input.type !== 'string' || !['auto', 'factual', 'whatif', 'history'].includes(input.type.trim().toLowerCase()))) throw new StartError('bad_request');
  const route = checkJobRoute(input.route);
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
  return { route, topic, duration, voice: input.voice ?? 'aiden', channelId: input.channelId, buildModel };
}

// The shape that leaves the server: no path, no stack, only the generic message.
export function publicJob(rec) {
  if (!rec) return null;
  const { id, topic, duration, status, step, createdAt, updatedAt, error, draftId, steps, buildModel, length_check: lengthCheckRec, runId, batchIndex } = rec;
  return { route: checkJobRoute(rec.route), id, topic, duration, status, step: step ?? null, createdAt, updatedAt, draftId: draftId ?? null, steps: steps ?? [], error: error ? { code: error.code, message: error.message, ...(Array.isArray(error.blocking) ? { blocking: error.blocking } : {}) } : null, ...(rec.post_correction ? { post_correction: rec.post_correction } : {}), ...(rec.visual_check ? { visual_check: rec.visual_check } : {}), ...(buildModel ? { buildModel } : {}), ...(lengthCheckRec ? { length_check: lengthCheckRec } : {}), ...(runId ? { runId, batchIndex } : {}), ...(rec.resumes?.length ? { resumes: rec.resumes } : {}) };
}

export function createCodebuiltStarter({
  jobsDir = jobsRoot(), episodesRoot = episodeRoot(), draftsDir, defaultChannelId,
  scriptStage, planner, composeRunner, voiceStage = runCodebuiltVoice, toDraft = codebuiltToDraft, clock = now, newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
  postFactoryFn, inputRoot, lightMetadataStage, askRoleFn = defaultAskRole, factCheckStage = defaultFactCheckStage,
  authorLoop = {},
} = {}) {
  const stateRoot = () => path.join(jobsDir, STAGE_DIR);
  const recFile = (id) => path.join(stateRoot(), id, 'status.json');
  const live = new Map(); // id -> { rec, controller }
  const resumeData = new Map(); // private validated artifacts; never written to status.json
  const waiting = []; // bounded lookahead: one current job and one preparing job
  const running = new Set();

  const save = (rec) => {
    rec.updatedAt = clock();
    fs.mkdirSync(path.dirname(recFile(rec.id)), { recursive: true });
    atomicWrite(path.dirname(recFile(rec.id)), 'status.json', `${JSON.stringify(rec, null, 1)}\n`);
  };
  const safeRegular = (file, maxBytes = 4 * 1024 * 1024) => {
    try {
      const root = path.resolve(jobsDir); const target = path.resolve(file);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
      let current = path.dirname(target);
      while (current !== root && current.startsWith(`${root}${path.sep}`)) {
        const st = fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) return false;
        current = path.dirname(current);
      }
      const st = fs.lstatSync(target); return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= maxBytes;
    } catch { return false; }
  };
  const safeDirectory = (directory) => {
    try {
      const root = path.resolve(jobsDir); const target = path.resolve(directory);
      if (target === root || !target.startsWith(`${root}${path.sep}`)) return false;
      let current = target;
      while (current !== root && current.startsWith(`${root}${path.sep}`)) {
        const st = fs.lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) return false;
        current = path.dirname(current);
      }
      return true;
    } catch { return false; }
  };
  const readSafe = (file, encoding = 'utf8', maxBytes) => safeRegular(file, maxBytes) ? fs.readFileSync(file, encoding) : null;
  // codex · gpt-6.1-sol · 2026-11-17 17:25 +02:00
  function reusable(id) {
    // Locks live outside container-writable folders. Refuse before reading any reuse artifact,
    // including when cleanup of any preview belonging to this parent is uncertain.
    const blockedReason = jobWriteBlockedReason(jobsDir, id);
    if (blockedReason) return { blockedReason, reused: [], resumeFrom: null };
    try {
      if (fs.readdirSync(path.join(jobsDir,'.cb6-locks')).some(name => name.startsWith(`${id}-a`) && /^-a[0-9]+-pv[0-9]+\.lock$/.test(name.slice(id.length)))) return {blockedReason:'Preview lock is held; cleanup must be confirmed before resuming',reused:[],resumeFrom:null};
    } catch (error) { if (error.code !== 'ENOENT') return {blockedReason:'Job lock directory is unreadable',reused:[],resumeFrom:null}; }
    const stage = path.join(stateRoot(), id);
    const rec = load(id);
    const script = readSafe(path.join(stage, 'script.txt')); const brief = readSafe(path.join(stage, 'brief.md'));
    let pathPack = null; try { pathPack = JSON.parse(readSafe(path.join(stage, 'pathpack.json')) || 'null'); } catch {}
    const scriptOk = typeof script === 'string' && !!script.trim() && typeof brief === 'string' && !!brief.trim() && pathPack?.id === 'codebuilt' && Array.isArray(pathPack.skills);
    let voice = null; let words = null; let voiceOk = false;
    try {
      const manifestText = readSafe(path.join(stage, 'voice.json')); const wav = readSafe(path.join(stage, 'vo.wav'), null, 64 * 1024 * 1024); const wordText = readSafe(path.join(stage, 'words.json'), 'utf8', 32 * 1024 * 1024);
      const manifest = JSON.parse(manifestText || 'null'); words = JSON.parse(wordText || 'null');
      const wavHash = wav ? sha(wav) : null;
      voiceOk = scriptOk && !!wavHash && manifest?.script_sha256 === sha(normaliseScript(script).text) && manifest?.audio_sha256 === wavHash && Array.isArray(words?.words) && words.words.length > 0;
      const integrityText = readSafe(path.join(stage, 'resume-integrity.json'));
      if (integrityText) {
        const integrity = JSON.parse(integrityText);
        voiceOk = voiceOk && integrity.script_sha256 === sha(script) && integrity.voice_sha256 === sha(manifestText) && integrity.audio_sha256 === wavHash && integrity.words_sha256 === sha(wordText);
      }
      if (voiceOk) checkVoiceFiles({ wav, doc: words, scriptWords: normaliseScript(script).words, source: manifest.word_timing_source });
      if (voiceOk) voice = { voPath: path.join(stage, 'vo.wav'), wordsPath: path.join(stage, 'words.json'), manifestPath: path.join(stage, 'voice.json'), metrics: manifest };
    } catch { voiceOk = false; voice = null; }
    const reused = [];
    if (scriptOk) reused.push('script');
    if (voiceOk) reused.push('voice');
    const postOnly = postOnlyArtifacts(rec.exposure_return?`${id}-expose`:id, rec, stage, scriptOk && voiceOk, words ? frameCountFor(words) : 0);
    if (postOnly?.ok) reused.push('frames');
    const resumeFrom = postOnly?.ok ? (postOnly.completed ? 'drafting' : 'post') : !scriptOk ? 'scripting' : !voiceOk ? 'voicing' : 'planning';
    let scriptMeta = {}; try { scriptMeta = JSON.parse(readSafe(path.join(stage, 'script-meta.json')) || '{}'); } catch {}
    return { scriptOk, voiceOk, build: null, scripted: scriptOk ? { script, brief, pathPack, shots: Array.isArray(scriptMeta.shots) ? scriptMeta.shots : [], ...(Array.isArray(scriptMeta.factTable) ? { factTable: scriptMeta.factTable } : {}), ...(scriptMeta.endingCheck ? { endingCheck: scriptMeta.endingCheck } : {}) } : null, voice, words, reused, resumeFrom, postOnly };
  }

  // Fix 2: a job that ended on overlay_layout_blocked keeps its rendered frames. It can finish from the post step alone when the host's own
  // records still tie the pieces together: the runner's state names the refusal and the frames it left (hashed on the host), the accepted build
  // and overlay form a valid pair whose build hash is the one the job ran, and the overlay in the job is that pair's, or the last corrected one.
  // Light checks only (no frame hashing): jobStatus calls this for every failed job. The runner re-checks the frames before it posts.
  const overlayBytesSha = (spec) => sha(`${JSON.stringify(spec, null, 2)}\n`);
  const postResumeFile = (stage) => path.join(stage, 'post-resume', 'overlay.json');
  function postOnlyArtifacts(id, rec, stage, ready, savedFrames) {
    if (!rec) return null;
    const no = (reason) => ({ ok: false, reason });
    // The runner's own record decides, not the job record: a post-only attempt that failed for another reason leaves it as the refusal it was.
    let state; try { state = readJobState(path.join(jobsDir, STATE_DIR_NAME, `${id}.json`)); } catch { return null; }
    const completed = state?.status === 'complete' && state.postOnly === true && state.kind === 'generated-code' && state.cleanupUncertain !== true;
    if (!completed && state?.failure?.code !== 'OVERLAY_LAYOUT_BLOCKED') return null;
    const refusal = completed ? { frames: { count: savedFrames }, build_sha256: state.inputs?.['build/build.py'] } : state?.refusal;
    if (!ready) return no('The saved script or voice cannot be reused');
    if ((!completed && (state.status !== 'failed' || !refusal?.frames?.sha256)) || !Number.isInteger(refusal?.frames?.count) || refusal.frames.count < 1) return no('No post layout refusal with kept frames is recorded');
    const dir = path.join(stage, 'author');
    try {
      const code = readSafe(path.join(dir, 'accepted.build.py'));
      if (!code || !code.trim()) return no('The accepted build is missing');
      const videoSeconds = refusal.frames.count / 30;
      const acceptedSpec = validateOverlayPair(JSON.parse(readSafe(path.join(dir, 'accepted.overlay.json')) || 'null'), code, { videoSeconds });
      if (sha(code) !== state.inputs?.['build/build.py'] || refusal.build_sha256 !== sha(code)) return no('The accepted build is not the build the job ran');
      let currentSpec = acceptedSpec;
      if (state.inputs?.['overlay.json'] !== overlayBytesSha(acceptedSpec)) {
        // A corrected overlay that was refused again is the job's overlay now; it must be the one this module saved, as a valid pair.
        const saved = readSafe(postResumeFile(stage));
        currentSpec = saved ? validateOverlayPair(JSON.parse(saved), code, { videoSeconds }) : null;
        if (!currentSpec || state.inputs?.['overlay.json'] !== overlayBytesSha(currentSpec)) return no('The overlay in the job is not the accepted or the last corrected overlay');
      }
      let receipt;
      receipt = JSON.parse(readSafe(path.join(dir, 'receipt.json')) || 'null');
      if (!receipt || typeof receipt !== 'object') return no('The accepted look receipt is missing');
      return { ok: true, completed, buildScript: code, nframes: refusal.frames.count, currentSpec, originalOverlaySha256: refusal.overlay_sha256 ?? state.inputs['overlay.json'], receipt, blocking: Array.isArray(refusal.blocking) ? refusal.blocking : [] };
    } catch { return no('The accepted build and overlay are not a valid pair'); }
  }
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
    if (!Array.isArray(calls)) return;
    const bytes = `${JSON.stringify({ calls: normalizeJobCalls(calls).map(({ tokens, ...call }) => ({ ...call, input_tokens: tokens?.input ?? null, output_tokens: tokens?.output ?? null })) }, null, 1)}\n`;
    try {
      const dir = path.join(stateRoot(), id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cost_calls.json'), bytes);
    } catch { /* host-only cost history is best effort */ }
    // Only successful runner completion establishes container exit and output audit.
    if (createJobDir) writeHostJobReceipt(jobsDir, id, 'cost_calls.json', bytes);
  }

  /** The fact check the job already passed (receipt, else a verified facts.json), or null. Shared by a normal resume and a post-only resume. */
  function restoreFactCheck(stage) {
    try {
      const receipt = JSON.parse(readSafe(path.join(stage, 'fact-check.json')) || 'null');
      if (receipt && receipt.verified === true && receipt.summary) return receipt;
      const facts = JSON.parse(readSafe(path.join(stage, 'facts.json')) || 'null');
      if (facts && (facts.verified === true || facts.status === 'verified') && facts.blocked !== true) {
        return {
          verified: true,
          summary: {
            claims: Array.isArray(facts.claims) ? facts.claims.length : null,
            false_claims: Array.isArray(facts.false_claims) ? facts.false_claims.length : 0,
            uncertain_claims: Array.isArray(facts.uncertain_claims) ? facts.uncertain_claims.length : 0,
          },
        };
      }
    } catch { /* unverified */ }
    return null;
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
  function writeTooLongDiagnostic(id, requested, measured, source) {
    try {
      fs.mkdirSync(path.join(stateRoot(), id), { recursive: true });
      fs.writeFileSync(path.join(stateRoot(), id, 'too-long.json'), `${JSON.stringify({
        stage: 'voicing', code: 'too_long', reason: 'The measured video length is more than the allowed seconds over the requested duration.',
        requested_seconds: requested, video_seconds: measured, over_by_seconds: Math.round((measured - requested) * 1000) / 1000, allowed_over_seconds: LENGTH_TOLERANCE_S, source,
      }, null, 1)}\n`);
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

  /** Host-written beside cost_calls.json after the final render; the draft adapter reduces it to hashes, counts and verdicts. */
  function writeLoopReceipt(id, receipt) {
    writeHostJobReceipt(jobsDir, id, 'visual_loop.json', `${JSON.stringify(receipt, null, 1)}\n`);
  }

  async function execute(rec, controller) {
    rec.route = checkJobRoute(rec.route);
    // A post-only resume asks the author for nothing, so it does not need the author caps or config.
    if (!resumeData.get(rec.id)?.postOnlyRun) { try { authorCaps({capsFile:authorLoop.capsFile}); checkAuthorConfig(authorLoop); } catch(error) { throw new StartError(error.code,409); } }
    const { signal } = controller;
    let verifiedFactCheck = null;
    const resume = resumeData.get(rec.id) ?? null;
    let priorCalls = [];
    if (resume) { try { const existing = JSON.parse(fs.readFileSync(path.join(stateRoot(), rec.id, 'cost_calls.json'), 'utf8')); priorCalls = Array.isArray(existing.calls) ? existing.calls : []; } catch {} }
    const allCalls = priorCalls;
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

    // 1a. Fix 2: a job that ended on overlay_layout_blocked finishes from the post step with a corrected overlay and its kept frames.
    // No script, voice, planner, look or render step runs; the runner re-checks the frames and every input before it posts.
    if (resume?.postOnlyRun) {
      const post = resume.postOnly, finalJobId=rec.exposure_return?`${rec.id}-expose`:rec.id;
      step(rec, 'building');
      const correctedPair = overlayPair(post.buildScript, resume.postOnlyRun.overlaySpec, { videoSeconds: post.nframes / 30 });
      const correctionDir = path.dirname(postResumeFile(stage));
      // codex · gpt-6.1-sol · 2026-11-18: reject host-stage links before the producer or any corrected-pair write.
      if (!safeDirectory(stage)) throw new StartError('overlay_correction_invalid', 409);
      try { if (!fs.existsSync(correctionDir)) fs.mkdirSync(correctionDir); } catch { throw new StartError('overlay_correction_invalid', 409); }
      if (!safeDirectory(correctionDir) || (fs.existsSync(postResumeFile(stage)) && !safeRegular(postResumeFile(stage)))) throw new StartError('overlay_correction_invalid', 409);
      const saveCorrected = () => {
        if (!safeDirectory(correctionDir)) throw new StartError('overlay_correction_invalid', 409);
        atomicWrite(correctionDir, 'overlay.json', `${JSON.stringify(correctedPair, null, 1)}\n`);
      };
      try {
        if (typeof runtime.runner.runPostOnly !== 'function') throw new StartError('runner_unavailable', 501);
        await runtime.runner.runPostOnly({ jobId: finalJobId, buildScript: post.buildScript, overlaySpec: resume.postOnlyRun.overlaySpec, signal, completed: post.completed === true });
        // Persist the pair even if cancellation arrived just after the runner committed; later recovery only drafts.
        saveCorrected();
      } catch (error) {
        writeCalls(rec.id, allCalls);
        if (error instanceof StartError) throw error;
        if (signal.aborted || error?.code === 'ABORTED') throw new StartError('aborted');
        if (error?.code === 'OVERLAY_LAYOUT_BLOCKED') { saveCorrected(); throw layoutBlockedError(error); }
        throw new StartError('build_failed', 502);
      }
      // codex · gpt-6.1-sol · 2026-11-18 18:11 +02:00: cancellation precedes host completion receipts.
      checkAbort();
      saveCorrected();
      writeCalls(rec.id, allCalls, true);
      if(finalJobId!==rec.id)writeCalls(finalJobId,allCalls,true);
      writeLoopReceipt(finalJobId, post.receipt);
      if (rec.premise) writeHostJobReceipt(jobsDir, finalJobId, 'premise.json', `${JSON.stringify(rec.premise, null, 2)}\n`);
      rec.post_correction = { at: clock(), refused_overlay_sha256: post.originalOverlaySha256 ?? null, corrected_overlay_sha256: overlayBytesSha(correctedPair.spec), blocking_refused: post.blocking.length, rendered_again: false };
      await draftStage(resume.scripted, rec.factCheck ? restoreFactCheck(stage) : null);
      return;
    }

    // 2 to 4a. Script, fact check, voice and the length check run at most twice. A voice whose real pace differs from the planned one
    // gives a video that is too long or too short; instead of stopping there (job mwg83rd6-959255: serena read 112 words in 54.6 s,
    // 11.4 s over), the script is written once more for the pace that was just measured, and voiced again. A second miss stops the job.
    let scripted; let voice; let words; let measured;
    // codex / gpt-6.1-sol / 2026-11-19 14:30 +02:00: script and correction use the same job-confined author transport.
    const scriptDeps = () => ({ onCall: addCall,
      askAuthor: authorLoop.askAuthor,
      authorOptions: { ...authorLoop, workRoot: path.join(stage, 'author', 'calls') },
    });
    // codex · gpt-6.1-sol · 2026-11-19 14:24 +02:00: one fact repair per topic, including length rewrites.
    let factRewriteUsed = false;
    let measuredPace = null;
    for (let lengthAttempt = 0; ; lengthAttempt += 1) {
    const fresh = lengthAttempt > 0; // the retry reuses nothing from a resume: its script and voice are the ones being replaced
    // 2. Script
    scripted = resume?.scriptOk && !fresh ? resume.scripted : null;
    if (!scripted) {
    step(rec, 'scripting');
    try {
      const fn = scriptStage ?? pl.planCodebuiltScript;
      if (typeof fn !== 'function') throw new StartError('script_unavailable', 501);
      scripted = await fn({ route: checkJobRoute(rec.route), buildModel: rec.buildModel, topic: rec.topic, duration: rec.duration, voice: rec.voice, signal, ...(rec.autoDuration && !rec.durationSelected ? { autoDuration: true } : {}), ...(measuredPace ? { pace: measuredPace } : {}), ...(rec.choices ? { choices: rec.choices } : {}), ...(rec.premise ? { premise: rec.premise } : {}) }, scriptDeps());
    } catch (error) { throw error instanceof StartError ? error : signal.aborted ? new StartError('aborted') : error?.quota === true ? new StartError('claude_limit', 502) : new StartError('script_failed', 502); }
    }
    if (!scripted || typeof scripted.script !== 'string' || !scripted.script.trim() || typeof scripted.brief !== 'string') throw new StartError('script_failed', 502);
    // codex / gpt-6.1-sol / 2026-11-16 09:06 +02:00: S2 selects Auto once.
    // Retries and resumes retain this duration; manual requests ignore the override.
    if (rec.autoDuration && !rec.durationSelected) {
      if (![30, 45, 60].includes(scripted.duration)) throw new StartError('script_failed', 502);
      rec.duration = scripted.duration;
      rec.durationSelected = true;
      save(rec);
    }
    for (const c of scripted.calls ?? []) addCall(c);
    // The real paths/codebuilt.json pack comes from the planner. A script result without one cannot be built, and nothing is spent on voice first.
    if (!scripted.pathPack || typeof scripted.pathPack !== 'object' || scripted.pathPack.id !== 'codebuilt' || !Array.isArray(scripted.pathPack.skills)) throw new StartError('script_failed', 502);
    // Private stage artifacts remain reviewable even when a later step fails. They contain no CLI output.
    try { fs.mkdirSync(stage, { recursive: true }); } catch { /* audit artifacts are best effort */ }
    const saveScriptArtifacts = () => {
      // codex · gpt-6.1-sol, 2026-11-15 16:32 +02:00: retain ending verdict for proof and resume.
      for (const [name, value] of [['script.txt', scripted.script], ['shots.json', `${JSON.stringify(scripted.shots ?? [], null, 2)}\n`], ['brief.md', scripted.brief], ['pathpack.json', `${JSON.stringify(scripted.pathPack, null, 2)}\n`], ['script-meta.json', `${JSON.stringify({ shots: scripted.shots ?? [], ...(scripted.factTable ? { factTable: scripted.factTable } : {}), ...(scripted.endingCheck ? { endingCheck: scripted.endingCheck } : {}) })}\n`]]) {
        try { fs.writeFileSync(path.join(stage, name), value); } catch { /* one failed audit artifact does not skip the others */ }
      }
    };
    saveScriptArtifacts();
    checkAbort();

    // 2b. Fact check (owner-started batch videos only; the single-job route is unchanged). Nothing is spent on voice or build when it does not verify.
    if (rec.factCheck && (!resume?.voiceOk || fresh)) {
      step(rec, 'factchecking');
      if (typeof factCheckStage !== 'function') throw new StartError('fact_check_unavailable', 501);
      const checkOnce = async (text) => {
        let verdict;
        try { verdict = await factCheckStage({ topic: rec.topic, script: text, contentMode: rec.choices?.type ?? rec.contentMode ?? 'factual', signal, onCallRecord }); } catch (error) {
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
        return verdict;
      };
      let verdict = await checkOnce(scripted.script);
      checkAbort();
      // Owner, 2026-11-14: a script the check does not verify is written again once from the check's findings, and checked again. It still blocks after that.
      if (verdict?.verified !== true && !factRewriteUsed) {
        const facts = verdict?.facts;
        const blocked = ['claims', 'false_claims', 'uncertain_claims'].flatMap((key) => Array.isArray(facts?.[key]) ? facts[key] : [])
          .filter((x) => x && (x.verdict === 'contradicted' || x.verdict === 'uncertain'));
        const corrections = blocked.filter((x, i) => blocked.findIndex((claim) => claim.text === x.text) === i)
          .map((x) => ({ text: x.text, problem: x.verdict, evidence: x.verdict === 'contradicted' ? x.sources?.[0]?.passage : undefined }));
        if (corrections.length) {
          factRewriteUsed = true;
          step(rec, 'scripting');
          let again;
          try {
            const fn = scriptStage ?? pl.planCodebuiltScript;
            again = await fn({ route: checkJobRoute(rec.route), buildModel: rec.buildModel, topic: rec.topic, duration: rec.duration, voice: rec.voice, signal, corrections, ...(measuredPace ? { pace: measuredPace } : {}), ...(rec.choices ? { choices: rec.choices } : {}), ...(rec.premise ? { premise: rec.premise } : {}) }, scriptDeps());
          } catch (error) { throw error instanceof StartError ? error : signal.aborted ? new StartError('aborted') : error?.quota === true ? new StartError('claude_limit', 502) : new StartError('script_failed', 502); }
          if (again && typeof again.script === 'string' && again.script.trim() && typeof again.brief === 'string' && again.pathPack?.id === 'codebuilt') {
            for (const call of again.calls ?? []) addCall(call);
            scripted = again;
            saveScriptArtifacts();
            checkAbort();
            step(rec, 'factchecking');
            verdict = await checkOnce(scripted.script);
          }
        }
      }
      checkAbort();
      if (verdict?.verified !== true) { writeFactDiagnostic(rec.id, verdict?.summary); throw new StartError('fact_check_blocked', 422); }
      verifiedFactCheck = {
        verified: true,
        summary: {
          claims: Number.isInteger(verdict?.summary?.claims) ? verdict.summary.claims : (Array.isArray(verdict?.facts?.claims) ? verdict.facts.claims.length : null),
          false_claims: Number.isInteger(verdict?.summary?.false_claims) ? verdict.summary.false_claims : (Array.isArray(verdict?.facts?.false_claims) ? verdict.facts.false_claims.length : 0),
          uncertain_claims: Number.isInteger(verdict?.summary?.uncertain_claims) ? verdict.summary.uncertain_claims : (Array.isArray(verdict?.facts?.uncertain_claims) ? verdict.facts.uncertain_claims.length : 0),
        },
      };
      try {
        fs.writeFileSync(path.join(stage, 'fact-check.json'), `${JSON.stringify(verifiedFactCheck, null, 1)}\n`);
      } catch { /* audit artifact only */ }
    } else if (rec.factCheck) {
      verifiedFactCheck = restoreFactCheck(stage);
    }

    // 3. Voice: the existing TTS stage and measured word times (an estimate is refused by the voice module).
    voice = resume?.voiceOk && !fresh ? resume.voice : null;
    if (!voice) {
    step(rec, 'voicing');
    fs.mkdirSync(stage, { recursive: true });
    // A job resumed at the voice step already has its episode folder from the first attempt: that is not a conflict. Without this
    // every Resume from "voicing" failed at once as "The job failed" (job mwg5e6hs-e826b9, 2026-11-14 10:37).
    try { createEpisodeDir(episodesRoot, `cb-${rec.id}`); } catch (error) { if (!((resume || fresh) && error?.code === 'conflict')) throw error; }
    try {
      // The voice is generated with fresh random seeds every time, and now and then one sentence comes out wrong (a long ramble, a
      // clipped start), so the recording does not line up with its own word times and is refused. Recording again usually works: the
      // Sun video of 2026-11-14 (job mwg5e6hs-e826b9) failed on audio_not_matching after one sentence took 44 s to generate. One retry,
      // only for refusals of the recording itself; a wrong script, a missing service or an abort is not retried.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const basePost = postFactoryFn ?? postFactory;
          const post = attempt === 0 ? postFactoryFn : (route, body, ...rest) => basePost(route, route === '/api/tts-timed' ? { ...body, seed: VOICE_RETRY_SEED + attempt } : body, ...rest);
          voice = await withGpu(signal, jobsDir, () => voiceStage({ script: scripted.script, ...(Array.isArray(scripted.shots) && scripted.shots.length ? { beats: scripted.shots } : {}), voice: rec.voice, outDir: stage, allowedRoot: jobsDir, episodeDir: `cb-${rec.id}`, episodesRoot, runId: rec.id, onCall: addCall, ...(post ? { postFactoryFn: post } : {}) }));
          break;
        } catch (error) {
          if (attempt >= VOICE_RETRIES || signal.aborted || !VOICE_RETRY_REASONS.includes(error?.reason)) throw error;
          writeVoiceDiagnostic(rec.id, error);
        }
      }
      const manifestBytes = fs.readFileSync(voice.manifestPath); const audioBytes = fs.readFileSync(voice.voPath); const wordsBytes = fs.readFileSync(voice.wordsPath);
      fs.writeFileSync(path.join(stage, 'resume-integrity.json'), `${JSON.stringify({ script_sha256: sha(scripted.script), voice_sha256: sha(manifestBytes), audio_sha256: sha(audioBytes), words_sha256: sha(wordsBytes) })}\n`);
    } catch (error) {
      writeVoiceDiagnostic(rec.id, error);
      throw new StartError('voice_failed', 502);
    }
    checkAbort();
    }

    // 4. Planner writes the build script from the topic, script, measured words and path pack.
    words = JSON.parse(fs.readFileSync(voice.wordsPath, 'utf8'));
    // The requested length is a promise: a voice that leaves the finished video well under it stops the job before the planner and the build spend anything.
    measured = measuredVideoSeconds(voice, words);
    const lengthFailure = measuredLengthFailure(rec.duration, measured);
    if (lengthFailure && lengthAttempt < LENGTH_RETRIES && Array.isArray(words?.words) && words.words.length >= 20 && Number.isFinite(words.dur) && words.dur > 5) {
      // Words per second of this voice on this script, pauses included: what the next script is sized for.
      measuredPace = Math.round((words.words.length / words.dur) * 100) / 100;
      if (lengthFailure === 'too_short') writeTooShortDiagnostic(rec.id, rec.duration, Math.round(measured.seconds * 1000) / 1000, measured.source);
      else writeTooLongDiagnostic(rec.id, rec.duration, Math.round(measured.seconds * 1000) / 1000, measured.source);
      checkAbort();
      continue;
    }
    if (lengthFailure === 'too_short') {
      writeTooShortDiagnostic(rec.id, rec.duration, Math.round(measured.seconds * 1000) / 1000, measured.source);
      throw new StartError('too_short', 422);
    }
    if (lengthFailure === 'too_long') {
      writeTooLongDiagnostic(rec.id, rec.duration, Math.round(measured.seconds * 1000) / 1000, measured.source);
      throw new StartError('too_long', 422);
    }
    break;
    }
    const pathPack = scripted.pathPack;
    // codex | gpt-6.1-sol | 2026-11-19 19:33 +02:00: persist one final-exposure return before another author attempt.
    for (;;) {
    const finalJobId=rec.exposure_return?`${rec.id}-expose`:rec.id;
    let plan;
    {
      step(rec,'planning');
      try { plan = await withGpu(signal,jobsDir,()=>runAuthorFor({rec,stage,signal,scripted,voice,pathPack,pl,runtime,jobsDir,hostExecFile,injected:authorLoop,addCall,onPhase:name=>step(rec,name)})); }
      catch(error) {
        if(signal.aborted || error.aborted) throw new StartError('aborted');
        if(error.quota || error.detail?.reason === 'quota') throw new StartError('claude_limit',502);
        if(error.unavailable || error.code === 'look_unavailable') throw new StartError('look_unavailable',502);
        throw new StartError(error.timedOut ? 'author_time' : error.code?.startsWith('author_') || error.code === 'tools_offered' ? error.code : 'author_failed',502);
      }
    }
    if (!plan?.overlaySpec) throw new StartError('planner_failed',502);
    if (!plan || typeof plan.buildScript !== 'string' || !plan.buildScript.trim()) {
      writePlannerDiagnostic(rec.id, { code: 'PLANNER_ERROR' });
      throw new StartError('planner_failed', 502);
    }
    for (const c of plan.calls ?? []) addCall(c);
    checkAbort();

    // The author accepted this exact scene and text pair after looking at its frames.
    await withGpu(signal, jobsDir, async () => {
      checkAbort();
      const buildScript = plan.buildScript;
      plan.verifyReceipt();
      const loopReceipt = plan.receipt;
      {
        const accepted = validateOverlayPair(JSON.parse(readSafe(path.join(stage,'author','accepted.overlay.json')) || 'null'),buildScript,{videoSeconds:plan.nframes/30});
        if (!loopReceipt || JSON.stringify(accepted) !== JSON.stringify(plan.overlaySpec)) throw new StartError('look_failed',502);
      }
      if (rec.route === 'authored') { try { plan.verifyReceipt(); } catch(error) { throw new StartError(error.code,502); } }
      // 5. Build in the isolated runner. The job request has no say in image, command or limits.
      step(rec, 'building');
      try {
        await runtime.runner.run({
          route: checkJobRoute(rec.route), jobId: finalJobId, kind: 'generated-code', timeoutMs: TIMEOUT_MS[rec.duration] ?? 60 * 60 * 1000, signal,
          script: scripted.script, voWav: voice.voPath, words: voice.wordsPath, pathPack, brief: scripted.brief, buildScript, ...(plan.overlaySpec ? {overlaySpec: plan.overlaySpec} : {}),
        });
      } catch (error) {
        writeCalls(rec.id, allCalls);
        if (signal.aborted || error?.code === 'ABORTED') throw new StartError('aborted');
        if (error?.code === 'LAUNCH_NOT_APPROVED') throw new StartError('launch_not_approved', 409);
        if (error?.code === 'OVERLAY_LAYOUT_BLOCKED') throw layoutBlockedError(error);
        throw new StartError('build_failed', 502);
      }
      // F6 uses the existing black_region result; the repair has its own fenced job folder.
      rec.exposure_check = await (authorLoop.checkFinalExposure??checkFinalExposure)({jobDir:path.join(jobsDir,finalJobId),execFileFn:hostExecFile,signal});
      writeCalls(rec.id, allCalls, true);
      if(finalJobId!==rec.id)writeCalls(finalJobId,allCalls,true);
      writeLoopReceipt(finalJobId, loopReceipt);
      if (rec.premise) writeHostJobReceipt(jobsDir, finalJobId, 'premise.json', `${JSON.stringify(rec.premise, null, 2)}\n`);
      checkAbort();
    });

    if (!rec.exposure_return && rec.exposure_check?.tiles?.some(tile=>tile.issues?.includes('black_region'))) {
      rec.exposure_return=true;save(rec);continue;
    }
    break;
    }
    await draftStage(scripted, verifiedFactCheck);

    // 6. Titles and tags are the only model-authored draft metadata. Failures retain the topic fallback. (A function so a post-only resume
    // reaches the same step with the saved script and fact check; the body is unchanged.)
    async function draftStage(scripted, verifiedFactCheck) {
    const pathPack = scripted.pathPack;
    step(rec, 'drafting');
    let metadata = {};
    let publishGuide = ''; try { publishGuide = loadCodebuiltGuides({ pack: pathPack, step: 'publish' }); } catch { /* no guide: topic-only prompts */ }
    try { metadata = (await (lightMetadataStage ?? produceLightMetadata)(rec.topic, { askRoleFn, onCallRecord, script: scripted.script, premise: rec.premise ?? null, guide: publishGuide })) ?? {}; } catch { metadata = {}; }
    checkAbort();
    // Whatever produced the metadata, only a schema-valid title and tag list reach the draft; otherwise the topic fallback stands.
    const title = validateTitle(metadata) ? metadata.title : undefined;
    const tags = validateTags(metadata) ? metadata.tags : undefined;
    try {
      const draftJobId=rec.exposure_return?`${rec.id}-expose`:rec.id;
      const out = toDraft({ videoType: rec.contentMode, jobId: draftJobId, channelId: rec.channelId ?? defaultChannelId, topic: rec.topic, ...(rec.premise ? { premise: rec.premise } : {}), ...(title ? { title, metadataSource: 'light_router' } : {}), ...(tags ? { tags } : {}), jobsDir, ...(draftsDir ? { draftsDir } : {}), requestedDuration: rec.duration, ...(verifiedFactCheck ? { factCheck: verifiedFactCheck } : {}) });
      rec.draftId = out?.id ?? out?.draftId ?? draftIdForJob(draftJobId);
      // KAN-933: requested versus actual seconds. The probed video length (draft metadata) wins over the voice estimate; a miss is recorded, never patched by stretching audio.
      const probed = out?.metadata?.social?.duration_seconds;
      const check = lengthCheck(rec.duration, Number.isFinite(probed) && probed > 0 ? probed : null);
      if (check) rec.length_check = check;
    } catch { throw new StartError('draft_failed', 500); }
    }
  }

  function pump() {
    while (running.size < 2 && waiting.length) {
      const id = waiting.shift();
      const entry = live.get(id);
      if (!entry) continue;
      const { rec, controller } = entry;
      if (controller.signal.aborted) { settle(rec, new StartError('aborted')); continue; }
      running.add(id);
      void (async () => {
        try { await runWithJobFormats(rec.formats, () => execute(rec, controller)); settle(rec, null); }
        catch (error) { settle(rec, controller.signal.aborted ? new StartError('aborted') : error); }
        finally { running.delete(id); pump(); }
      })();
    }
  }
  function settle(rec, error) {
    if (!error) { rec.status = 'done'; rec.step = 'done'; rec.error = null; }
    else {
      const e = error instanceof StartError ? error : new StartError('internal', 500);
      rec.status = e.code === 'aborted' ? 'aborted' : 'failed'; rec.error = { code: e.code, message: e.message, ...(Array.isArray(e.blocking) ? { blocking: e.blocking } : {}) };
    }
    try { save(rec); live.delete(rec.id); } catch { /* Keep the terminal record live and queryable when persistence fails. */ }
    resumeData.delete(rec.id);
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
      const type = typeof input?.type === 'string' ? input.type.trim().toLowerCase() : choices?.type;
      const id = newId();
      if (!JOB_ID.test(id)) throw new StartError('internal', 500);
      const rec = { version: START_VERSION, route: req.route, id, topic: req.topic, duration: req.duration, voice: req.voice, channelId: req.channelId ?? null, buildModel: req.buildModel, status: 'queued', step: 'queued', steps: [{ step: 'queued', at: clock() }], createdAt: clock(), updatedAt: clock(), draftId: null, error: null, topicSha: sha(req.topic).slice(0, 12),
        ...(batch ? { autoDuration: internal.autoDuration === true, factCheck: true, runId: internal.runId, batchIndex: Number.isInteger(internal.batchIndex) ? internal.batchIndex : null, contentMode: choices ? choices.type : internal.contentMode === 'whatif' ? 'whatif' : internal.contentMode === 'history' ? 'history' : 'factual', ...(choices ? { choices } : {}), ...(internal.premise ? { premise: internal.premise } : {}), preCalls: Array.isArray(internal.preCalls) ? internal.preCalls.slice(0, 20) : [] } : {}) };
      // F1: the job's formats (from the topic pick, else from the channel profile) choose format skills and sets at every step.
      const formats = cleanJobFormats([...(Array.isArray(input?.formats) ? input.formats : []), ...(Array.isArray(internal?.premise?.formats) ? internal.premise.formats : channelJobFormats(req.channelId ?? defaultChannelId, type))]);
      // codex · gpt-6.1-sol · 2026-11-17 13:53 +02:00: typed topics must pass the journey topic gate first.
      if (formats.includes('journey')) {
        if (type === 'teardown' || !batch || !internal.premise || !['thing','move','story_question','ending_answer','turn','who','want'].every(k => typeof internal.premise[k] === 'string' && internal.premise[k].trim()) || !Array.isArray(internal.premise.landmarks) || internal.premise.landmarks.length < 3 || !internal.premise.counter || !Number.isFinite(internal.premise.last_number)) throw new StartError('bad_request');
      }
      rec.route = effectiveJobRoute(req.route, formats);
      if (formats.length) { rec.formats = formats; if (rec.premise) rec.premise = {...rec.premise,formats}; }
      if (type === 'history') {
        rec.contentMode = 'history';
        rec.factCheck = true;
        rec.choices = { genre: choices?.genre ?? null, theme: choices?.theme ?? null, type: 'history' };
      }
      if (live.has(id) || fs.existsSync(recFile(id))) throw new StartError('conflict', 409);
      save(rec);
      live.set(id, { rec, controller: new AbortController() });
      waiting.push(id);
      void pump();
      return publicJob(rec);
    },
    get(id) { const rec = load(id); if (!rec) throw new StartError('not_found', 404); return jobStatus(rec); },
    list() {
      const out = new Map([...live.values()].map(({ rec }) => [rec.id, rec]));
      try { for (const name of fs.readdirSync(stateRoot())) if (!out.has(name) && JOB_ID.test(name)) { const rec = load(name); if (rec) out.set(name, rec); } } catch { /* none yet */ }
      return [...out.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50).map(jobStatus);
    },
    /**
     * Resumes a failed or aborted job. `options.correctedOverlay` (an overlay spec object, never a path) is used only for a job that ended on
     * overlay_layout_blocked with its frames kept: the job then finishes from the post step with that overlay and no second render.
     * Such a job refuses a resume without a correction (the same overlay would be refused again), and any other job refuses a correction.
     */
    resume(id, options = {}) {
      const rec = load(id);
      if (!rec) throw new StartError('not_found', 404);
      if (!['failed', 'aborted'].includes(rec.status)) throw new StartError('conflict', 409);
      if (running.size > 0 || waiting.some((queuedId) => queuedId !== id) || [...live.values()].some(({ rec: item }) => item.id !== id && ACTIVE.includes(item.status))) throw new StartError('conflict', 409);
      const route = effectiveJobRoute(checkJobRoute(rec.route), rec.formats);
      const artifacts = reusable(id);
      if (artifacts.blockedReason) throw new StartError('conflict', 409);
      const corrected = options?.correctedOverlay;
      const post = artifacts.postOnly?.ok === true ? artifacts.postOnly : null;
      let postOnlyRun = null;
      if (corrected !== undefined && !post) throw new StartError('overlay_correction_invalid', 409);
      if (post?.completed) {
        if (corrected !== undefined) throw new StartError('overlay_correction_invalid', 409);
        postOnlyRun = { overlaySpec: post.currentSpec };
      } else if (post) {
        if (corrected === undefined) throw new StartError('overlay_correction_required', 409);
        let spec; try { spec = validateOverlaySpec(corrected, { videoSeconds: post.nframes / 30 }); } catch { throw new StartError('overlay_correction_invalid', 400); }
        if (overlayBytesSha(spec) === overlayBytesSha(post.currentSpec)) throw new StartError('overlay_correction_invalid', 400);
        postOnlyRun = { overlaySpec: spec };
      }
      rec.route = route;
      rec.resumes = Array.isArray(rec.resumes) ? rec.resumes : [];
      rec.resumes.push({ at: clock(), fromStep: artifacts.resumeFrom, reused: artifacts.reused });
      rec.status = 'queued'; rec.step = 'queued'; rec.error = null; rec.resumeFrom = artifacts.resumeFrom; resumeData.set(rec.id, { ...artifacts, ...(postOnlyRun ? { postOnlyRun } : {}) });
      rec.steps = Array.isArray(rec.steps) ? rec.steps : [];
      rec.steps.push({ step: 'resume', at: clock() });
      save(rec); live.set(id, { rec, controller: new AbortController() }); waiting.push(id); void pump();
      return jobStatus(rec);
    },
    /** Aborts a queued or running job. The runner stops the fence; a finished job cannot be aborted. */
    abort(id) {
      const rec = load(id);
      if (!rec) throw new StartError('not_found', 404);
      const entry = live.get(id);
      if (!entry) throw new StartError('conflict', 409);
      entry.controller.abort();
      if (!running.has(id) && rec.status === 'queued') { const at = waiting.indexOf(id); if (at >= 0) waiting.splice(at, 1); settle(rec, new StartError('aborted')); }
      return publicJob(rec);
    },
    /** Resolves when the job has settled (tests and graceful shutdown). */
    async idle() { while (running.size || waiting.length) await new Promise((r) => setTimeout(r, 5)); },
  };

  function jobStatus(rec) {
    const otherActive = [...running].some((id) => id !== rec.id) || waiting.some((queuedId) => queuedId !== rec.id) || [...live.values()].some(({ rec: item }) => item.id !== rec.id && ACTIVE.includes(item.status));
    const resumable = ['failed', 'aborted'].includes(rec.status);
    const artifacts = resumable ? reusable(rec.id) : null;
    const blockedReason = artifacts?.blockedReason ?? (resumable && otherActive ? 'Another code-built job is active' : null);
    const priorResume = rec.resumes?.at(-1);
    return { ...publicJob(rec), resumable: resumable && !blockedReason, ...(resumable && artifacts.postOnly?.ok && !artifacts.postOnly.completed ? { resumeNeeds: 'corrected_overlay' } : {}), resumeFrom: resumable ? artifacts.resumeFrom : priorResume?.fromStep ?? null, reuses: resumable ? artifacts.reused : priorResume?.reused ?? [], ...(blockedReason ? { resumeBlockedReason: blockedReason } : {}) };
  }
}

let shared = null;
/** The process-wide starter used by the routes. Tests pass their own through setCodebuiltStarter(). */
export function codebuiltStarter() { return (shared ??= createCodebuiltStarter()); }
export function setCodebuiltStarter(starter) { shared = starter; }
