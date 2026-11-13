// CB5: how a CB6 fence report is accepted. Pure function, no I/O, starts nothing.
//
// Two kinds of evidence, never merged (see runJob.js `containment`):
//   - PREVENTION: what the trusted Docker argv allowed (network none, read-only root, caps dropped, one writable mount,
//     bounded resources). This is the boundary. Its real behaviour was proven on Docker (approved CPU Blender render and
//     denied probe, no escape, cleanup verified); the argv that the host built is what this module reads back.
//   - OBSERVATION: a bounded host snapshot taken before and after the run. It can never be complete on this PC (root
//     files such as pagefile.sys, swapfile.sys and DumpStack.log.tmp are unreadable), so it is supplementary: a CHANGE it
//     sees outside C:/code is a violation (the fence already reports it as `contained_violation`), but a GAP in it is
//     only reported, never hidden and never turned into "complete".
//
// Policy `prevention-primary-v1` therefore accepts a CB6 report whose status is `audit_incomplete` ONLY when every
// reason for the incompleteness is on the allowed list below and every boundary condition holds. Anything else keeps
// its CB6 status. `strict` accepts nothing but a fully `ok` CB6 report (today's behaviour).
import fs from 'node:fs';
import path from 'node:path';
import { buildJobEnv } from '../../codebuilt/jobEnv.js';
import { READONLY_MOUNT_ALLOWLIST } from '../../codebuilt/dockerFence.js';

export const OBSERVATION_POLICIES = Object.freeze(['strict', 'prevention-primary']);
export const POLICY_ID = 'prevention-primary-v1';
const MAX_LISTED = 5;

const same = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// The one read-only host folder a code-built job may see: the engine kit, at the mount point launch.js uses (kept in step
// by a test). Resolved through the real path because the fence mounts the real path.
const KIT_DST = '/kit/blender_worker/codebuilt';
const SKILL_DST = '/skills/codebuilt-scene-generation';
const realOrResolved = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
// The complete environment key set of a job (jobEnv builds it from nothing; no extra key is ever passed). Names only.
const EXPECTED_ENV_KEYS = Object.freeze(Object.keys(buildJobEnv({ jobDir: '/job', jobId: 'job' })).sort());
// Same bounds the fence builder enforces (dockerFence LIMIT_BOUNDS): evidence outside them was not built by the fence.
const memoryMb = (v) => (typeof v === 'string' && /^[0-9]+m$/.test(v) ? Number(v.slice(0, -1)) : null);
const inRange = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/** The trusted fence argv facts a job must have run under. Returns a list of what is wrong (empty = boundary holds). */
export function preventionProblems(prevention, jobDir, { expectGpu = false } = {}) {
  const p = prevention;
  if (!p || typeof p !== 'object' || p.source !== 'docker_argv_policy') return ['prevention evidence from the docker argv is missing'];
  const bad = [];
  if (p.network !== 'none') bad.push(`network is ${JSON.stringify(p.network)}, not none`);
  if (p.readOnlyRootfs !== true) bad.push('root filesystem is not read-only');
  if (p.capDropAll !== true) bad.push('capabilities are not all dropped');
  if (p.noNewPrivileges !== true) bad.push('no-new-privileges is not set');
  if (p.user !== '1000:1000') bad.push(`user is ${JSON.stringify(p.user)}, not 1000:1000`);
  const mem = memoryMb(p.memory);
  if (!inRange(mem, 256, 65536)) bad.push(`memory limit ${JSON.stringify(p.memory ?? null)} is missing or out of bounds`);
  else if (p.memorySwap !== p.memory) bad.push('swap is not capped to the memory limit');
  if (!inRange(Number(p.cpus), 0.5, 32)) bad.push(`cpu limit ${JSON.stringify(p.cpus ?? null)} is missing or out of bounds`);
  const pids = typeof p.pidsLimit === 'string' && /^[0-9]+$/.test(p.pidsLimit) ? Number(p.pidsLimit) : null;
  if (!inRange(pids, 16, 4096)) bad.push(`pids limit ${JSON.stringify(p.pidsLimit ?? null)} is missing or out of bounds`);
  if (expectGpu) {
    if (!Array.isArray(p.gpus) || p.gpus.length !== 1 || p.gpus[0] !== 'device=0') bad.push(`the GPU launch must pass exactly one --gpus device=0, got ${JSON.stringify(p.gpus ?? null)}`);
  } else if (p.gpus !== null) bad.push('a GPU was passed to the container (this launch is CPU only)');
  const keys = Array.isArray(p.envKeys) && p.envKeys.every((k) => typeof k === 'string') ? [...p.envKeys].sort() : null;
  if (!keys || keys.length !== EXPECTED_ENV_KEYS.length || keys.some((k, i) => k !== EXPECTED_ENV_KEYS[i])) {
    bad.push(`the container environment is not the fixed job key set (${EXPECTED_ENV_KEYS.join(', ')})`);
  }
  const writable = Array.isArray(p.writableHostMounts) ? p.writableHostMounts : [];
  if (writable.length !== 1 || writable[0]?.dst !== '/job' || !same(writable[0]?.src, jobDir)) bad.push('the only writable host mount must be the job folder at /job');
  const readonly = Array.isArray(p.readonlyHostMounts) ? p.readonlyHostMounts : null;
  if (!readonly) bad.push('read-only mount evidence is missing');
  else {
    const expected = [
      { src: READONLY_MOUNT_ALLOWLIST[0], dst: KIT_DST },
      { src: READONLY_MOUNT_ALLOWLIST[1], dst: SKILL_DST },
    ];
    if (readonly.length !== expected.length || expected.some((want) => !readonly.some((got) => got?.dst === want.dst && same(realOrResolved(got?.src), realOrResolved(want.src))))) {
      bad.push(`read-only host mounts must be exactly the engine kit at ${KIT_DST} and the approved scene skill at ${SKILL_DST}`);
    }
  }
  return bad;
}

const errorsAreGaps = (outside) => {
  const gaps = outside?.coverage?.gaps;
  const listed = new Set([...(gaps?.outsideCode ?? []), ...(gaps?.insideCode ?? [])]);
  const errors = Array.isArray(outside?.errors) ? outside.errors : [];
  return errors.length > 0 && errors.every((e) => listed.has(e));
};

/**
 * report: the object runIsolatedJob resolved. Returns
 *   { policy, accepted, blocking: string[], cb6Status, trustedBoundary, supplementary }
 * `accepted` is true only for a `audit_incomplete` report under prevention-primary-v1 with nothing blocking.
 */
export function evaluateFenceReport(report, { policy = 'strict', expectGpu = false } = {}) {
  if (!OBSERVATION_POLICIES.includes(policy)) throw new TypeError(`observation policy must be one of ${OBSERVATION_POLICIES.join(', ')}`);
  const blocking = [];
  const r = report && typeof report === 'object' ? report : {};
  const cb6Status = typeof r.status === 'string' ? r.status : null;
  const outside = r.outside ?? {};
  const supplementary = {
    complete: false, exhaustive: false,
    outsideSnapshot: {
      status: r.checks?.outside ?? outside.status ?? null, truncated: outside.truncated === true,
      gapCount: (outside.coverage?.gaps?.outsideCode?.length ?? 0), insideCodeGapCount: (outside.coverage?.gaps?.insideCode?.length ?? 0),
      outsideCodeGaps: (outside.coverage?.gaps?.outsideCode ?? []).slice(0, MAX_LISTED),
      excludedLiveJobs: outside.coverage?.excludedLiveJobs ?? [],
    },
    leakScan: r.checks?.leakScan ?? r.leaks?.status ?? null,
    scriptScan: r.checks?.scriptScan ?? null,
  };

  if (cb6Status !== 'audit_incomplete') blocking.push(`CB6 status is ${JSON.stringify(cb6Status)}, only audit_incomplete can be accepted by this policy`);
  if (r.simulated !== false) blocking.push('the report is not from real Docker (simulated or unmarked)');
  if (r.started !== true) blocking.push('the container did not start');
  if (r.run?.status !== 'ok') blocking.push(`the container run ended ${JSON.stringify(r.run?.status ?? null)}, not ok`);
  if (r.orphan === true || r.lockRetained === true || r.leaseRetained === true || r.cleanup?.verified !== true) blocking.push('container removal was not confirmed');
  blocking.push(...preventionProblems(r.containment?.prevention, r.jobDir, { expectGpu }));
  // The evidence must be about the container of this very run, not a re-derivation for another token.
  if (typeof r.containerName !== 'string' || r.containment?.prevention?.containerName !== r.containerName) blocking.push('the prevention evidence names a different container than this run');

  // A detected change or finding is a violation, whatever else is true.
  if (outside.status === 'changed') blocking.push('the outside snapshot saw a change');
  if (Array.isArray(r.scan?.findings) && r.scan.findings.some((f) => f.severity === 'high')) blocking.push('the script scan has a high finding');
  if (r.leaks?.status === 'leak') blocking.push('a host secret value was found in the job output');
  if (r.scan?.coverage?.complete !== true) blocking.push('the job-folder scan did not cover every file');

  // The incompleteness that this policy tolerates, each with its own proof:
  //  1. the outside snapshot had unreadable entries (every error accounted for as a listed gap, walk not truncated);
  //  2. the leak scan was not run because no host secret was supplied to look for (secretsSupplied === 0; the container gets none).
  const outsideState = outside.status;
  if (outsideState === 'incomplete') {
    if (outside.truncated === true) blocking.push('the outside snapshot walk was truncated');
    else if (!errorsAreGaps(outside)) blocking.push('the outside snapshot is incomplete for a reason that is not a listed unreadable entry');
  } else if (outsideState !== 'clean' && outsideState !== 'inside_code_changes') {
    blocking.push(`the outside snapshot status is ${JSON.stringify(outsideState ?? null)}`);
  }
  // not_run says nothing about leaks. It is tolerated ONLY when no host secret value was supplied at all: a supplied value
  // that was too short to scan (or any other reason the scan did not run) means the scan was skipped, not unneeded.
  if (r.leaks?.status === 'not_run') {
    if (r.leaks?.coverage?.secretsSupplied !== 0) blocking.push('the leak scan did not run although secret values were supplied (or the count is unknown)');
  } else if (r.leaks?.status !== 'clean') blocking.push(`the leak scan status is ${JSON.stringify(r.leaks?.status ?? null)}`);

  const accepted = policy === 'prevention-primary' && blocking.length === 0;
  return {
    policy: policy === 'prevention-primary' ? POLICY_ID : 'strict', accepted, blocking, cb6Status,
    trustedBoundary: { source: 'docker_argv_policy', holds: preventionProblems(r.containment?.prevention, r.jobDir, { expectGpu }).length === 0, prevention: r.containment?.prevention ?? null, cleanupVerified: r.cleanup?.verified === true },
    supplementary,
  };
}

/**
 * Applies the policy to a fence report: returns it unchanged unless it is an accepted audit_incomplete report, which
 * becomes ok:true/status:'ok' with the original status and the evidence kept (`cb6Status`, `acceptance`).
 */
export function applyObservationPolicy(report, { policy = 'strict', expectGpu = false } = {}) {
  if (policy === 'strict' || !report || typeof report !== 'object' || report.status !== 'audit_incomplete') return report;
  const acceptance = evaluateFenceReport(report, { policy, expectGpu });
  if (!acceptance.accepted) return { ...report, acceptance };
  return { ...report, ok: true, status: 'ok', cb6Status: report.status, acceptance };
}
