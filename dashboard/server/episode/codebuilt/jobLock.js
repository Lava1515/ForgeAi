// CB6: one owner per job, and cleanup that is verified, not assumed.
// - A lock file per job (outside the job folder, so job code cannot touch it) names the one container of that run.
//   A second run of the same job is refused; it never touches the first run's container.
// - A container counts as removed only when `docker ps -a` no longer lists it. Until then the lock stays
//   (quarantined) and the reaper retries, but only for locks this very process holds.
// - A lock written by another process is never reclaimed from its PID alone (PIDs are reused and no process start
//   identity is stored). The reaper frees it only when the owner pid is dead AND the lock's container identity is
//   validated AND removal is confirmed (see reapStaleJobs). Alive or unknown owner, unreadable or forged lock, a
//   container it cannot identify or an unconfirmed removal: the lock stays and everything stays blocked (fail
//   closed), reported as `manual` or `uncertain`. See docs/codebuilt-isolation.md.
// Nothing here deletes job content. The only files removed are this module's own lock files, by the handle that
// created them (release) or after this process's own quarantined run is confirmed gone (reaper).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JOB_ROOT, assertJobId, assertRealDir } from './jobPaths.js';
import { containerNameFor } from './dockerFence.js';

export const LOCKS_DIRNAME = '.cb6-locks'; // starts with a dot, so it can never be a job id
export const FENCE_LABEL = 'forgeai.fence=cb6';

export class JobLocked extends Error {
  constructor(message, state) { super(message); this.name = 'JobLocked'; this.code = 'JOB_LOCKED'; this.state = state; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const msg = (e) => String(e?.message ?? e);

// Tokens of the locks this process currently holds. Only a lock whose token is in this set may be removed by this
// process; every other lock file is foreign and is never unlinked here.
const heldTokens = new Set();

/**
 * Is the PID possibly alive? Only ESRCH means dead; EPERM and any other failure count as alive (unknown is held).
 * A dead PID is necessary, never sufficient, to reclaim a lock: PIDs are reused, so reclaim also needs the lock's
 * container identity and a confirmed removal (reapStaleJobs).
 */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Removal that must hold over about 2 s of repeated checks (a daemon still creating a container can bring it up).
export const STABLE_CHECKS = 4;
export const STABLE_MS = 500;

export const locksDir = (jobRoot = JOB_ROOT) => path.join(path.resolve(jobRoot), LOCKS_DIRNAME);

function ensureLocksDir(jobRoot) {
  const dir = path.join(assertRealDir(jobRoot, 'job root'), LOCKS_DIRNAME);
  try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return assertRealDir(dir, 'lock folder');
}

/** A lock record is trusted only when it names exactly the container this module would have created for it. */
function readLock(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return { invalid: true }; // a link or directory is not a lock this module wrote
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jobId = path.basename(file, '.lock');
    if (!rec || rec.jobId !== jobId || !Number.isInteger(rec.pid) || rec.containerName !== containerNameFor(jobId, rec.token)) return { invalid: true };
    return rec;
  } catch (e) { return e.code === 'ENOENT' ? null : { invalid: true }; }
}

/**
 * Takes the job's lock or throws JobLocked. The lock is created atomically (exclusive create), so two callers
 * cannot both win. Returns the handle that runFenced requires: { jobId, token, containerName, isHeld, release, quarantine }.
 */
export function acquireJobLock(jobId, { jobRoot = JOB_ROOT } = {}) {
  assertJobId(jobId);
  const dir = ensureLocksDir(jobRoot);
  const file = path.join(dir, `${jobId}.lock`);
  const token = crypto.randomBytes(6).toString('hex');
  let rec = { jobId, token, pid: process.pid, containerName: containerNameFor(jobId, token), startedAt: new Date().toISOString() };
  try { fs.writeFileSync(file, JSON.stringify(rec), { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const cur = readLock(file);
    const state = !cur || cur.invalid ? 'unreadable' : cur.quarantined ? 'quarantined' : 'running';
    throw new JobLocked(`job ${jobId} is locked (${state}): a run owns it or its cleanup is not confirmed; a lock is never reclaimed automatically (manual recovery only). Nothing was started or removed.`, state);
  }
  heldTokens.add(token);
  const isHeld = () => { const cur = readLock(file); return heldTokens.has(token) && Boolean(cur && !cur.invalid && cur.token === token); };
  return {
    jobId, token, containerName: rec.containerName, file, isHeld,
    release() {
      // The only code that can unlink this file is this handle (and the reaper for this same process's quarantined
      // lock), so no other process races the check below: there is no reclaim path.
      if (!isHeld()) return false;
      heldTokens.delete(token);
      fs.writeFileSync(path.join(dir, `${jobId}.released`), new Date().toISOString());
      fs.unlinkSync(file);
      return true;
    },
    /**
     * The run now holds the GPU lease and may start a container that uses the GPU. Written to the lock so that a
     * dashboard restart cannot forget it: while this lock exists the GPU queue does not hand the GPU to anyone else
     * on the strength of a dead owner pid alone (gpuFenceHold, used by queue.js).
     */
    markGpu() {
      if (!isHeld()) return false;
      rec = { ...rec, gpu: true };
      fs.writeFileSync(file, JSON.stringify(rec));
      return true;
    },
    /** Cleanup could not be confirmed: keep the lock, mark it so the reaper retries. */
    quarantine(reason) {
      if (!isHeld()) return false;
      fs.writeFileSync(file, JSON.stringify({ ...rec, quarantined: { at: new Date().toISOString(), reason: String(reason).slice(0, 300) } }));
      return true;
    },
  };
}

/**
 * Is a GPU container of the code-built fence possibly still running? True while any lock in the lock folder says the
 * run held the GPU, or cannot be read (unknown is held). It is consulted when the GPU queue finds a lease whose owner
 * pid is dead: a dead dashboard may have left its container running, so the lease is NOT reclaimed. Only the owner of
 * a lock (or an operator who confirmed the container is gone and removed the lock file) frees it.
 * returns { held, jobs: [jobId], error }
 */
export function gpuFenceHold({ jobRoot = JOB_ROOT } = {}) {
  const dir = locksDir(jobRoot);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e.code === 'ENOENT' ? { held: false, jobs: [], error: null } : { held: true, jobs: [], error: msg(e) }; }
  const jobs = [];
  for (const name of names.filter(n => n.endsWith('.lock'))) {
    const rec = readLock(path.join(dir, name));
    if (!rec) continue; // removed while we looked
    if (rec.invalid || rec.gpu === true) jobs.push(name.slice(0, -5));
  }
  return { held: jobs.length > 0, jobs, error: null };
}

/**
 * Jobs that have (or had, since `sinceMs`) a lock: their folders change legitimately while another job runs.
 * `complete` is false when the lock folder could not be read; callers must then not exclude anything silently.
 */
export function liveJobIds({ jobRoot = JOB_ROOT, sinceMs = Date.now() } = {}) {
  const dir = locksDir(jobRoot);
  const ids = new Set();
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return { ids: [], complete: e.code === 'ENOENT', error: e.code === 'ENOENT' ? null : msg(e) }; }
  let complete = true;
  for (const name of names) {
    if (name.endsWith('.lock')) ids.add(name.slice(0, -5));
    else if (name.endsWith('.released')) {
      try { if (Date.parse(fs.readFileSync(path.join(dir, name), 'utf8')) >= sinceMs) ids.add(name.slice(0, -9)); } catch { complete = false; }
    }
  }
  return { ids: [...ids].sort(), complete, error: null };
}

/**
 * Force-removes one container and CONFIRMS it is gone. `docker rm -f` failing is not trusted either way (it also
 * fails when the container is already gone); the only proof is that `docker ps -a` does not list the name.
 */
export async function removeAndVerify(dockerFn, containerName, { attempts = 3, backoffMs = 500, stableChecks = 0, stableMs = 500 } = {}) {
  let error = null;
  // true: not listed; false: listed. Throws when the list cannot be read (unknown is never "gone").
  const gone = async () => {
    const out = await dockerFn(['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
    if (typeof out !== 'string') throw new Error('docker ps returned no text');
    return !out.split(/\r?\n/).some(l => l.trim() === containerName);
  };
  for (let i = 0; i < attempts; i++) {
    try { await dockerFn(['rm', '-f', containerName]); } catch (e) { error = msg(e); }
    try {
      let ok = await gone();
      // A daemon that is still creating the container can bring it up after one "not found": it must stay gone.
      for (let s = 0; ok && s < stableChecks; s++) {
        await sleep(stableMs);
        try { await dockerFn(['rm', '-f', containerName]); } catch { /* not found is expected */ }
        ok = await gone();
      }
      if (ok) return { verified: true, attempts: i + 1, error: null };
      error = 'container is still listed after docker rm -f';
    } catch (e) { error = `could not list containers: ${msg(e)}`; }
    if (i < attempts - 1) await sleep(backoffMs * (i + 1));
  }
  return { verified: false, attempts, error };
}

/**
 * Identity of the container a FOREIGN lock names. The name was already derived from the lock's job id and token
 * (readLock). If a container of that exact name exists it must carry the fence label; one that does not is not ours
 * and is never removed. No such container is fine (removeAndVerify then confirms it stays gone).
 */
async function foreignContainerIdentity(dockerFn, rec) {
  const out = await dockerFn(['ps', '-a', '--filter', `name=${rec.containerName}`, '--format', '{{.Names}}\t{{.Label "forgeai.fence"}}']);
  if (typeof out !== 'string') throw new Error('docker ps returned no text');
  for (const row of out.split(/\r?\n/)) {
    const [name, label = ''] = row.split('\t');
    if (name.trim() === rec.containerName && label.trim() !== FENCE_LABEL.split('=')[1]) {
      return { ours: false, reason: 'a container of that name exists without the fence label: not removed' };
    }
  }
  return { ours: true };
}

/**
 * The reaper. For a lock THIS process holds and quarantined (cleanup was not confirmed): remove the container,
 * confirm, then drop the lock. A running lock of this process is `busy`. A lock written by another process is
 * reclaimed ONLY when its owner pid is dead (ESRCH), the lock record is valid (name derived from job id and token),
 * the container of that name carries the fence label (or does not exist), `docker rm -f` is confirmed by `docker ps -a`
 * over ~2 s, and the lock is unchanged afterwards (`reapedForeign`). Anything else is `manual` (pid alive or unknown,
 * foreign container) or `uncertain` (unreadable or forged lock, docker unreadable, removal unconfirmed) and is left
 * alone: never a PID-only reclaim. It only ever removes a container whose name this module derived for that lock.
 * Containers that carry the fence label but belong to no lock are reported as `unowned` and are NOT removed.
 * returns { reaped: [jobId], reapedForeign: [jobId], busy: [jobId], manual: [{ jobId, containerName, ownerPid, reason, ... }],
 *           uncertain: [{ jobId, error }], unowned: [name], listError }
 */
export async function reapStaleJobs({ jobRoot = JOB_ROOT, dockerFn, onReaped, verify, isPidAlive = pidAlive } = {}) {
  const out = { reaped: [], reapedForeign: [], busy: [], manual: [], uncertain: [], unowned: [], listError: null };
  const dir = locksDir(jobRoot);
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.lock')); } catch (e) { if (e.code !== 'ENOENT') out.listError = msg(e); }
  const owned = new Set();
  for (const name of names) {
    const jobId = name.slice(0, -5);
    const file = path.join(dir, name);
    const rec = readLock(file);
    if (!rec) continue;
    if (rec.invalid) { out.uncertain.push({ jobId, error: 'lock file is unreadable: the container name is unknown, nothing was removed' }); continue; }
    owned.add(rec.containerName);
    const mine = rec.pid === process.pid && heldTokens.has(rec.token);
    if (!mine) {
      // Written by another process (possibly a crashed dashboard). Reclaimed ONLY when the owner pid is dead AND the
      // lock's own container is confirmed removed (identity checked, removal verified over ~2 s). A pid alone never
      // frees a lock, so a lock the reaper cannot fully account for stays held (fail closed).
      const info = { jobId, containerName: rec.containerName, ownerPid: rec.pid, startedAt: rec.startedAt ?? null, quarantined: Boolean(rec.quarantined) };
      let alive = true;
      try { alive = isPidAlive(rec.pid) !== false; } catch { alive = true; }
      if (alive) { out.manual.push({ ...info, reason: 'owner pid is alive or unknown' }); continue; }
      try {
        const id = await foreignContainerIdentity(dockerFn, rec);
        if (!id.ours) { out.manual.push({ ...info, reason: id.reason }); continue; }
      } catch (e) { out.uncertain.push({ jobId, error: `container identity unknown: ${msg(e)}` }); continue; }
      const r = await removeAndVerify(dockerFn, rec.containerName, { stableChecks: STABLE_CHECKS, ...verify });
      if (!r.verified) { out.uncertain.push({ jobId, error: r.error }); continue; }
      try {
        const now = readLock(file);
        if (!now || now.invalid || now.token !== rec.token || now.pid !== rec.pid || now.startedAt !== rec.startedAt || heldTokens.has(now.token)) {
          out.uncertain.push({ jobId, error: 'lock changed during cleanup: left in place' }); continue;
        }
        fs.writeFileSync(path.join(dir, `${jobId}.released`), new Date().toISOString());
        fs.unlinkSync(file);
        out.reaped.push(jobId);
        out.reapedForeign.push(jobId);
        await onReaped?.(rec);
      } catch (e) { out.uncertain.push({ jobId, error: `container gone, lock not removed: ${msg(e)}` }); }
      continue;
    }
    if (!rec.quarantined) { out.busy.push(jobId); continue; }
    const r = await removeAndVerify(dockerFn, rec.containerName, verify);
    if (!r.verified) { out.uncertain.push({ jobId, error: r.error }); continue; }
    try {
      if (!heldTokens.has(rec.token) || readLock(file)?.token !== rec.token) { out.uncertain.push({ jobId, error: 'lock changed during cleanup: left in place' }); continue; }
      heldTokens.delete(rec.token);
      fs.writeFileSync(path.join(dir, `${jobId}.released`), new Date().toISOString());
      fs.unlinkSync(file);
      out.reaped.push(jobId);
      await onReaped?.(rec);
    } catch (e) { out.uncertain.push({ jobId, error: `container gone, lock not removed: ${msg(e)}` }); }
  }
  try {
    const listed = await dockerFn(['ps', '-a', '--filter', `label=${FENCE_LABEL}`, '--format', '{{.Names}}']);
    if (typeof listed !== 'string') throw new Error('docker ps returned no text');
    // A run that started while we were listing owns its container: read the locks again before calling anything unowned.
    try {
      for (const n of fs.readdirSync(dir)) {
        const rec = n.endsWith('.lock') ? readLock(path.join(dir, n)) : null;
        if (rec && !rec.invalid) owned.add(rec.containerName);
      }
    } catch { /* no lock folder: nothing is owned */ }
    for (const n of listed.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) if (!owned.has(n)) out.unowned.push(n);
  } catch (e) { out.listError = `could not list fenced containers: ${msg(e)}`; }
  return out;
}
