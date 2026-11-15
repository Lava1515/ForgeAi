// CB6: detection that does not depend on the agent being honest. Best effort, and labelled as such:
// - snapshot/diff of places that must not change while a job runs;
// - static scan of job-folder text files for reach-outs (.env, outside paths, secret env, Blender spawns), and for
//   links left in the job folder;
// - leak scan: known host secret values found in job output.
// None of this is prevention. Prevention is the Docker fence (dockerFence.js).
//
// Every check reports what it covered. A check that could not look at everything (entry limit, unreadable folder,
// oversize file) says `complete: false`, and a check that had nothing to work with says `status: 'not_run'`.
// Neither is ever reported as clean: the caller fails closed on both.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, samePath } from './jobPaths.js';

const IGNORE_DIRS = new Set(['node_modules', '.git']);
const errText = (p, e) => `${p}: ${e.code ?? e.message}`;

/**
 * specs: [{ root, depth, exclude?: string[], frontierMtime?: boolean, detailBudget?: number }]; depth 0 = direct
 * children only. Never follows links.
 *
 * `frontierMtime`: a directory that is listed but not walked into (depth reached) is recorded as `d:<mtime>` instead of
 * plain `d`. Its mtime changes when a direct child is added, removed or renamed, so a change inside it is still seen
 * although its children are not listed.
 *
 * `detailBudget` (a folder of many sibling job folders; implies frontierMtime, and lists children one level deep):
 * every direct child of the root is always listed (that count is what `maxEntries` guards). Their own children are
 * listed for the newest folders only, until `detailBudget` entries are spent; the rest are covered by their
 * `d:<mtime>` entry alone and reported in `roots[].detail.summarised`, never as `truncated`. The set of listed folders
 * is chosen by the first snapshot; pass it as `like` to the second so both compare the same folders. A snapshot's cost is
 * therefore bounded by detailBudget plus the number of top-level entries, whatever the folders below hold.
 */
export function snapshotTrees(specs, { maxEntries = 50000, like } = {}) {
  const entries = new Map();
  let truncated = false;
  const errors = [];
  const detail = new Map(); // spec index -> { listed: Set<path>, summarised: number }
  const sigOf = (st, isDir, mtimeForDir) => (isDir ? (mtimeForDir ? `d:${Math.floor(st.mtimeMs)}` : 'd') : `f:${st.size}:${Math.floor(st.mtimeMs)}`);
  const walk = (dir, level, spec) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { errors.push(errText(dir, e)); return; }
    for (const it of items) {
      if (truncated) return;
      const full = path.join(dir, it.name);
      if ((spec.exclude ?? []).some(x => samePath(x, full))) continue;
      let st;
      try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') errors.push(errText(full, e)); continue; } // ENOENT: removed while listing
      if (entries.size >= maxEntries) { truncated = true; return; }
      const isDir = st.isDirectory();
      const descend = isDir && !st.isSymbolicLink() && level < spec.depth && !IGNORE_DIRS.has(it.name);
      // Directory mtime changes whenever a child changes; children are compared on their own, unless they are not listed.
      entries.set(full, sigOf(st, isDir, spec.frontierMtime && !descend));
      if (descend) walk(full, level + 1, spec);
    }
  };
  // One level of children for the folders in the budget; everything else is a single `d:<mtime>` entry.
  const walkBudgeted = (spec, index) => {
    const rootDir = path.resolve(spec.root);
    const info = { listed: new Set(), summarised: 0 };
    detail.set(index, info);
    let items;
    try { items = fs.readdirSync(rootDir, { withFileTypes: true }); } catch (e) { errors.push(errText(rootDir, e)); return; }
    const candidates = [];
    for (const it of items) {
      const full = path.join(rootDir, it.name);
      if ((spec.exclude ?? []).some(x => samePath(x, full))) continue;
      let st;
      try { st = fs.lstatSync(full); } catch (e) { if (e.code !== 'ENOENT') errors.push(errText(full, e)); continue; }
      if (entries.size >= maxEntries) { truncated = true; return; }
      const isDir = st.isDirectory();
      entries.set(full, sigOf(st, isDir, true)); // level 0 directories always carry their mtime: add/remove/rename inside is seen
      if (isDir && !st.isSymbolicLink() && !IGNORE_DIRS.has(it.name)) candidates.push({ full, name: it.name, mtimeMs: st.mtimeMs });
    }
    const wanted = like?.detail?.get(index)?.listed;
    let remaining = spec.detailBudget;
    // First snapshot: newest folders first, name as the tie-break. Second snapshot: exactly the first one's folders.
    const order = wanted ? candidates.filter(c => wanted.has(c.full)) : [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const c of order) {
      if (truncated) return;
      if (!wanted) {
        let size;
        try { size = fs.readdirSync(c.full).length; } catch { size = 0; } // unreadable: the walk below reports it as an error
        if (size > remaining) continue; // too big for what is left: summarised, a smaller folder may still fit
      }
      const before = entries.size;
      walk(c.full, 1, { ...spec, depth: 1, frontierMtime: true, exclude: [] });
      remaining -= entries.size - before;
      info.listed.add(c.full);
    }
    info.summarised = candidates.length - info.listed.size;
  };
  specs.forEach((spec, i) => { if (spec.detailBudget !== undefined) walkBudgeted(spec, i); else walk(path.resolve(spec.root), 0, spec); });
  const rootsInfo = specs.map((s, i) => ({
    root: path.resolve(s.root), depth: s.depth,
    ...(s.detailBudget !== undefined ? { detail: { budget: s.detailBudget, listedFolders: detail.get(i)?.listed.size ?? 0, summarisedFolders: detail.get(i)?.summarised ?? 0 } } : {}),
  }));
  return { entries, truncated, errors, roots: rootsInfo, detail };
}

const SENSITIVE_NAME_RE = /^\.env(?:\.|$)/i;
const errPath = (e) => { const i = e.lastIndexOf(': '); return i < 0 ? e : e.slice(0, i); };

/**
 * `ignoreUnder`: folders whose changes are not this job's (other jobs that were live during the run). They are
 * left out of the comparison and listed in the result, never silently.
 * `codeRoot` (owner rule: the boundary is "no writes outside C:/code"): changes inside it that are not a .env file are
 * reported (`status: 'inside_code_changes'`, still listed) but are not a failure; any change outside it, and any .env,
 * is `changed`. Unreadable entries are split into coverage.gaps.insideCode / outsideCode: only an outside gap (or a
 * truncated walk) makes the snapshot `incomplete`. Every error stays in `errors`. Without codeRoot the old strict rule
 * applies. The snapshot is bounded observation, never exhaustive: coverage.exhaustive is always false.
 * status: 'clean' | 'inside_code_changes' | 'changed' | 'incomplete' (truncated or unreadable: proves nothing) | 'not_run'.
 */
export function diffSnapshots(before, after, { ignoreUnder = [], codeRoot } = {}) {
  const skip = (p) => ignoreUnder.some(d => samePath(d, p) || isInside(d, p));
  const added = [], changed = [], removed = [];
  for (const [p, sig] of after.entries) {
    if (skip(p)) continue;
    if (!before.entries.has(p)) added.push(p);
    else if (before.entries.get(p) !== sig) changed.push(p);
  }
  for (const p of before.entries.keys()) if (!after.entries.has(p) && !skip(p)) removed.push(p);
  const truncated = Boolean(before.truncated || after.truncated);
  const errors = [...(before.errors ?? []), ...(after.errors ?? [])];
  const roots = after.roots ?? before.roots ?? [];
  const inCode = (p) => Boolean(codeRoot) && (samePath(codeRoot, p) || isInside(codeRoot, p));
  const gaps = { insideCode: errors.filter(e => inCode(errPath(e))), outsideCode: errors.filter(e => !inCode(errPath(e))) };
  const all = [...added, ...changed, ...removed];
  const anyChange = all.length > 0;
  const sensitive = codeRoot ? all.some(p => !inCode(p) || SENSITIVE_NAME_RE.test(path.basename(p))) : anyChange;
  const blockingErrors = codeRoot ? gaps.outsideCode.length : errors.length;
  const status = sensitive ? 'changed' : truncated || blockingErrors ? 'incomplete' : roots.length === 0 ? 'not_run' : anyChange ? 'inside_code_changes' : 'clean';
  return {
    ok: status === 'clean' || status === 'inside_code_changes', status, added, changed, removed, truncated, errors,
    coverage: { roots, ignored: ignoreUnder.map(d => path.resolve(d)), codeRoot: codeRoot ? path.resolve(codeRoot) : null, gaps, exhaustive: false },
  };
}

const TEXT_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.bat', '.ps1', '.json', '.jsonl', '.md', '.txt', '.log', '.cfg', '.toml', '.yaml', '.yml']);

/** True only when the WHOLE file parses as JSON (every non-blank line for .jsonl). Anything else is scanned as source. */
function isInertJson(file, text) {
  const ext = path.extname(file).toLowerCase();
  const t = text.replace(/^﻿/, '');
  try {
    if (ext === '.json') { JSON.parse(t); return true; }
    if (ext === '.jsonl') { for (const l of t.split(/\r?\n/)) if (l.trim()) JSON.parse(l); return true; }
  } catch { return false; }
  return false;
}

/** Walks every file of the job folder. Never follows links; reports links, read errors and the limit in `state`. */
function* walkFiles(dir, limit, state) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { state.errors.push(errText(dir, e)); return; }
  for (const it of items) {
    if (state.truncated) return;
    const full = path.join(dir, it.name);
    let st;
    try { st = fs.lstatSync(full); } catch (e) { state.errors.push(errText(full, e)); continue; }
    if (st.isSymbolicLink()) { state.links.push(full); continue; }
    if (st.isDirectory()) { yield* walkFiles(full, limit, state); continue; }
    if (!st.isFile()) { state.special.push(full); continue; }
    if (state.files >= limit) { state.truncated = true; return; }
    state.files++;
    yield { file: full, size: st.size };
  }
}
const newState = () => ({ files: 0, truncated: false, errors: [], links: [], special: [] });

const ENV_FILE_RE = /(?:^|[\\/'"\s])\.env(?:[\\/'"\s.\])]|$)/;
const SECRET_ENV_RE = /(?:environ(?:\.get)?\s*[[(]|getenv\s*\()\s*['"][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*['"]/i;
const BLENDER_SPAWN_RE = /(?:subprocess|Popen|os\.system|os\.exec\w*|spawn\w*|execFile\w*|exec\w*)[^\n]*['"][^'"\n]*blender/i;
const ABS_LITERAL_RE = /(["'])((?:[A-Za-z]:[\\/]|\/)[^"'\n]*)\1/g;
const SYSTEM_PREFIX_RE = /^\/(etc|proc|sys|root|home|var|mnt|host|run|dev(?!\/null))(\/|$)/;

function outsidePath(literal, jobDir) {
  const p = literal.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(p)) return !(isInside(jobDir, path.resolve(literal)) || samePath(jobDir, path.resolve(literal)));
  return SYSTEM_PREFIX_RE.test(p);
}

/**
 * returns { findings, coverage: { complete, filesSeen, textFilesScanned, inertJsonFiles, notTextFiles, oversize, links, special, errors, truncated } }
 * Files that are not text by extension are counted, not scanned (a picture has no script lines). Everything else that
 * was not looked at (oversize text file, unreadable file or folder, the file limit) makes `complete` false.
 * A symlink/junction or a special file in the job folder is a high finding: host code must never follow one.
 */
export function scanJobForViolations(jobDir, { maxFiles = 20000, maxFileBytes = 1024 * 1024, reparseScan } = {}) {
  const findings = [];
  const state = newState();
  const cov = { textFilesScanned: 0, notTextFiles: 0, inertJsonFiles: 0, oversize: [] };
  for (const { file, size } of walkFiles(jobDir, maxFiles, state)) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) { cov.notTextFiles++; continue; }
    if (size > maxFileBytes) { cov.oversize.push(file); continue; }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { state.errors.push(errText(file, e)); continue; }
    cov.textFilesScanned++;
    const inert = isInertJson(file, text);
    if (inert) cov.inertJsonFiles++;
    text.split(/\r?\n/).forEach((line, i) => {
      // Parsed JSON is data, not something that runs: a quoted path in it is kept as an info finding, not a violation.
      const add = (kind, severity) => findings.push(inert
        ? { kind, severity: 'info', inertData: true, file, line: i + 1, snippet: line.trim().slice(0, 160) }
        : { kind, severity, file, line: i + 1, snippet: line.trim().slice(0, 160) });
      if (ENV_FILE_RE.test(line)) add('env_file', 'high');
      if (SECRET_ENV_RE.test(line)) add('secret_env', 'high');
      if (BLENDER_SPAWN_RE.test(line)) add('blender_spawn', 'info');
      let outside = /(?:^|[\\/'"])\.\.[\\/]/.test(line);
      for (const m of line.matchAll(ABS_LITERAL_RE)) if (outsidePath(m[2], jobDir)) outside = true;
      if (outside) add('outside_path', 'high');
    });
  }
  const reparse = reparseScan ? reparseScan(path.resolve(jobDir)) : null;
  if (reparse) {
    for (const p of reparse.points) if (!state.links.includes(p)) state.links.push(p);
    state.errors.push(...reparse.errors);
    if (reparse.truncated) state.truncated = true;
  }
  for (const file of state.links) findings.push({ kind: 'link_in_job', severity: 'high', file, line: 0, snippet: 'symlink or junction in the job folder' });
  for (const file of state.special) findings.push({ kind: 'special_file_in_job', severity: 'high', file, line: 0, snippet: 'not a regular file or directory' });
  const complete = !state.truncated && state.errors.length === 0 && cov.oversize.length === 0;
  return { findings, coverage: { complete, filesSeen: state.files, ...cov, reparseScan: reparse ? (reparse.complete ? 'complete' : 'incomplete') : 'not_run', links: state.links.length, special: state.special.length, errors: state.errors, truncated: state.truncated } };
}

/**
 * Known host secret values (min 8 chars) found in any job file. The report never repeats a secret.
 * status: 'not_run' (no usable secret value was supplied: this says NOTHING about leaks) | 'leak' |
 *         'incomplete' (a file was skipped or unreadable, or the file limit was hit) | 'clean'.
 * This finds a value copied as-is. An encoded or split value is not found.
 */
export function findSecretLeaks(jobDir, secretValues, { maxFiles = 20000, maxFileBytes = 64 * 1024 * 1024 } = {}) {
  const given = Array.isArray(secretValues) ? secretValues : [];
  const usable = given.map((s, secretIndex) => ({ s, secretIndex })).filter(x => typeof x.s === 'string' && x.s.length >= 8);
  const coverage = { secretsSupplied: given.length, secretsUsed: usable.length, secretsIgnoredShort: given.length - usable.length, filesScanned: 0, oversize: [], errors: [], truncated: false };
  if (!usable.length) return { status: 'not_run', reason: 'no secret value of 8 or more characters was supplied', leaks: [], coverage };
  const needles = usable.map(x => ({ buf: Buffer.from(x.s), secretIndex: x.secretIndex }));
  const leaks = [];
  const state = newState();
  for (const { file, size } of walkFiles(jobDir, maxFiles, state)) {
    if (size > maxFileBytes) { coverage.oversize.push(file); continue; }
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { state.errors.push(errText(file, e)); continue; }
    coverage.filesScanned++;
    for (const n of needles) if (buf.includes(n.buf)) leaks.push({ file, secretIndex: n.secretIndex });
  }
  coverage.errors = state.errors;
  coverage.truncated = state.truncated;
  const incomplete = state.truncated || state.errors.length > 0 || coverage.oversize.length > 0;
  return { status: leaks.length ? 'leak' : incomplete ? 'incomplete' : 'clean', reason: null, leaks, coverage };
}

/**
 * Prevention evidence from the TRUSTED Docker argv that the host built and spawned (not from anything the agent wrote).
 * It states what the fence allowed: network, rootfs, caps, user, GPUs, resource bounds, the NAMES (never the values) of
 * the environment variables passed with -e, and which host folders were mounted and how.
 * It is a statement about policy, not an observation of what happened; observation is the bounded snapshot.
 */
export function preventionEvidence(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const after = (flag) => { const i = a.indexOf(flag); return i < 0 ? null : a[i + 1] ?? null; };
  const mounts = a.flatMap((x, i) => (x === '--mount' ? [a[i + 1] ?? ''] : []))
    .map(m => Object.fromEntries(m.split(',').map(kv => { const j = kv.indexOf('='); return j < 0 ? [kv, true] : [kv.slice(0, j), kv.slice(j + 1)]; })))
    .filter(m => m.type === 'bind');
  const view = (m) => ({ src: m.src, dst: m.dst });
  // Names only: a value can be a path or, in a misuse, a secret, and the report is stored with the job.
  const envKeys = a.flatMap((x, i) => (x === '-e' || x === '--env' ? [String(a[i + 1] ?? '')] : []))
    .map(kv => (kv.includes('=') ? kv.slice(0, kv.indexOf('=')) : kv)).sort();
  const gpus = a.flatMap((x, i) => (x === '--gpus' ? [a[i + 1] ?? ''] : []));
  return {
    source: 'docker_argv_policy',
    containerName: after('--name'), // binds the evidence to the container of THIS run (the name carries the run token)
    network: after('--network'),
    readOnlyRootfs: a.includes('--read-only'),
    capDropAll: after('--cap-drop') === 'ALL',
    noNewPrivileges: after('--security-opt') === 'no-new-privileges',
    user: after('--user'),
    memory: after('--memory'), memorySwap: after('--memory-swap'), cpus: after('--cpus'), pidsLimit: after('--pids-limit'),
    gpus: gpus.length ? gpus : null,
    envKeys,
    writableHostMounts: mounts.filter(m => !('readonly' in m || 'ro' in m)).map(view),
    readonlyHostMounts: mounts.filter(m => 'readonly' in m || 'ro' in m).map(view),
  };
}
