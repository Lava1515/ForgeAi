import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getActiveRuns } from '../routes/runs.js';
import { gpuFenceHold } from './codebuilt/jobLock.js';

// Limits: FIFO fairness is in-process only (other processes race on mkdir). A reclaimer that grabs a live lock by
// mistake restores it by rename; in the double race where a third process mkdirs in that instant, the live lock is
// kept as a `.stale-*` quarantine (never swept while its owner is alive) rather than deleted.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_LOCK_DIR = path.join(process.env.FORGEAI_ROOT || REPO_ROOT, '.superpowers/supervisor/gpu.lock');
// A lease whose owner pid is dead is normally reclaimed. Not while a code-built (CB6) lock says a GPU container of
// that run may still be running: a crashed dashboard leaves its container behind. Applies to the real GPU lock only.
const defaultFenceHold = () => { const h = gpuFenceHold(); return h.held ? h : null; };
const queues = new Map();
const EMPTY_LOCK_GRACE_MS = 30000;
const STALE_SWEEP_MS = 60000;
const PROBE_BACKOFF_START_MS = 10;
const PROBE_BACKOFF_MAX_MS = 100;
const CLAIM_LOST = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']);
let lastStart = 0;

const timeoutError = () => Object.assign(new Error('GPU queue timeout (held or unknown owner)'), { timeout: true });
const abortError = () => Object.assign(new Error('GPU wait aborted'), { name: 'AbortError', code: 'ABORT_ERR' });

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
  });
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; } // EPERM and unknown failures are held.
}

function ownerRecord(raw) {
  // Windows scripts write CRLF: any trailing whitespace is accepted, our own writes stay LF.
  const match = /^(\S+) (\S+) (\S+) pid ([1-9]\d*)\s*$/.exec(raw);
  if (!match || !Number.isSafeInteger(Number(match[4])) || !Number.isFinite(Date.parse(match[3]))) return null;
  return { pid: Number(match[4]), start: match[3] };
}

const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function plainLock(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('refusing junction/symlink GPU lock');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function plainParent(lockDir) {
  try {
    if (fs.lstatSync(path.dirname(lockDir)).isSymbolicLink()) throw new Error('refusing junction/symlink GPU lock parent');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// kind: gone | owner (parsed record) | empty (no entries at all, with mtime) | unknown (anything else: held).
function inspect(dir) {
  try {
    if (!plainLock(dir)) return { kind: 'gone' };
    const file = path.join(dir, 'owner');
    let stat = null;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat) {
      if (fs.readdirSync(dir).length) return { kind: 'unknown' };
      return { kind: 'empty', mtimeMs: fs.lstatSync(dir).mtimeMs };
    }
    if (!stat.isFile()) return { kind: 'unknown' };
    const owner = ownerRecord(fs.readFileSync(file, 'utf8'));
    return owner ? { kind: 'owner', ...owner } : { kind: 'unknown' };
  } catch (error) { if (missing(error)) return { kind: 'gone' }; throw error; }
}

function readOwner(dir) {
  const state = inspect(dir);
  return state.kind === 'owner' ? { pid: state.pid, start: state.start } : null;
}

function sameState(state, expected) {
  if (state.kind !== expected.kind) return false;
  return state.kind !== 'owner' || (state.pid === expected.pid && state.start === expected.start);
}

// Deletes only a uniquely named quarantine directory (owner file first, then rmdir); never a link.
function removeQuarantine(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const file = path.join(dir, 'owner');
    try {
      if (!fs.lstatSync(file).isFile()) return false;
      fs.unlinkSync(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.rmdirSync(dir);
    return true;
  } catch { return false; }
}

function exists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/**
 * Read-only classification for readiness (never deletes or renames anything):
 *   free   no lock dir; stale  owner pid is dead, or an ownerless dir idle past the grace (the next acquire reclaims it);
 *   held   live/EPERM/unreadable-pid owner, a young empty dir, or an unparseable owner (held on any doubt).
 * `owner` is the trimmed owner text for messages. A pid probe that throws counts as alive.
 */
export function classifyLock(lockDir, { isPidAliveFn = pidAlive, now = () => new Date(), emptyLockGraceMs = EMPTY_LOCK_GRACE_MS, fenceHoldFn } = {}) {
  lockDir = path.resolve(lockDir);
  fenceHoldFn ??= path.resolve(lockDir) === path.resolve(DEFAULT_LOCK_DIR) ? defaultFenceHold : () => null;
  const state = inspect(lockDir);
  if (state.kind === 'gone') return { state: 'free' };
  let text = '';
  try { text = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8').trim().slice(0, 120); } catch { /* ownerless or unreadable */ }
  const owner = text || 'an unknown owner';
  if (state.kind === 'owner') {
    let alive = true;
    try { alive = isPidAliveFn(state.pid); } catch { alive = true; }
    if (alive === false) {
      let fence = null;
      try { fence = fenceHoldFn(); } catch { fence = { jobs: [] }; } // unknown is held
      if (fence) return { state: 'held', owner, pid: state.pid, fenceHold: fence.jobs ?? [] };
    }
    return { state: alive === false ? 'stale' : 'held', owner, pid: state.pid };
  }
  if (state.kind === 'empty' && now().getTime() - state.mtimeMs > emptyLockGraceMs) return { state: 'stale', owner };
  return { state: 'held', owner };
}

/**
 * Claims a lock that looked dead/orphaned by renaming it to a unique name (atomic, one winner), then re-reads
 * it inside the quarantine. Only a verified match is deleted; anything else is put back.
 * Returns 'reclaimed' | 'lost' (another process won) | 'restored' | 'quarantined' (could not put it back).
 */
export function reclaimLock(lockDir, expected, { hooks = {} } = {}) {
  const stale = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lockDir, stale); }
  catch (error) { if (CLAIM_LOST.has(error.code)) return 'lost'; throw error; }
  hooks.afterClaim?.(stale);
  let verified = false;
  try { verified = sameState(inspect(stale), expected); } catch { verified = false; }
  if (verified) return removeQuarantine(stale) ? 'reclaimed' : 'quarantined';
  try { if (!exists(lockDir)) { fs.renameSync(stale, lockDir); return 'restored'; } } catch { /* keep as quarantine */ }
  return 'quarantined';
}

// Crash leftovers: `<lock>.stale-*` is removed once old enough and its owner is dead or unreadable.
async function sweepStale(lockDir, { isPidAliveFn, now, sweepMs, deadline, signal }) {
  const parent = path.dirname(lockDir), prefix = `${path.basename(lockDir)}.stale-`;
  let names;
  try { names = fs.readdirSync(parent).filter(name => name.startsWith(prefix)); } catch { return; }
  for (const name of names) {
    const dir = path.join(parent, name);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || now().getTime() - stat.mtimeMs <= sweepMs) continue;
      const state = inspect(dir);
      if (state.kind === 'owner') {
        let alive = true;
        try { alive = await bounded(Promise.resolve().then(() => isPidAliveFn(state.pid)), deadline, signal); }
        catch (error) { if (signal?.aborted) throw abortError(); if (Date.now() >= deadline) throw timeoutError(); }
        if (alive !== false) continue;
      }
      removeQuarantine(dir);
    } catch (error) { if (error.name === 'AbortError' || error.timeout) throw error; }
  }
}

async function bounded(promise, deadline, signal) {
  let timer, onAbort;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError()), Math.max(0, deadline - Date.now()));
      if (!signal) return;
      onAbort = () => reject(abortError());
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
}

async function waitTurn(dir, deadline, signal) {
  const prior = queues.get(dir) || Promise.resolve();
  let unlock;
  const turn = new Promise(resolve => { unlock = resolve; });
  const tail = prior.then(() => turn);
  queues.set(dir, tail);
  const done = () => {
    unlock();
    // A cancelled waiter must stay chained behind the earlier holder.
    void tail.then(() => { if (queues.get(dir) === tail) queues.delete(dir); });
  };
  try { await bounded(prior, deadline, signal); return done; }
  catch (error) { done(); throw error; }
}

async function acquireLease({ who = 'episode', ticket = 'KAN-831', timeoutMs = 30000,
  lockDir = DEFAULT_LOCK_DIR,
  getActiveRunsFn = getActiveRuns, isPidAliveFn = pidAlive, now = () => new Date(), fenceHoldFn,
  emptyLockGraceMs = EMPTY_LOCK_GRACE_MS, staleSweepMs = STALE_SWEEP_MS, signal, hooks = {} } = {}) {
  if (!/^\S+$/.test(who) || !/^\S+$/.test(ticket)) throw new Error('GPU owner fields must be single words');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid GPU timeout');
  lockDir = path.resolve(lockDir);
  fenceHoldFn ??= lockDir === path.resolve(DEFAULT_LOCK_DIR) ? defaultFenceHold : () => null;
  plainParent(lockDir);
  const deadline = Date.now() + timeoutMs;
  const unlockQueue = await waitTurn(lockDir, deadline, signal);
  try {
    await sweepStale(lockDir, { isPidAliveFn, now, sweepMs: staleSweepMs, deadline, signal });
    let backoff = PROBE_BACKOFF_START_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError();
      let runs = null;
      try { runs = await bounded(Promise.resolve().then(getActiveRunsFn), deadline, signal); }
      catch { if (signal?.aborted) throw abortError(); } // A failing probe means runs are unknown: never take the lock.
      if (!Array.isArray(runs)) {
        await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())), signal);
        backoff = Math.min(backoff * 2, PROBE_BACKOFF_MAX_MS);
        continue;
      }
      if (runs.length) { await sleep(Math.min(25, Math.max(0, deadline - Date.now())), signal); continue; }
      fs.mkdirSync(path.dirname(lockDir), { recursive: true });
      let created = false;
      try { fs.mkdirSync(lockDir); created = true; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (created) {
        // The ISO start is the per-instance token, retaining the scripts' exact owner format.
        let token;
        try {
          const time = now().getTime();
          if (!Number.isFinite(time)) throw new Error('invalid GPU start time');
          lastStart = Math.max(time, lastStart + 1);
          token = new Date(lastStart).toISOString();
          fs.writeFileSync(path.join(lockDir, 'owner'), `${who} ${ticket} ${token} pid ${process.pid}\n`, { flag: 'wx' });
        } catch (error) { try { fs.rmdirSync(lockDir); } catch { /* grace period reclaims it */ } throw error; }
        let released = false;
        return {
          // Intent only: a consumer that implements job.render_resume_v1 (blender_worker/render_resume.py validates
          // fingerprints before keeping frames) may act on it; code with no such consumer must not claim resume.
          resume: true,
          async release() {
            if (released) return false;
            released = true;
            try {
              const current = readOwner(lockDir);
              if (!current || current.pid !== process.pid || current.start !== token) return false;
              fs.unlinkSync(path.join(lockDir, 'owner'));
              // A transient rmdir failure (Windows EBUSY/EPERM) must not leave an owner-less dir held for the grace period.
              for (let attempt = 0; ; attempt++) {
                try { (hooks.rmdir || fs.rmdirSync)(lockDir); return true; }
                catch (error) {
                  if (error.code === 'ENOENT') return true;
                  if (attempt >= 4) throw error;
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
                }
              }
            } catch { return false; } // Left behind: classifyLock reports it stale after the grace and the next acquire reclaims it.
            finally { unlockQueue(); }
          },
        };
      }
      const observed = inspect(lockDir);
      let claim = null;
      if (observed.kind === 'gone') continue;
      if (observed.kind === 'owner') {
        let alive = true;
        try { alive = await bounded(Promise.resolve().then(() => isPidAliveFn(observed.pid)), deadline, signal); }
        catch { if (signal?.aborted) throw abortError(); if (Date.now() >= deadline) throw timeoutError(); }
        if (alive === false) {
          let fence = null;
          try { fence = fenceHoldFn(); } catch { fence = { jobs: [] }; } // unknown is held
          if (!fence) claim = observed; // else: dead owner but a fenced GPU container may still run; wait, then time out
        }
      } else if (observed.kind === 'empty' && now().getTime() - observed.mtimeMs > emptyLockGraceMs) {
        claim = observed; // An ownerless dir is held until it has been idle past the grace period.
      }
      if (claim) {
        await hooks.beforeReclaim?.({ lockDir, observed });
        if (reclaimLock(lockDir, claim, { hooks }) === 'reclaimed') continue;
      }
      await sleep(Math.min(25, Math.max(0, deadline - Date.now())), signal);
    }
    throw timeoutError();
  } catch (error) { unlockQueue(); throw error; }
}

export async function acquireGpu(options = {}) {
  const { signal } = options;
  if (signal?.aborted) throw abortError();
  const lease = await acquireLease(options);
  // Aborted after the lock was taken but before the caller got it: give it back, never leak it.
  if (signal?.aborted) { await lease.release(); throw abortError(); }
  return lease;
}

export async function withGpu(fn, options) {
  const lease = await acquireGpu(options);
  try { return await fn({ resume: lease.resume }); }
  finally { await lease.release(); }
}
