// CB6: job folder rules. The job folder is the ONLY place a code-built job may write.
// Threat model and limits: docs/codebuilt-isolation.md.
import fs from 'node:fs';
import path from 'node:path';
import { scanReparsePoints } from './reparse.js';

export const JOB_ROOT = 'C:/code/ForgeAi/output/agent-jobs';
// Owner boundary (rule 13): a job may not cause writes outside this folder. Unrelated writes inside it are not a failure.
export const CODE_ROOT = 'C:/code';
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** True when `child` is strictly below `parent` (equal paths are not "inside"). */
export function isInside(parent, child) {
  const rel = path.relative(norm(parent), norm(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export const samePath = (a, b) => norm(a) === norm(b);

export function assertJobId(id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id) || id.includes('..')) {
    throw new Error(`invalid job id: ${JSON.stringify(id)} (letters, digits, dot, dash, underscore; max 64)`);
  }
  return id;
}

export function resolveJobDir(jobId, { jobRoot = JOB_ROOT } = {}) {
  return path.resolve(jobRoot, assertJobId(jobId));
}

/**
 * An existing real directory whose filesystem path (realpath) is exactly the path that was written. A junction or
 * symlink in ANY component, an 8.3 short name (PROGRA~1) or a substituted drive resolves to a different path and is
 * refused: only the name that was checked is the folder that gets mounted. Returns the real path.
 */
export function assertRealDir(p, what = 'path') {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`${what} must be an absolute path: ${p}`);
  const abs = path.resolve(p);
  let st;
  try { st = fs.lstatSync(abs); } catch (error) {
    const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
    const result = new Error(`${what} ${missing ? 'does not exist' : 'cannot be inspected'}: ${abs}`);
    result.code = missing ? error.code : 'PATH_UNAVAILABLE';
    throw result;
  }
  if (st.isSymbolicLink()) throw new Error(`${what} is a symlink/junction, refused: ${abs}`);
  if (!st.isDirectory()) throw new Error(`${what} is not a directory: ${abs}`);
  const real = fs.realpathSync.native(abs);
  if (!samePath(real, abs)) throw new Error(`${what} is reached through a link or an alias (real path ${real}), refused: ${abs}`);
  return real;
}

/**
 * The job dir must be absolute, a direct child of the job root, and both must be real directories written by their
 * real path (no symlink, junction or short-name alias anywhere). Returns the real path: that is what gets mounted.
 */
export function assertJobDirSafe(jobDir, { jobRoot = JOB_ROOT } = {}) {
  if (typeof jobDir !== 'string' || !path.isAbsolute(jobDir)) throw new Error(`job dir must be an absolute path: ${jobDir}`);
  const dir = path.resolve(jobDir);
  const root = path.resolve(jobRoot);
  if (!isInside(root, dir) || !samePath(path.dirname(dir), root)) {
    throw new Error(`job dir must be a direct child inside the job root ${root}: ${dir}`);
  }
  const realRoot = assertRealDir(root, 'job root');
  const real = assertRealDir(dir, 'job dir');
  if (!isInside(realRoot, real)) throw new Error(`job dir real path escapes the job root: ${real}`);
  return real;
}

/**
 * Walks a tree without following links and lists every symlink/junction in it.
 * `complete` is false when the walk hit the entry limit or could not read something: callers must fail closed.
 */
export function findLinks(dir, { maxEntries = 50000, reparseScan } = {}) {
  const links = [], errors = [];
  let entries = 0, truncated = false;
  const walk = (d) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { errors.push(`${d}: ${e.code ?? e.message}`); return; }
    for (const it of items) {
      if (truncated) return;
      if (++entries > maxEntries) { truncated = true; return; }
      const full = path.join(d, it.name);
      let st;
      try { st = fs.lstatSync(full); } catch (e) { errors.push(`${full}: ${e.code ?? e.message}`); continue; }
      if (st.isSymbolicLink()) links.push(full);
      else if (st.isDirectory()) walk(full);
    }
  };
  walk(path.resolve(dir));
  // Host consumers pass reparseScan: it also finds links Node cannot see (a WSL symlink made by a container looks like
  // a regular file to lstat). A scan that cannot finish is an error, so `complete` is false and callers fail closed.
  if (reparseScan) {
    const r = reparseScan(path.resolve(dir));
    for (const p of r.points) if (!links.includes(p)) links.push(p);
    errors.push(...r.errors);
    if (r.truncated) truncated = true;
  }
  return { links, errors, truncated, entries: Math.min(entries, maxEntries), complete: !truncated && errors.length === 0 };
}

/** Throws when the tree holds a link or could not be checked completely. */
export function assertNoLinksInTree(dir, what = 'folder', opts) {
  const r = findLinks(dir, opts);
  if (r.links.length) throw new Error(`${what} contains a symlink/junction, refused: ${r.links[0]}`);
  if (!r.complete) throw new Error(`${what} could not be checked for links completely (${r.truncated ? 'too many entries' : r.errors[0]}), refused`);
  return r;
}

/**
 * For HOST code that is about to open a file a job produced. Job output is untrusted: a job can leave a symlink or
 * junction that points at a host file. `rel` is a path relative to the job folder. Every component is checked
 * (no link, no alias), the target must be a regular file, and its real path must stay inside the job folder.
 * Returns the real path. Call it only after the job's container is gone, and open the returned path right away.
 */
export function resolveJobOutput(jobDir, rel, { jobRoot = JOB_ROOT, reparseScan = scanReparsePoints } = {}) {
  const realJob = assertJobDirSafe(jobDir, { jobRoot });
  // Windows: a WSL/container-made symlink is invisible to lstat. Refuse the whole folder when the file system reports
  // any reparse point in it, or when it cannot say (fail closed). Not a bypass for non-Windows hosts: lstat suffices there.
  const scan = reparseScan(realJob);
  if (scan.points.length) throw new Error(`job folder contains a reparse point (symlink/junction of any kind), refused: ${scan.points[0]}`);
  if (scan.errors.length || scan.truncated || scan.complete === false) throw new Error(`job folder could not be checked for reparse points (${scan.errors[0] ?? 'incomplete'}), refused`);
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /[\u0000:*?"<>|]/.test(rel)) {
    throw new Error(`job output must be a plain relative path: ${JSON.stringify(rel)}`);
  }
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some(s => s === '.' || s === '..')) throw new Error(`job output path may not contain . or .. segments: ${JSON.stringify(rel)}`);
  let cur = realJob;
  parts.forEach((part, i) => {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { throw new Error(`job output does not exist: ${cur}`); }
    if (st.isSymbolicLink()) throw new Error(`job output passes through a symlink/junction, refused: ${cur}`);
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) throw new Error(`job output is not a regular ${last ? 'file' : 'directory'}: ${cur}`);
  });
  const real = fs.realpathSync.native(cur);
  if (!samePath(real, cur) || !isInside(realJob, real)) throw new Error(`job output resolves outside the job folder or through an alias (${real}), refused: ${cur}`);
  return real;
}
