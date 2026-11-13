// CB6: one fenced job, end to end. Order matters:
//   validate -> reap orphans -> take the job lock -> wait for the GPU lease (if the job uses the GPU)
//   -> [snapshot -> run the container -> confirm it is gone -> snapshot]  (all inside the lock and the lease)
//   -> give the lease back ONLY when the container is confirmed gone -> audit the job folder -> release the lock.
// composeCodebuiltRunner injects this fence into the build-job runner through cb6Adapter.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOB_ROOT, CODE_ROOT, assertJobDirSafe } from './jobPaths.js';
import { buildDockerArgv } from './dockerFence.js';
import { IsolationRefused, OrphanUncertain } from './policy.js';
import { runFenced, validateLaunch, resolveEffects, reparseScanFor } from './processGuard.js';
import { acquireJobLock, reapStaleJobs, liveJobIds, locksDir } from './jobLock.js';
import { snapshotTrees, diffSnapshots, scanJobForViolations, findSecretLeaks } from './audit.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MAX_GPU_WAIT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_GPU_WAIT_MS = 30 * 60 * 1000;

// GPU leases kept because a container could not be confirmed gone. Keyed by the run token of the quarantined lock.
// They are given back by reapOrphans once the container is confirmed gone. If this process dies, the GPU queue
// does not hand the GPU on while a lock says a GPU container may run (gpuFenceHold); reapOrphans frees that lock
// only after the dead owner's container is confirmed removed (jobLock.reapStaleJobs).
const retainedLeases = new Map();

export function defaultWatchRoots({ jobRoot, jobDir, repoRoot = REPO_ROOT }) {
  return [
    { root: jobRoot, depth: 4, exclude: [jobDir, locksDir(jobRoot)] }, // other jobs (jobs with a lock are left out at diff time)
    { root: path.parse(path.resolve(jobRoot)).root, depth: 0 }, // stray C:/prev style folders
    { root: path.dirname(path.resolve(repoRoot)), depth: 0 },
    { root: repoRoot, depth: 0 }, // top level only: .env and new top-level entries. Deeper files change during normal work.
  ];
}

/**
 * Reaps orphaned and quarantined jobs (see jobLock.reapStaleJobs) and gives back any GPU lease that was kept for
 * them. Call it at dashboard start and before GPU work; runIsolatedJob calls it before every launch.
 */
export async function reapOrphans({ jobRoot = JOB_ROOT } = {}, deps = {}) {
  const fx = resolveEffects({ jobRoot }, deps);
  return reapStaleJobs({
    jobRoot, dockerFn: fx.dockerFn, verify: deps.verify, isPidAlive: fx.simulated ? deps.isPidAlive : undefined,
    onReaped: async (rec) => {
      const lease = retainedLeases.get(rec.token);
      if (lease) { retainedLeases.delete(rec.token); await lease.release(); }
    },
  });
}

const hasUsableSecret = (v) => Array.isArray(v) && v.some(s => typeof s === 'string' && s.length >= 8);

/**
 * config: see dockerFence.buildDockerArgv, plus { runtime: 'docker', kind: 'stub' | 'real-agent', timeoutMs,
 *   pollMs?, graceMs?, startupGraceMs?, maxBlender?, gpuWaitMs?, allowNoLeakScan? }.
 * deps: { secretValues?: string[], signal? } for real runs. Everything else in deps is for simulations only
 *   (spawnFn + dockerFn doubles, approvals, watchRoots, acquireGpu, ...) and is refused with real Docker.
 * Throws IsolationRefused (pre-launch check failed, nothing exists), JobLocked or Error when nothing was started, and
 * OrphanUncertain when an earlier container may still be alive. Otherwise resolves a report. Contract of `signal`:
 * aborted while waiting for the GPU or before launch -> status 'aborted', started false; aborted while the container
 * runs -> docker kill, confirmed removal, status 'aborted', started true (cleanup as for any stop).
 */
export async function runIsolatedJob(config, deps = {}) {
  const hostStarted = performance.now();
  const atMs = {};
  const elapsed = () => Math.round((performance.now() - hostStarted) * 1000) / 1000;
  const mark = (phase) => { atMs[phase] = elapsed(); };
  const { fx, approval } = validateLaunch(config, deps); // runtime, real-or-simulated, approved list, time limits
  const { jobRoot = JOB_ROOT, jobId } = config;
  const mountAllowlist = fx.simulated ? deps.mountAllowlist : undefined;
  buildDockerArgv(config, { runToken: '0'.repeat(12), mountAllowlist }); // validates job dir, image, mounts, limits, env (early refusal only; the evidence comes from runFenced's own argv)
  const jobDir = assertJobDirSafe(config.jobDir, { jobRoot });
  if (config.kind === 'real-agent' && !hasUsableSecret(deps.secretValues)) {
    throw new IsolationRefused('a real agent run needs the host secret values for the leak scan (deps.secretValues)');
  }
  if (config.allowNoLeakScan !== undefined && (config.allowNoLeakScan !== true || config.kind !== 'stub')) {
    throw new IsolationRefused('allowNoLeakScan can only be true, and only for a stub job');
  }
  const gpuWaitMs = config.gpuWaitMs ?? DEFAULT_GPU_WAIT_MS;
  if (typeof gpuWaitMs !== 'number' || !(gpuWaitMs > 0) || gpuWaitMs > MAX_GPU_WAIT_MS) throw new Error(`gpuWaitMs must be > 0 and at most ${MAX_GPU_WAIT_MS}`);
  // A job that is given a GPU always takes the GPU lease. useGpuQueue can add the lease, never remove it.
  const needsGpu = Boolean(config.gpu) || config.useGpuQueue === true || approval.blender.max > 0;
  mark('validated');

  // Orphans first: a container left by a crashed dashboard, or one whose removal was never confirmed, may still
  // hold the GPU or this job's folder.
  const reaped = await reapOrphans({ jobRoot }, deps);
  mark('reaped');
  if (reaped.uncertain.some(u => u.jobId === jobId)) {
    throw new OrphanUncertain(`job ${jobId}: an earlier container of this job could not be confirmed gone`, { jobIds: reaped.uncertain.map(u => u.jobId), unowned: reaped.unowned, listError: reaped.listError });
  }
  if (needsGpu && (reaped.uncertain.length || reaped.manual.length || reaped.unowned.length || reaped.listError)) {
    const jobIds = [...reaped.uncertain, ...reaped.manual].map(u => u.jobId);
    throw new OrphanUncertain(`GPU job refused: fenced containers are unaccounted for (${[...jobIds, ...reaped.unowned, reaped.listError].filter(Boolean).join(', ')})`,
      { jobIds, unowned: reaped.unowned, listError: reaped.listError });
  }
  if (deps.signal?.aborted) return { ok: false, status: 'aborted', reason: 'abort_signal', started: false, orphan: false, simulated: fx.simulated, reaped, jobDir };

  const lock = acquireJobLock(jobId, { jobRoot }); // a duplicate run stops here (JobLocked)
  mark('locked');
  const startedMs = Date.now();
  let lease = null, run, before, after;
  try {
    if (needsGpu) {
      // The wait for the GPU is its own bounded step: it is not part of the job's time limit, and nothing is
      // snapshotted or started until the lease is held.
      const acquire = (fx.simulated && deps.acquireGpu) || (await import('../queue.js')).acquireGpu;
      const gpuOptions = { who: 'codebuilt', ticket: 'CB6', timeoutMs: gpuWaitMs, signal: deps.signal, ...(fx.simulated ? deps.gpuOptions : {}) };
      try { lease = await acquire(gpuOptions); } catch (e) {
        lock.release();
        if (deps.signal?.aborted || e?.name === 'AbortError') return { ok: false, status: 'aborted', reason: 'abort_signal', started: false, orphan: false, simulated: fx.simulated, reaped, jobDir, containerName: lock.containerName };
        return { ok: false, status: 'gpu_unavailable', reason: String(e?.message ?? e), started: false, simulated: fx.simulated, reaped, jobDir, containerName: lock.containerName };
      }
    }
    if (lease) lock.markGpu(); // from here on a dashboard crash cannot free the GPU while this container may run
    mark('leaseReady');
    const roots = (fx.simulated && deps.watchRoots) || defaultWatchRoots({ jobRoot, jobDir, repoRoot: REPO_ROOT });
    const snapOpts = { maxEntries: fx.simulated ? deps.maxSnapshotEntries : undefined };
    before = snapshotTrees(roots, snapOpts);
    mark('snapshotBefore');
    if (deps.signal?.aborted) { // aborted while waiting for the lease: nothing was started
      if (lease) await lease.release();
      lock.release();
      return { ok: false, status: 'aborted', reason: 'abort_signal', started: false, orphan: false, simulated: fx.simulated, reaped, jobDir, containerName: lock.containerName };
    }
    run = await runFenced(config, { ...deps, lock }); // re-checks approval, lock and image at the execution boundary
    // runFenced returns only after its cleanup check. This combined interval includes
    // image inspection, execution and cleanup; it cannot separate Blender setup/QA/render.
    mark('fenceReturned');
    after = snapshotTrees(roots, snapOpts);
    mark('snapshotAfter');
  } catch (e) {
    // runFenced only throws before it starts anything, so there is no container to account for.
    if (lease) await lease.release();
    lock.release();
    throw e;
  }

  // The lease and the lock are given back only when the container is CONFIRMED gone. Otherwise both are kept:
  // an orphan may still be using the GPU and the job folder. reapOrphans retries and releases them.
  const cleanupOk = run.cleanup.verified === true;
  let leaseRetained = false;
  if (lease) {
    if (cleanupOk) await lease.release();
    else { retainedLeases.set(lock.token, lease); leaseRetained = true; }
  }
  if (!cleanupOk) lock.quarantine(run.cleanup.error);
  mark('resourcesSettled');

  // Other jobs that held a lock at any time during this run write to their own folders: left out, and listed.
  const live = liveJobIds({ jobRoot, sinceMs: startedMs });
  const excludedLiveJobs = live.ids.filter(id => id.toLowerCase() !== jobId.toLowerCase());
  const outside = diffSnapshots(before, after, { ignoreUnder: excludedLiveJobs.map(id => path.join(path.resolve(jobRoot), id)), codeRoot: (fx.simulated && deps.codeRoot) || CODE_ROOT });
  outside.coverage.excludedLiveJobs = excludedLiveJobs;
  if (!live.complete && ['clean', 'inside_code_changes'].includes(outside.status)) { outside.status = 'incomplete'; outside.ok = false; outside.errors.push(`live jobs unknown: ${live.error ?? 'unreadable release marker'}`); }

  const scan = scanJobForViolations(jobDir, { reparseScan: reparseScanFor(fx, deps) });
  const leaks = findSecretLeaks(jobDir, deps.secretValues);
  if (cleanupOk) lock.release();
  mark('auditComplete');

  const violated = outside.status === 'changed' || scan.findings.some(f => f.severity === 'high') || leaks.status === 'leak';
  const leakScanMissing = leaks.status === 'incomplete' || (leaks.status === 'not_run' && config.allowNoLeakScan !== true);
  const incomplete = outside.status === 'incomplete' || outside.status === 'not_run' || !scan.coverage.complete || leakScanMissing;
  const status = !cleanupOk ? 'cleanup_uncertain'
    : run.status !== 'ok' ? run.status
      : violated ? 'contained_violation'
        : incomplete ? 'audit_incomplete' : 'ok';
  return {
    ok: status === 'ok', status, reason: run.reason ?? null,
    // A container of this run may still be alive (removal not confirmed). CB5 must treat this as an orphan, never as
    // "nothing started"; the lock and lease are kept until reapOrphans() confirms it is gone.
    orphan: !cleanupOk, code: !cleanupOk ? 'ORPHAN_UNCERTAIN' : null,
    timing: { gpuWaitMs, timeoutMs: config.timeoutMs, hostPhases: { clock: 'monotonic_ms', atMs, totalMs: elapsed() }, note: 'the GPU wait is bounded by gpuWaitMs and is not part of timeoutMs; abort covers both; fenceReturned includes execution and cleanup, not separate Blender phases' }, simulated: fx.simulated, started: run.started === true,
    run, cleanup: run.cleanup, leaseRetained, lockRetained: !cleanupOk, reaped,
    checks: { outside: outside.status, scriptScan: scan.coverage.complete ? 'complete' : 'incomplete', leakScan: leaks.status },
    // Two different kinds of evidence, never merged: what the trusted fence allowed (prevention) and what a bounded,
    // non-exhaustive host snapshot saw (observation). A gap in the second is never covered by the first.
    containment: {
      prevention: run.prevention ?? null, // read back from the argv runFenced spawned; absent = acceptance refuses
      observation: { kind: 'bounded_host_snapshot', exhaustive: false, status: outside.status, roots: outside.coverage.roots, gaps: outside.coverage.gaps, truncated: outside.truncated },
    },
    outside, findings: scan.findings, scan, leaks,
    containerName: lock.containerName, jobDir,
  };
}
