// CB5 (KAN-914): the per-job record and the per-job lock. Both live in <root>/.state, a host-owned folder that is a
// sibling of the job folders and is never part of what the agent can write. (The CB6 fence must mount only the job
// folder; if the whole root is writable by the agent this separation does not hold. That is a CB6 contract item.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import { CodebuiltError } from './errors.js';

export const JOB_STATUSES = Object.freeze(['prepared', 'running', 'complete', 'failed', 'integration_pending', 'orphaned']);
export const STATE_VERSION = 'codebuilt-job-v1';

/** The recorded state, or null when there is none. An existing record that cannot be trusted fails closed. */
export function readJobState(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CodebuiltError('BAD_JOB', 'the job record is not a regular file');
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* handled below */ }
  if (state?.version !== STATE_VERSION || !JOB_STATUSES.includes(state.status)) {
    throw new CodebuiltError('BAD_JOB', 'the job record is unreadable or has an unknown version; move it aside to start over');
  }
  return state;
}

/** Atomic write: a new, exclusively created temp file (never an existing path or link), then a rename. */
export function writeJobState(file, state) {
  const next = { ...state, version: STATE_VERSION };
  if (!JOB_STATUSES.includes(next.status)) throw new Error(`bad job status ${next.status}`);
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw error;
  }
  return next;
}

const held = new Set();

/**
 * One run per job at a time, in this process and across processes. Returns the release function.
 *
 * The lock is never reclaimed automatically. A lock file that already exists is JOB_BUSY, whether its owner looks dead,
 * its content is empty or it is garbage: judging a lock stale and unlinking it races with a new owner taking it, and
 * the loser could then delete the winner's lock. After a crash an operator removes <jobId>.lock by hand once they have
 * confirmed that no run and no fence for that job is alive (explicit recovery, fail closed).
 * The release is bound to the owner token written at acquisition: it removes the file only while the file still holds
 * that token, so a late or repeated release can never remove a replacement owner's lock.
 */
export function acquireJobLock(lockFile, key) {
  if (held.has(key)) throw new CodebuiltError('JOB_BUSY', 'this job is already running');
  held.add(key);
  const token = crypto.randomBytes(16).toString('hex');
  try {
    let fd;
    try { fd = fs.openSync(lockFile, 'wx'); } catch (error) {
      if (error?.code === 'EEXIST') throw new CodebuiltError('JOB_BUSY', 'this job is locked (a lock file exists; after a crash remove it by hand once nothing for this job is running)');
      throw error;
    }
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(fd); }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.delete(key);
      try {
        const body = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (body?.token === token) fs.unlinkSync(lockFile);
      } catch { /* gone, foreign or unreadable: not ours to remove */ }
    };
  } catch (error) {
    held.delete(key);
    throw error;
  }
}
