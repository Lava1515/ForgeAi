// CB5 (KAN-914): the code-built build-job runner. A callable component only: nothing registers it as a path, stage,
// route or UI, and nothing starts it by itself.
//
// Current CB6 API: runIsolatedJob(config, deps) from episode/codebuilt/runJob.js. compose.js injects cb6Adapter.js,
// which maps jobDir to jobRoot/jobId and forwards only signal under a fixed reviewed image+argv approval.
// CB6 owns its GPU lease; do not wrap it in withGpu.
//   config: { jobDir, jobRoot, jobId, runtime: 'docker', kind: 'stub' | 'generated-code', timeoutMs, useGpuQueue: true }
//   deps: { signal }
//   confirmFenceStopped({ jobDir, attempt }) -> exactly true only when the fence authoritatively reports that no
//   agent/container/GPU work for that job is still running. CB6 must provide it. Without it, or when it says anything
//   else or throws, a "running" or "orphaned" record refuses every retry and touches nothing. A fence call that
//   returned, threw or settled late is NOT proof of a stop. A result of status cleanup_uncertain, or with lockRetained
//   or leaseRetained set, persists the job as orphaned with cleanupUncertain: no hook answer can clear that; an
//   operator moves the record aside after inspecting the fence.
// The fence is injected. Without one the runner fails closed (INTEGRATION_PENDING). A real agent is refused here with
// no override: CB6 must be merged after its security review and the negative proof must pass first. Docker topology,
// CLI credentials, egress, UI placement and voice provider are NOT decided here. `fenceOptions` accepts only the
// explicit stub-safe keys in FENCE_OPTION_ALLOWLIST; there is no agent, command, env, mount or network option.
// The CB6 fence must mount only <root>/<jobId>, never <root> (host state lives in <root>/.state).
//
// The runner never runs anything on the host itself (starts no host process, no plain-exec fallback). The GPU queue is held by the fence
// through the injected `withGpu` (the same queue.js lease the other engines use); the runner does not take a second
// lease, because the lock is not re-entrant.
import path from 'node:path';
import { CodebuiltError } from './errors.js';
import {
  ensureJobFolder, jobPaths, writeInputs, verifyInputs, clearOutputs, collectOutputs, outputsMatch, assertReportOk,
  writeBuildScript, verifyBuildScript, BUILD_SCRIPT,
  PREVIEW_SPEC, checkPreviewRequest, writePreviewSpec, verifyPreviewSpec, clearPreview, collectPreview, previewMatches,
  framesDigest, replaceOverlayInput, restoreOverlayInput,
} from './jobFolder.js';
import crypto from 'node:crypto';
import { FPS } from '../../codebuilt/planner.js';
import { acquireJobLock, readJobState, writeJobState } from './jobState.js';

export const RUNNER_VERSION = 'codebuilt-runner-v1';
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const JOB_KINDS = Object.freeze(['stub', 'generated-code']);
/** Visual loop (KAN-934): a preview job renders a few small frames of one build.py and nothing else. Its id ends -pv<N>; a final job's never does. */
export const PREVIEW_JOB_ID = /-pv[1-9][0-9]?$/;
export const FENCE_OPTION_ALLOWLIST = Object.freeze(['runtime', 'image', 'memoryLimit', 'cpuLimit', 'label']);
const BACKSTOP_GRACE_MS = 15000;

const TIMEOUT_STATUSES = new Set(['timeout', 'timed_out']);
const EARLY_STOP_STATUSES = new Set(['agent_exited', 'agent_stopped', 'early_stop', 'exited', 'stopped']);
const jobKey = (paths) => (process.platform === 'win32' ? paths.dir.toLowerCase() : paths.dir);

async function defaultWithGpu(fn, options) {
  return (await import('../../queue.js')).withGpu(fn, options);
}

function classifyResult(result) {
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new CodebuiltError('FENCE_BAD_RESULT', 'the fence returned no usable result');
  }
  if (result.status === 'cleanup_uncertain' || result.lockRetained === true || result.leaseRetained === true) {
    throw new CodebuiltError('FENCE_ORPHANED', 'the fence could not clean up (status, retained lock or retained lease); the job is orphaned and may not be retried', {
      orphan: true, cleanupUncertain: true, status: result.status, lockRetained: result.lockRetained === true, leaseRetained: result.leaseRetained === true,
    });
  }
  if (result.status === 'ok' && result.ok === true) return;
  const detail = { status: result.status, reason: result.reason ?? null };
  if (TIMEOUT_STATUSES.has(result.status)) throw new CodebuiltError('TIMEOUT', 'the agent ran out of time', detail);
  if (result.status === 'contained_violation') throw new CodebuiltError('CONTAINED_VIOLATION', 'the job touched something outside its folder', detail);
  if (EARLY_STOP_STATUSES.has(result.status)) throw new CodebuiltError('AGENT_EARLY_STOP', 'the agent stopped before finishing', detail);
  throw new CodebuiltError('FENCE_FAILED', `the fence ended with status ${result.status}`, detail);
}

/** Only allowlisted, primitive, own options reach the fence; everything else is refused, not dropped. */
function checkFenceOptions(options) {
  if (options === undefined) return {};
  const proto = options && typeof options === 'object' ? Object.getPrototypeOf(options) : undefined;
  if (!options || typeof options !== 'object' || Array.isArray(options) || (proto !== Object.prototype && proto !== null)) {
    throw new CodebuiltError('BAD_JOB', 'fenceOptions must be a plain object');
  }
  const clean = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !FENCE_OPTION_ALLOWLIST.includes(key)) {
      throw new CodebuiltError('BAD_JOB', `fence option ${String(key)} is not allowed (allowed: ${FENCE_OPTION_ALLOWLIST.join(', ')})`);
    }
    const value = options[key];
    const okType = (typeof value === 'string' && value.length <= 200) || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
    if (!okType) throw new CodebuiltError('BAD_JOB', `fence option ${key} must be a short string, number or boolean`);
    clean[key] = value;
  }
  return clean;
}

/** What the fence proved, as the runner keeps it with the job (also carried into a post-only completion). */
function fenceOf(value) {
  return value.acceptance
    ? { cb6Status: value.cb6Status ?? value.status, policy: value.acceptance.policy, accepted: value.acceptance.accepted, supplementary: value.acceptance.supplementary }
    : { cb6Status: value.status, policy: 'strict', accepted: true, supplementary: null };
}

/**
 * The state fields a post layout refusal adds: the bounded blocking list, the identity of the frames the refused run left, and the
 * overlay and build hashes it used. The frames are hashed here, on the host, after the container is gone; the executor never writes
 * this record. {} for any other error.
 */
function refusalRecord(paths, inputs, error, fence) {
  if (error?.code !== 'OVERLAY_LAYOUT_BLOCKED') return {};
  const frames = framesDigest(paths);
  return { fence, refusal: {
    blocking: Array.isArray(error.detail?.blocking) ? error.detail.blocking : [], blocking_total: error.detail?.blocking_total ?? null,
    frames, overlay_sha256: inputs?.['overlay.json'] ?? null, build_sha256: inputs?.[BUILD_SCRIPT] ?? null,
  } };
}

function wait(ms) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(timer) };
}

function toTyped(error) {
  if (error instanceof CodebuiltError) return error;
  return new CodebuiltError('IO_FAILED', String(error?.message ?? error).slice(0, 300), { errno: error?.code ?? null });
}

export function createBuildJobRunner({
  root, runIsolatedJob = null, withGpu = defaultWithGpu, backstopGraceMs = BACKSTOP_GRACE_MS, inputRoots = [], confirmFenceStopped = null,
  produceOutputs = null,
} = {}) {
  jobPaths(root, 'probe'); // absolute-root check at construction
  if (runIsolatedJob !== null && typeof runIsolatedJob !== 'function') throw new TypeError('runIsolatedJob must be a function');
  if (typeof withGpu !== 'function') throw new TypeError('withGpu must be a function');
  if (confirmFenceStopped !== null && typeof confirmFenceStopped !== 'function') throw new TypeError('confirmFenceStopped must be a function');
  if (produceOutputs !== null && typeof produceOutputs !== 'function') throw new TypeError('produceOutputs must be a function');
  if (!Array.isArray(inputRoots) || inputRoots.some((r) => typeof r !== 'string' || !path.isAbsolute(r))) throw new TypeError('inputRoots must be absolute paths');
  const readRoots = Object.freeze([...inputRoots]);

  async function fenceStopped(paths, prior) {
    if (prior.cleanupUncertain === true || !confirmFenceStopped) return false;
    try { return (await confirmFenceStopped({ jobDir: paths.dir, attempt: prior.attempt ?? null })) === true; } catch { return false; }
  }

  async function runLocked(request, paths, { timeoutMs, fenceConfig, signal }) {
    const { jobId, kind = 'stub' } = request;
    const preview = request.mode === 'preview';
    const prior = readJobState(paths.state);

    if (!runIsolatedJob) {
      if (!prior || ['prepared', 'failed', 'integration_pending'].includes(prior.status)) {
        writeJobState(paths.state, { ...(prior ?? {}), jobId, status: 'integration_pending', reason: 'CB6 fence not injected', runner: RUNNER_VERSION });
      }
      throw new CodebuiltError('INTEGRATION_PENDING', 'no CB6 isolation fence is injected; the runner fails closed');
    }
    if (signal?.aborted) throw new CodebuiltError('ABORTED', 'aborted before start');

    // A possibly live fence blocks everything that could touch its folders: no input write, no clear, no start.
    if (prior?.status === 'orphaned' || prior?.status === 'running') {
      if (!(await fenceStopped(paths, prior))) {
        throw new CodebuiltError('FENCE_ORPHANED', 'the previous fence run was not confirmed stopped; refusing to touch its folders', { attempt: prior.attempt ?? null });
      }
    }

    const inputs = writeInputs(paths, request, readRoots);
    if (kind === 'generated-code') inputs[BUILD_SCRIPT] = writeBuildScript(paths, request.buildScript);
    if (preview) inputs[PREVIEW_SPEC] = writePreviewSpec(paths, request);
    if (prior?.inputs && JSON.stringify(prior.inputs) !== JSON.stringify(inputs)) throw new CodebuiltError('RESUME_MISMATCH', 'inputs differ from the recorded job');

    if (prior?.status === 'complete') {
      if (preview) {
        const found = prior.mode === 'preview' ? previewMatches(paths, request.previewFrames, request.previewScale, prior.preview) : null;
        if (found) return { resumed: true, attempt: prior.attempt, jobDir: paths.dir, mode: 'preview', preview: found };
      } else {
        const found = outputsMatch(paths, prior.outputs);
        if (found) return { resumed: true, attempt: prior.attempt, jobDir: paths.dir, ...found };
      }
    }

    if (preview) clearPreview(paths); else clearOutputs(paths);
    const attempt = (prior?.attempt ?? 0) + 1;
    const base = { jobId, runner: RUNNER_VERSION, inputs, attempt, kind, ...(preview ? { mode: 'preview' } : {}) };
    const startedAt = new Date().toISOString();
    writeJobState(paths.state, { ...base, status: 'running', startedAt });

    const controller = new AbortController();
    let backstop; let onAbort; let fenceTiming = null; let fenceInfo = null;
    try {
      const config = { ...fenceConfig, jobDir: paths.dir, kind, timeoutMs, useGpuQueue: true };
      const fenceRun = Promise.resolve().then(() => runIsolatedJob(config, { withGpu, signal: controller.signal }));
      const returned = fenceRun.then(() => true, () => false); // only a normal return counts; a throw proves nothing
      const outcome = fenceRun.then((value) => ({ value }), (error) => ({ error }));
      const stopSignal = new Promise((resolve) => {
        backstop = setTimeout(() => resolve({ stop: 'timeout' }), timeoutMs + backstopGraceMs);
        onAbort = () => resolve({ stop: 'abort' });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });

      const first = await Promise.race([outcome, stopSignal]);
      if (first.stop) {
        // Ask the fence to stop, then give it a bounded grace period to actually return before calling it stopped.
        controller.abort();
        const grace = wait(backstopGraceMs);
        const confirmed = await Promise.race([returned, grace.promise.then(() => false)]);
        grace.cancel();
        const orphan = !confirmed;
        if (first.stop === 'timeout') throw new CodebuiltError('TIMEOUT', 'the fence did not return within the time limit', { backstop: true, orphan });
        throw new CodebuiltError('ABORTED', 'aborted by the caller', { orphan });
      }
      if ('error' in first) {
        const error = first.error;
        const refused = error?.code === 'ISOLATION_REFUSED'; // refused before anything started: the only exception that proves no work
        const message = String(error?.message ?? error).slice(0, 300);
        if (refused) throw new CodebuiltError('FENCE_REFUSED', message);
        throw new CodebuiltError(error instanceof CodebuiltError ? error.code : 'FENCE_FAILED', message, { ...(error instanceof CodebuiltError ? error.detail : {}), orphan: true });
      }
      // Diagnostics must never mask the fence result when a simulated/future adapter
      // returns a value that cannot be persisted as JSON.
      try {
        const hostPhases = first.value?.timing?.hostPhases;
        fenceTiming = hostPhases && typeof hostPhases === 'object' ? JSON.parse(JSON.stringify({ hostPhases })) : null;
      } catch { fenceTiming = null; }
      classifyResult(first.value);
      fenceInfo = fenceOf(first.value);
      verifyInputs(paths, inputs);
      if (kind === 'generated-code') verifyBuildScript(paths, inputs[BUILD_SCRIPT]);
      if (preview) verifyPreviewSpec(paths, inputs[PREVIEW_SPEC]);
      // The fence has returned with removal confirmed (classifyResult refuses anything else), so the container is gone.
      if (preview) {
        // A preview job ends here: no producer, no four-output collection. Only the exact requested frames are accepted.
        const collected = collectPreview(paths, request.previewFrames, request.previewScale);
        const previewFence = first.value.acceptance
          ? { cb6Status: first.value.cb6Status ?? first.value.status, policy: first.value.acceptance.policy, accepted: first.value.acceptance.accepted, supplementary: first.value.acceptance.supplementary }
          : { cb6Status: first.value.status, policy: 'strict', accepted: true, supplementary: null };
        writeJobState(paths.state, { ...base, status: 'complete', startedAt, finishedAt: new Date().toISOString(), preview: collected.frames.map((f) => ({ name: f.name, sha256: f.sha256 })), fence: previewFence, fenceTiming });
        return { resumed: false, attempt, jobDir: paths.dir, mode: 'preview', fence: previewFence, preview: collected };
      }
      // The host producer turns what the executor left (frames, audio) into the four output files.
      let producer = null;
      if (produceOutputs) {
        try { producer = (await produceOutputs({ jobDir: paths.dir, jobId, attempt, signal })) ?? null; } catch (error) {
          if (error instanceof CodebuiltError) throw error;
          throw new CodebuiltError('PRODUCER_FAILED', String(error?.message ?? error).slice(0, 300));
        }
      }
      const found = collectOutputs(paths);
      if (found.report.status === 'stopped_early') throw new CodebuiltError('AGENT_EARLY_STOP', 'the report says the agent stopped early', { reason: found.report.reason ?? null });
      assertReportOk(found.report);
      // What the fence actually proved is kept with the job: a report accepted under the prevention-primary policy still
      // says its supplementary host snapshot was incomplete.
      const fence = first.value.acceptance
        ? { cb6Status: first.value.cb6Status ?? first.value.status, policy: first.value.acceptance.policy, accepted: first.value.acceptance.accepted, supplementary: first.value.acceptance.supplementary }
        : { cb6Status: first.value.status, policy: 'strict', accepted: true, supplementary: null };
      writeJobState(paths.state, { ...base, status: 'complete', startedAt, finishedAt: new Date().toISOString(), outputs: found.hashes, fence, producer, fenceTiming });
      return { resumed: false, attempt, jobDir: paths.dir, fence, producer, ...found };
    } catch (raw) {
      const error = toTyped(raw);
      const orphaned = error.detail?.orphan === true;
      const cleanupUncertain = error.detail?.cleanupUncertain === true;
      try {
        writeJobState(paths.state, {
          ...base, status: orphaned ? 'orphaned' : 'failed', ...(cleanupUncertain ? { cleanupUncertain: true } : {}), failure: { code: error.code, message: error.message.slice(0, 300) }, finishedAt: new Date().toISOString(), fenceTiming,
          ...refusalRecord(paths, base.inputs, error, fenceInfo),
        });
      } catch (persist) {
        throw new CodebuiltError('IO_FAILED', `${error.code}: ${error.message}; the job record could not be saved (${persist?.code ?? 'error'})`.slice(0, 300), { original: error.code, orphan: orphaned });
      }
      throw error;
    } finally {
      clearTimeout(backstop);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Post-only resume of a job whose post kit refused the overlay layout (OVERLAY_LAYOUT_BLOCKED). No fence, no render: the kept frames
   * are checked against the identity recorded at the refusal, the corrected overlay replaces inputs/overlay.json, and only the host
   * producer runs again. Refused unless the recorded state is exactly that refusal, the build script and every other input are the
   * recorded ones, and the frames are byte-for-byte the frames the refused run left. A failed attempt that is not a new layout
   * refusal puts the previous overlay back, so the job stays resumable.
   */
  async function runPostOnly(request) {
    try {
      if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new CodebuiltError('BAD_JOB', 'the request must be an object');
      const { jobId, buildScript, overlaySpec, signal } = request;
      if (typeof jobId !== 'string' || PREVIEW_JOB_ID.test(jobId)) throw new CodebuiltError('BAD_JOB', 'a post-only resume needs a final job id');
      if (typeof buildScript !== 'string' || !buildScript.trim()) throw new CodebuiltError('BAD_JOB', 'a post-only resume needs the accepted buildScript text');
      if (!produceOutputs) throw new CodebuiltError('INTEGRATION_PENDING', 'a post-only resume needs the host output producer (produceOutputs); the runner fails closed');
      if (signal?.aborted) throw new CodebuiltError('ABORTED', 'aborted before start');
      const paths = jobPaths(root, jobId);
      ensureJobFolder(paths);
      const release = acquireJobLock(paths.lock, jobKey(paths));
      try { return await postOnlyLocked({ jobId, buildScript, overlaySpec, signal }, paths); } finally { release(); }
    } catch (error) {
      throw toTyped(error);
    }
  }

  async function postOnlyLocked({ jobId, buildScript, overlaySpec, signal }, paths) {
    const prior = readJobState(paths.state);
    const recorded = prior?.refusal;
    if (!prior || prior.status !== 'failed' || prior.kind !== 'generated-code' || prior.mode === 'preview' || prior.cleanupUncertain === true
      || prior.failure?.code !== 'OVERLAY_LAYOUT_BLOCKED' || !recorded?.frames?.sha256 || !Number.isInteger(recorded.frames.count)
      || !prior.inputs?.['overlay.json'] || !prior.inputs?.[BUILD_SCRIPT]) {
      throw new CodebuiltError('RESUME_MISMATCH', 'the recorded job is not a post layout refusal; a post-only resume is not possible');
    }
    if (crypto.createHash('sha256').update(buildScript).digest('hex') !== prior.inputs[BUILD_SCRIPT] || recorded.build_sha256 !== prior.inputs[BUILD_SCRIPT]) {
      throw new CodebuiltError('RESUME_MISMATCH', 'the accepted build script is not the one the refused run used');
    }
    // Nothing the refused run read or kept may have changed: the build, every input including the refused overlay, and every frame.
    verifyBuildScript(paths, prior.inputs[BUILD_SCRIPT]);
    verifyInputs(paths, prior.inputs);
    const frames = framesDigest(paths);
    if (!frames || frames.count !== recorded.frames.count || frames.sha256 !== recorded.frames.sha256) {
      throw new CodebuiltError('INPUT_CHANGED', 'the frames differ from the frames the refused run left', { name: 'frames' });
    }
    if (signal?.aborted) throw new CodebuiltError('ABORTED', 'aborted before start');

    const { sha256: overlayHash, previous } = replaceOverlayInput(paths, overlaySpec, frames.count / FPS);
    const inputs = { ...prior.inputs, 'overlay.json': overlayHash };
    const attempt = (prior.attempt ?? 0) + 1;
    const base = { jobId, runner: RUNNER_VERSION, inputs, attempt, kind: 'generated-code', postOnly: true, resumedFromAttempt: prior.attempt ?? null };
    const startedAt = new Date().toISOString();
    try {
      writeJobState(paths.state, { ...base, status: 'running', startedAt });
      let producer = null;
      try { producer = (await produceOutputs({ jobDir: paths.dir, jobId, attempt, signal })) ?? null; } catch (error) {
        if (error instanceof CodebuiltError) throw error;
        throw new CodebuiltError('PRODUCER_FAILED', String(error?.message ?? error).slice(0, 300));
      }
      // codex · gpt-6.1-sol · 2026-11-18 18:11 +02:00: an abort before commit restores the refused input and state.
      if (signal?.aborted) throw new CodebuiltError('ABORTED', 'aborted before post-only completion');
      verifyInputs(paths, inputs);
      verifyBuildScript(paths, inputs[BUILD_SCRIPT]);
      const found = collectOutputs(paths);
      assertReportOk(found.report);
      writeJobState(paths.state, { ...base, status: 'complete', startedAt, finishedAt: new Date().toISOString(), outputs: found.hashes, fence: prior.fence ?? null, producer, fenceTiming: prior.fenceTiming ?? null });
      return { resumed: false, postOnly: true, attempt, jobDir: paths.dir, fence: prior.fence ?? null, producer, ...found };
    } catch (raw) {
      const error = toTyped(raw);
      const again = error.code === 'OVERLAY_LAYOUT_BLOCKED';
      // A new layout refusal keeps the new overlay (it is the one to correct next). Any other failure restores the overlay the job had.
      if (!again) { try { restoreOverlayInput(paths, previous); } catch { /* the hash check refuses a later attempt if this did not hold */ } }
      try {
        writeJobState(paths.state, again
          ? { ...base, status: 'failed', failure: { code: error.code, message: error.message.slice(0, 300) }, finishedAt: new Date().toISOString(), fenceTiming: prior.fenceTiming ?? null, ...refusalRecord(paths, inputs, error, prior.fence ?? null) }
          : { ...prior, postOnlyFailure: { code: error.code, message: error.message.slice(0, 300), at: new Date().toISOString(), attempt } });
      } catch (persist) {
        throw new CodebuiltError('IO_FAILED', `${error.code}: ${error.message}; the job record could not be saved (${persist?.code ?? 'error'})`.slice(0, 300), { original: error.code });
      }
      throw error;
    }
  }

  async function run(request) {
    try {
      if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new CodebuiltError('BAD_JOB', 'the request must be an object');
      const { jobId, kind = 'stub', timeoutMs, fenceOptions, signal } = request;
      // Order matters: refuse the real agent before touching the disk.
      if (!JOB_KINDS.includes(kind)) throw new CodebuiltError('REAL_AGENT_REFUSED', 'real agent runs are refused: a CLI agent inside the container is not part of the decided topology');
      if (kind === 'generated-code' && (typeof request.buildScript !== 'string' || !request.buildScript.trim())) throw new CodebuiltError('BAD_JOB', 'a generated-code job needs buildScript text (the planner output)');
      if (kind !== 'generated-code' && request.buildScript !== undefined) throw new CodebuiltError('BAD_JOB', 'buildScript is only accepted for a generated-code job');
      const { mode } = request;
      if (mode !== undefined && mode !== 'preview') throw new CodebuiltError('BAD_JOB', 'mode must be "preview" or absent');
      if (mode === 'preview') {
        if (kind !== 'generated-code') throw new CodebuiltError('BAD_JOB', 'a preview job is a generated-code job');
        if (typeof jobId !== 'string' || !PREVIEW_JOB_ID.test(jobId)) throw new CodebuiltError('BAD_JOB', 'a preview job id must end in -pv<N> (N = 1..99)');
        checkPreviewRequest(request.previewFrames, request.previewScale);
      } else {
        if (typeof jobId === 'string' && PREVIEW_JOB_ID.test(jobId)) throw new CodebuiltError('BAD_JOB', 'a job id ending in -pv<N> is reserved for preview jobs');
        if (request.previewFrames !== undefined || request.previewScale !== undefined) throw new CodebuiltError('BAD_JOB', 'previewFrames and previewScale belong to a preview job');
      }
      // The executor leaves only frames: without the host producer a generated-code job can never reach the output files.
      if (kind === 'generated-code' && mode !== 'preview' && !produceOutputs) throw new CodebuiltError('INTEGRATION_PENDING', 'a generated-code job needs the host output producer (produceOutputs); the runner fails closed');
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        throw new CodebuiltError('BAD_JOB', `timeoutMs must be > 0 and at most ${MAX_TIMEOUT_MS}`);
      }
      const fenceConfig = checkFenceOptions(fenceOptions);
      const paths = jobPaths(root, jobId);
      ensureJobFolder(paths);
      const release = acquireJobLock(paths.lock, jobKey(paths));
      try {
        return await runLocked(request, paths, { timeoutMs, fenceConfig, signal });
      } finally { release(); }
    } catch (error) {
      throw toTyped(error);
    }
  }

  return Object.freeze({ run, runPostOnly, version: RUNNER_VERSION });
}
