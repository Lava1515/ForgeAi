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
import { runCodebuiltVoice, checkVoiceFiles, LEAD_S, TAIL_S, REASONS as VOICE_ERROR_REASONS } from './voice.js';
import { normaliseScript } from '../voice.js';
import { normalizeJobCalls } from '../../perf/creationCost.js';
import { lengthCheck, LENGTH_TOLERANCE_S } from './lengthCheck.js';
import { GENERATED_GPU_EXECUTOR_ID } from '../engines/codebuilt/launch.js';
import { produceLightMetadata, validateTitle, validateTags } from './lightMetadata.js';
import { askRole } from '../../routes/askRole.js';
import { postFactory } from '../../routes/factoryClient.js';
import { askClaude } from '../../routes/claudeCli.js';
import { runVisualBuildLoop } from './visualLoop.js';
import { probeLookSupport, askClaudeLook } from './lookCall.js';
import { createPreviewSheetMaker } from './previewSheet.js';
import { hostExecFile } from './hostEffects.js';
import { createPreviewRunFn } from '../engines/codebuilt/composePreview.js';
import { sanitizeRouterCall } from './routerCalls.js';
import { defaultFactCheckStage } from './factCheckStage.js';
import { normalizeProductionChoices } from './productionChoices.js';
import { frameCountFor, shotStartsFor, validateBuildScript } from './planner.js';
import { jobWriteBlockedReason, writeHostJobReceipt } from './hostJobReceipts.js';

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
  bad_request: 'Invalid request', invalid_id: 'Invalid job id', not_found: 'Not found', conflict: 'The job is not in a state that allows this',
  launch_not_approved: 'The code-built launch is not approved yet (waiting for the security activation); nothing was started',
  planner_unavailable: 'The code-built planner is not available', script_unavailable: 'The code-built script writer is not available',
  runner_unavailable: 'The code-built runner is not available', script_failed: 'The script step failed', voice_failed: 'The voice step failed',
  planner_failed: 'The planner step failed', too_short: 'The voice is too short for the requested video length', too_long: 'The voice is too long for the requested video length', build_failed: 'The build failed', draft_failed: 'The draft could not be written', aborted: 'Aborted by the owner', interrupted: 'The server restarted while the job ran', internal: 'The job failed', build_model_unavailable: 'The requested build model is not available',
  fact_check_blocked: 'The fact check did not verify the script', fact_check_failed: 'The fact check step failed', fact_check_unavailable: 'The fact check is not available',
  retrieval_unavailable: 'The fact check could not retrieve and validate independent sources; no voice or build was started',
  look_unavailable: 'The visual check could not run (the Claude CLI could not look at pictures, is not logged in, or hit its usage limit); nothing was rendered',
  look_failed: 'The visual check did not approve the build within three looks; nothing was rendered',
  claude_limit: 'Claude usage limit reached; resume after the reset',
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
  if (Object.keys(input).some((k) => !['topic', 'duration', 'voice', 'channelId', 'buildModel', 'type'].includes(k))) throw new StartError('bad_request');
  if (input.type !== undefined && (typeof input.type !== 'string' || !['auto', 'factual', 'whatif', 'history'].includes(input.type.trim().toLowerCase()))) throw new StartError('bad_request');
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
  return { id, topic, duration, status, step: step ?? null, createdAt, updatedAt, draftId: draftId ?? null, steps: steps ?? [], error: error ? { code: error.code, message: error.message } : null, ...(rec.visual_check ? { visual_check: rec.visual_check } : {}), ...(buildModel ? { buildModel } : {}), ...(lengthCheckRec ? { length_check: lengthCheckRec } : {}), ...(runId ? { runId, batchIndex } : {}), ...(rec.resumes?.length ? { resumes: rec.resumes } : {}) };
}

export function createCodebuiltStarter({
  jobsDir = jobsRoot(), episodesRoot = episodeRoot(), draftsDir, defaultChannelId,
  scriptStage, planner, composeRunner, voiceStage = runCodebuiltVoice, toDraft = codebuiltToDraft, clock = now, newId = () => `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
  postFactoryFn, inputRoot, lightMetadataStage, askRoleFn = defaultAskRole, factCheckStage = defaultFactCheckStage,
  // KAN-934: the visual loop. On by default; only an injected `false` turns it off (tests). An object injects its pieces (probe, askLook, askText, runPreview, sheetMaker, validate, runLoop).
  visualLoop, validateReusableBuild = validateBuildScript,
} = {}) {
  const stateRoot = () => path.join(jobsDir, STAGE_DIR);
  const recFile = (id) => path.join(stateRoot(), id, 'status.json');
  const live = new Map(); // id -> { rec, controller }
  const resumeData = new Map(); // private validated artifacts; never written to status.json
  const waiting = []; // queued ids, one job runs at a time (the fence holds the GPU lease anyway)
  let running = null;

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
  function reusable(id) {
    // Locks live outside container-writable folders. Refuse before reading any reuse artifact,
    // including when cleanup of any preview belonging to this parent is uncertain.
    const blockedReason = jobWriteBlockedReason(jobsDir, id);
    if (blockedReason) return { blockedReason, reused: [], resumeFrom: null };
    const stage = path.join(stateRoot(), id);
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
    let build = null;
    if (scriptOk && voiceOk) {
      try {
      const planWords = words;
      if (Number.isFinite(planWords?.dur)) {
        const nframes = frameCountFor(planWords);
        // A directed job (direction.js) cut its shots on phrases: the host-written plan beside the build holds those cuts, the place ids and
        // what each shot should show. Without a usable plan file the arithmetic cuts of the older builds apply.
        let saved = null;
        try { saved = JSON.parse(readSafe(path.join(stage, 'planner-plan.json'), 'utf8', 512 * 1024) || 'null'); } catch { saved = null; }
        const savedOk = saved && saved.nframes === nframes && Array.isArray(saved.shotStarts) && saved.shotStarts.length > 0 && saved.shotStarts.length <= 24 && saved.shotStarts[0] === 0
          && saved.shotStarts.every((x, i, all) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x < nframes / 30 - 1 && (i === 0 || x > all[i - 1]))
          && Array.isArray(saved.places) && saved.places.length > 0 && saved.places.length <= 5 && saved.places.every((x) => typeof x === 'string' && /^[a-z][a-z0-9]{1,15}$/.test(x));
        const shotStarts = savedOk ? saved.shotStarts : shotStartsFor(planWords);
        const places = savedOk ? saved.places : undefined;
        const lookShots = savedOk && Array.isArray(saved.lookShots) && saved.lookShots.length === shotStarts.length && saved.lookShots.every((x) => x && typeof x.subject === 'string' && typeof x.narration === 'string') ? saved.lookShots : null;
        const directionMarkdown = savedOk && typeof saved.directionMarkdown === 'string' ? saved.directionMarkdown.slice(0, 20000) : null;
        const numbered = [];
        for (const base of [path.join(stage, 'loop')]) {
          if (!safeDirectory(base)) continue;
          try { for (const name of fs.readdirSync(base)) if (/^r\d+$/.test(name)) numbered.push({ base, n: Number(name.slice(1)) }); } catch {}
        }
        numbered.sort((a, b) => b.n - a.n);
        const candidates = [path.join(stage, 'loop', 'accepted.build.py'), ...numbered.map(({ base, n }) => path.join(base, `r${n}`, 'build.py')), path.join(stage, 'planner.build.py')];
        for (const file of candidates) {
          const code = readSafe(file); if (!code || !code.trim()) continue;
          const why = validateReusableBuild(code, { nframes, shotStarts, places });
          if (!why.length) {
            let startRound = 0; const match = file.match(/[\\/]r(\d+)[\\/]build\.py$/);
            if (match) startRound = Number(match[1]) + 1;
            else if (file.includes(`${path.sep}loop${path.sep}`) && numbered.length) startRound = numbered[0].n + 1;
            const history = [];
            for (const { base, n } of numbered.slice().sort((a, b) => a.n - b.n)) {
              if (n >= startRound) continue;
              try {
                const looked = JSON.parse(readSafe(path.join(base, `r${n}`, 'look.json')) || 'null');
                const priorCode = readSafe(path.join(base, `r${n}`, 'build.py'));
                if (looked?.status === 'complete' && Array.isArray(looked.reply?.findings)) {
                  history.push({ round: n, findings: looked.reply.findings, ...(looked.crashed !== true && priorCode && !validateReusableBuild(priorCode, { nframes, shotStarts, places }).length && sha(priorCode) === looked.buildSha256 ? { buildScript: priorCode, buildSha256: looked.buildSha256 } : {}) });
                }
              } catch {}
            }
            build = { code, path: file, sha256: sha(code), nframes, shotStarts, startRound, history, ...(places ? { places } : {}), ...(lookShots ? { lookShots } : {}), ...(directionMarkdown ? { directionMarkdown } : {}) }; break;
          }
        }
      }
      } catch { build = null; }
    }
    const reused = [];
    if (scriptOk) reused.push('script');
    if (voiceOk) reused.push('voice');
    if (build) reused.push('buildScript');
    const resumeFrom = !scriptOk ? 'scripting' : !voiceOk ? 'voicing' : !build ? 'planning' : 'visual_loop';
    let scriptMeta = {}; try { scriptMeta = JSON.parse(readSafe(path.join(stage, 'script-meta.json')) || '{}'); } catch {}
    return { scriptOk, voiceOk, build, scripted: scriptOk ? { script, brief, pathPack, shots: Array.isArray(scriptMeta.shots) ? scriptMeta.shots : [] } : null, voice, words, reused, resumeFrom };
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
  /** The loop between planning and building. Returns an accepted or explicitly unapproved looked-at script; never an unlooked script. */
  async function runLoopFor({ rec, stage, signal, scripted, voice, pathPack, plan, pl, runtime, probe, addCall, onPhase, resumeBuild }) {
    const injected = loopPieces();
    const { nframes, shotStarts } = plan;
    if (!Number.isInteger(nframes) || !Array.isArray(shotStarts) || !shotStarts.length) throw new StartError('look_failed', 502);
    // What each shot should show: the director's shot list when the build was directed, else the script's own beats by position.
    const directed = Array.isArray(plan.lookShots) && plan.lookShots.length === shotStarts.length ? plan.lookShots : null;
    const shots = shotStarts.map((start, i) => {
      const s = directed ? directed[i] : Array.isArray(scripted.shots) ? scripted.shots[i] : null;
      return { subject: clip(s?.subject, directed ? 900 : 200) || `part ${i + 1}`, narration: clip(s?.narration, 400) || `the narration from ${Number(start).toFixed(1)} s` };
    });
    const places = Array.isArray(plan.places) && plan.places.length ? plan.places : undefined;
    const validate = typeof plan.validate === 'function' ? plan.validate : injected.validate ?? ((code) => {
      if (typeof pl.validateBuildScript !== 'function') return ['no build validator is available'];
      const why = [...pl.validateBuildScript(code, { nframes, shotStarts, places })];
      if (!why.length && typeof pl.pythonSyntaxCheck === 'function') { const bad = pl.pythonSyntaxCheck(code); if (bad) why.push(`Python syntax error, ${bad}`); }
      if (!why.length && typeof pl.pythonQaStructureCheck === 'function') { const structure = pl.pythonQaStructureCheck(code); if (Array.isArray(structure)) why.push(...structure); }
      return why;
    });
    const sheetMaker = injected.sheetMaker ?? createPreviewSheetMaker({ execFileFn: hostExecFile });
    const runPreview = injected.runPreview ?? createPreviewRunFn({ runner: runtime.runner, inputs: { script: scripted.script, voWav: voice.voPath, words: voice.wordsPath, pathPack, brief: scripted.brief }, jobRoot: jobsDir });
    const run = injected.runLoop ?? runVisualBuildLoop;
    try {
      return await run({
        jobId: rec.id, stageDir: stage, brief: typeof plan.directionMarkdown === 'string' && plan.directionMarkdown ? `${scripted.brief}

${plan.directionMarkdown}` : scripted.brief, script: scripted.script, shots, shotStarts, nframes, buildScript: resumeBuild?.code ?? plan.buildScript, startRound: resumeBuild?.startRound ?? 0, resumeHistory: resumeBuild?.history ?? [], kitContract: plan.kitContract ?? pl.KIT_CONTRACT,
        validate, probe, lookModel: 'sonnet', signal, lookGuides: (() => { try { return typeof pl.loadCodebuiltGuides === 'function' ? pl.loadCodebuiltGuides({ pack: pathPack, step: 'look' }) : ''; } catch { return ''; } })(),
      }, {
        runPreview, makeSheets: (args) => sheetMaker.makeSheets(args), askLook: injected.askLook ?? defaultAskLook, askText: injected.askText ?? defaultAskText,
        onCall: addCall, onPhase,
      });
    } catch (error) {
      if (signal.aborted || error?.code === 'aborted') throw new StartError('aborted');
      if (error?.detail?.reason === 'quota' || error?.quota === true) throw new StartError('claude_limit', 502);
      throw new StartError(LOOP_START_CODES.has(error?.code) ? error.code : 'look_failed', 502);
    }
  }
  /** Host-written beside cost_calls.json after the final render; the draft adapter reduces it to hashes, counts and verdicts. */
  function writeLoopReceipt(id, receipt) {
    writeHostJobReceipt(jobsDir, id, 'visual_loop.json', `${JSON.stringify(receipt, null, 1)}\n`);
  }

  async function execute(rec, controller) {
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

    // 1b. The visual check must be possible before anything is paid for: one small probe proves the CLI takes pictures (KAN-934).
    let probe = null;
    if (visualLoop !== false) {
      try { probe = await probeFor({ rec, stage, signal }); } catch (error) {
        if (signal.aborted || error?.code === 'aborted') throw new StartError('aborted');
        if (error?.quota === true || error?.detail?.reason === 'quota') throw new StartError('claude_limit', 502);
        throw new StartError('look_unavailable', 502);
      }
      checkAbort();
    }

    // 2 to 4a. Script, fact check, voice and the length check run at most twice. A voice whose real pace differs from the planned one
    // gives a video that is too long or too short; instead of stopping there (job mwg83rd6-959255: serena read 112 words in 54.6 s,
    // 11.4 s over), the script is written once more for the pace that was just measured, and voiced again. A second miss stops the job.
    let scripted; let voice; let words; let measured;
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
      scripted = await fn({ topic: rec.topic, duration: rec.duration, voice: rec.voice, signal, ...(measuredPace ? { pace: measuredPace } : {}), ...(rec.choices ? { choices: rec.choices } : {}), ...(rec.premise ? { premise: rec.premise } : {}) }, { onCall: addCall });
    } catch (error) { throw error instanceof StartError ? error : signal.aborted ? new StartError('aborted') : error?.quota === true ? new StartError('claude_limit', 502) : new StartError('script_failed', 502); }
    }
    if (!scripted || typeof scripted.script !== 'string' || !scripted.script.trim() || typeof scripted.brief !== 'string') throw new StartError('script_failed', 502);
    for (const c of scripted.calls ?? []) addCall(c);
    // The real paths/codebuilt.json pack comes from the planner. A script result without one cannot be built, and nothing is spent on voice first.
    if (!scripted.pathPack || typeof scripted.pathPack !== 'object' || scripted.pathPack.id !== 'codebuilt' || !Array.isArray(scripted.pathPack.skills)) throw new StartError('script_failed', 502);
    // Private stage artifacts remain reviewable even when a later step fails. They contain no CLI output.
    try { fs.mkdirSync(stage, { recursive: true }); } catch { /* audit artifacts are best effort */ }
    const saveScriptArtifacts = () => {
      for (const [name, value] of [['script.txt', scripted.script], ['shots.json', `${JSON.stringify(scripted.shots ?? [], null, 2)}\n`], ['brief.md', scripted.brief], ['pathpack.json', `${JSON.stringify(scripted.pathPack, null, 2)}\n`], ['script-meta.json', `${JSON.stringify({ shots: scripted.shots ?? [] })}\n`]]) {
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
      if (verdict?.verified !== true && Array.isArray(verdict?.facts?.claims)) {
        const corrections = verdict.facts.claims.filter((x) => x && (x.verdict === 'contradicted' || x.verdict === 'uncertain'))
          .map((x) => ({ text: x.text, problem: x.verdict, evidence: x.verdict === 'contradicted' ? x.sources?.[0]?.passage : undefined }));
        if (corrections.length) {
          step(rec, 'scripting');
          let again;
          try {
            const fn = scriptStage ?? pl.planCodebuiltScript;
            again = await fn({ topic: rec.topic, duration: rec.duration, voice: rec.voice, signal, corrections, ...(measuredPace ? { pace: measuredPace } : {}), ...(rec.choices ? { choices: rec.choices } : {}), ...(rec.premise ? { premise: rec.premise } : {}) }, { onCall: addCall });
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
      try {
        const receipt = JSON.parse(readSafe(path.join(stage, 'fact-check.json')) || 'null');
        if (receipt && receipt.verified === true && receipt.summary) {
          verifiedFactCheck = receipt;
        } else {
          const facts = JSON.parse(readSafe(path.join(stage, 'facts.json')) || 'null');
          if (facts && (facts.verified === true || facts.status === 'verified') && facts.blocked !== true) {
            verifiedFactCheck = {
              verified: true,
              summary: {
                claims: Array.isArray(facts.claims) ? facts.claims.length : null,
                false_claims: Array.isArray(facts.false_claims) ? facts.false_claims.length : 0,
                uncertain_claims: Array.isArray(facts.uncertain_claims) ? facts.uncertain_claims.length : 0,
              },
            };
          }
        }
      } catch { /* unverified */ }
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
          voice = await voiceStage({ script: scripted.script, ...(Array.isArray(scripted.shots) && scripted.shots.length ? { beats: scripted.shots } : {}), voice: rec.voice, outDir: stage, allowedRoot: jobsDir, episodeDir: `cb-${rec.id}`, episodesRoot, runId: rec.id, onCall: addCall, ...(post ? { postFactoryFn: post } : {}) });
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
    let plan = resume?.build ? { buildScript: resume.build.code, shotStarts: resume.build.shotStarts, nframes: resume.build.nframes, kitContract: pl.KIT_CONTRACT, ...(resume.build.places ? { places: resume.build.places } : {}), ...(resume.build.lookShots ? { lookShots: resume.build.lookShots } : {}), ...(resume.build.directionMarkdown ? { directionMarkdown: resume.build.directionMarkdown } : {}) } : null;
    if (!plan) try {
      step(rec, 'planning');
      if (typeof pl.planCodebuiltBuild !== 'function') throw new StartError('planner_unavailable', 501);
      plan = await pl.planCodebuiltBuild({ topic: rec.topic, duration: rec.duration, script: scripted.script, brief: scripted.brief, beats: scripted.shots, words, pathPack, signal, buildModel: rec.buildModel, ...(rec.choices ? { choices: rec.choices } : {}), ...(rec.premise ? { premise: rec.premise } : {}) }, { onCall: addCall, onRefused: refusedBuildWriter(rec.id) });
      try {
        fs.writeFileSync(path.join(stage, 'planner.build.py'), plan.buildScript);
        fs.writeFileSync(path.join(stage, 'planner-plan.json'), JSON.stringify({ nframes: plan.nframes, shotStarts: plan.shotStarts, ...(plan.places ? { places: plan.places, lookShots: plan.lookShots, directionMarkdown: plan.directionMarkdown } : {}) }));
        if (plan.direction) { fs.writeFileSync(path.join(stage, 'direction.json'), `${JSON.stringify(plan.direction, null, 1)}
`); fs.writeFileSync(path.join(stage, 'direction.md'), plan.directionMarkdown ?? ''); }
      } catch {}
    } catch (error) {
      if (signal.aborted) throw new StartError('aborted');
      writePlannerDiagnostic(rec.id, error);
      if (error?.quota === true || error?.code === 'CLI_LIMIT') throw new StartError('claude_limit', 502);
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

    // 4b. The visual loop: preview the planned build, look at the sheets and fix what is wrong. Exhaustion may continue with a marked draft only
    // when at least one successful preview was looked at; no code reaches the final render without a look.
    let buildScript = plan.buildScript;
    let loopReceipt = null;
    if (visualLoop !== false) {
      if (resume?.build) step(rec, 'visual_loop');
      const outcome = await runLoopFor({ rec, stage, signal, scripted, voice, pathPack, plan, pl, runtime, probe, addCall, resumeBuild: resume?.build ? { code: resume.build.code, startRound: resume.build.startRound, history: resume.build.history } : null, onPhase: (name) => { if (name === 'previewing' || name === 'looking') step(rec, name); } })
        .finally(() => writeCalls(rec.id, allCalls));
      if (!outcome || (!outcome.accepted && outcome.unapproved !== true) || typeof outcome.buildScript !== 'string' || !outcome.buildScript.trim() || sha(outcome.buildScript) !== outcome.sha256) throw new StartError('look_failed', 502);
      buildScript = outcome.buildScript;
      loopReceipt = outcome.unapproved === true
        ? { ...outcome.receipt, visual_check: { approved: false, findings: Array.isArray(outcome.findings) ? outcome.findings : [] } }
        : outcome.receipt;
      if (outcome.unapproved === true) rec.visual_check = loopReceipt.visual_check;
      checkAbort();
    }

    // 5. Build in the isolated runner. The job request has no say in image, command or limits.
    step(rec, 'building');
    try {
      await runtime.runner.run({
        jobId: rec.id, kind: 'generated-code', timeoutMs: TIMEOUT_MS[rec.duration] ?? 60 * 60 * 1000, signal,
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
    if (rec.premise) writeHostJobReceipt(jobsDir, rec.id, 'premise.json', `${JSON.stringify(rec.premise, null, 2)}\n`);
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
      const out = toDraft({ videoType: rec.contentMode, jobId: rec.id, channelId: rec.channelId ?? defaultChannelId, topic: rec.topic, ...(rec.premise ? { premise: rec.premise } : {}), ...(title ? { title, metadataSource: 'light_router' } : {}), ...(tags ? { tags } : {}), jobsDir, ...(draftsDir ? { draftsDir } : {}), requestedDuration: rec.duration, ...(verifiedFactCheck ? { factCheck: verifiedFactCheck } : {}) });
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
      const rec = { version: START_VERSION, id, topic: req.topic, duration: req.duration, voice: req.voice, channelId: req.channelId ?? null, buildModel: req.buildModel, status: 'queued', step: 'queued', steps: [{ step: 'queued', at: clock() }], createdAt: clock(), updatedAt: clock(), draftId: null, error: null, topicSha: sha(req.topic).slice(0, 12),
        ...(batch ? { factCheck: true, runId: internal.runId, batchIndex: Number.isInteger(internal.batchIndex) ? internal.batchIndex : null, contentMode: choices ? choices.type : internal.contentMode === 'whatif' ? 'whatif' : internal.contentMode === 'history' ? 'history' : 'factual', ...(choices ? { choices } : {}), ...(internal.premise ? { premise: internal.premise } : {}), preCalls: Array.isArray(internal.preCalls) ? internal.preCalls.slice(0, 20) : [] } : {}) };
      if (type === 'history') {
        rec.contentMode = 'history';
        rec.factCheck = true;
        rec.choices = { genre: choices?.genre ?? null, theme: choices?.theme ?? null, type: 'history' };
      }
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
    resume(id) {
      const rec = load(id);
      if (!rec) throw new StartError('not_found', 404);
      if (!['failed', 'aborted'].includes(rec.status)) throw new StartError('conflict', 409);
      if ((running !== null && running !== id) || waiting.some((queuedId) => queuedId !== id) || [...live.values()].some(({ rec: item }) => item.id !== id && ACTIVE.includes(item.status))) throw new StartError('conflict', 409);
      const artifacts = reusable(id);
      if (artifacts.blockedReason) throw new StartError('conflict', 409);
      rec.resumes = Array.isArray(rec.resumes) ? rec.resumes : [];
      rec.resumes.push({ at: clock(), fromStep: artifacts.resumeFrom, reused: artifacts.reused });
      rec.status = 'queued'; rec.step = 'queued'; rec.error = null; rec.resumeFrom = artifacts.resumeFrom; resumeData.set(rec.id, artifacts);
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
      if (rec.status === 'queued') { const at = waiting.indexOf(id); if (at >= 0) waiting.splice(at, 1); settle(rec, new StartError('aborted')); }
      return publicJob(rec);
    },
    /** Resolves when the job has settled (tests and graceful shutdown). */
    async idle() { while (running || waiting.length) await new Promise((r) => setTimeout(r, 5)); },
  };

  function jobStatus(rec) {
    const otherActive = (running !== null && running !== rec.id) || waiting.some((queuedId) => queuedId !== rec.id) || [...live.values()].some(({ rec: item }) => item.id !== rec.id && ACTIVE.includes(item.status));
    const resumable = ['failed', 'aborted'].includes(rec.status);
    const artifacts = resumable ? reusable(rec.id) : null;
    const blockedReason = artifacts?.blockedReason ?? (resumable && otherActive ? 'Another code-built job is active' : null);
    const priorResume = rec.resumes?.at(-1);
    return { ...publicJob(rec), resumable: resumable && !blockedReason, resumeFrom: resumable ? artifacts.resumeFrom : priorResume?.fromStep ?? null, reuses: resumable ? artifacts.reused : priorResume?.reused ?? [], ...(blockedReason ? { resumeBlockedReason: blockedReason } : {}) };
  }
}

let shared = null;
/** The process-wide starter used by the routes. Tests pass their own through setCodebuiltStarter(). */
export function codebuiltStarter() { return (shared ??= createCodebuiltStarter()); }
export function setCodebuiltStarter(starter) { shared = starter; }
