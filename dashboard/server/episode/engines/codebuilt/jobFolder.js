// CB5 (KAN-914): job folder confinement and the read-only input copy. This module never deletes folders; it only
// creates the job folder, copies inputs in once, and verifies by hash that they were not changed afterwards.
// The read-only attribute on inputs is advisory only (the agent can chmod its own mount); the recorded SHA-256 check
// is the real protection. Checks here run on the host between operations and cannot close a race with a live
// writer inside the mount; the CB6 fence must stop the agent before outputs are collected.
import { parseOverlaySpec } from '../../codebuilt/overlaySpec.js';
import { frameCountFor, FPS } from '../../codebuilt/planner.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CodebuiltError } from './errors.js';

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
export const INPUT_FILES = Object.freeze(['script.txt', 'vo.wav', 'words.json', 'pathpack.json', 'brief.md']);
export const OUTPUT_FILES = Object.freeze({ video: 'video.mp4', subtitles: 'subtitles.srt', sheet: 'contact_sheet.png', report: 'report.json' });
export const STATE_DIR = '.state';

const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);

export function inside(parent, child) {
  const rel = path.relative(fold(parent), fold(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** SHA-256 of a regular, unlinked, single-name file; null for anything else (missing, link, folder, hard link). */
export function hashRegularFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

export function assertAbsoluteRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.split(/[\\/]/).includes('..')) {
    throw new CodebuiltError('BAD_JOB', 'job root must be an absolute path without ".." segments');
  }
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) throw new CodebuiltError('BAD_JOB', 'job root must not be a drive root');
  return resolved;
}

/** The job folder for an id, directly under the root. Host-owned state and lock files sit outside it, in .state. */
export function jobPaths(root, jobId) {
  const base = assertAbsoluteRoot(root);
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new CodebuiltError('BAD_JOB', 'job id must be 1-64 letters, digits, - or _');
  if (WINDOWS_RESERVED.test(jobId)) throw new CodebuiltError('BAD_JOB', 'job id is a reserved device name');
  const dir = path.join(base, jobId);
  const stateDir = path.join(base, STATE_DIR);
  return {
    root: base, dir, inputs: path.join(dir, 'inputs'), work: path.join(dir, 'work'), out: path.join(dir, 'out'),
    stateDir, state: path.join(stateDir, `${jobId}.json`), lock: path.join(stateDir, `${jobId}.lock`), jobId,
  };
}

function requireRealFolder(dir, parentReal, expectedName) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new CodebuiltError('BAD_JOB', `${dir} must be a real folder`);
  const real = fs.realpathSync(dir);
  if (!inside(parentReal, real) || fold(path.relative(parentReal, real)) !== fold(expectedName)) {
    throw new CodebuiltError('BAD_JOB', `${dir} resolves outside its expected place`);
  }
  return real;
}

/** Creates the job folders; a link or junction in place of any of them is refused. Rejects case-only id collisions. */
export function ensureJobFolder(paths) {
  fs.mkdirSync(paths.root, { recursive: true });
  const realRoot = fs.realpathSync(paths.root);
  for (const entry of fs.readdirSync(paths.root)) {
    if (entry !== paths.jobId && entry.toLowerCase() === paths.jobId.toLowerCase()) {
      throw new CodebuiltError('BAD_JOB', `job id collides with existing folder ${entry} (names differ only by case)`);
    }
  }
  fs.mkdirSync(paths.stateDir, { recursive: true });
  requireRealFolder(paths.stateDir, realRoot, STATE_DIR);
  fs.mkdirSync(paths.dir, { recursive: true });
  const realDir = requireRealFolder(paths.dir, realRoot, paths.jobId);
  for (const sub of ['inputs', 'work', 'out']) {
    fs.mkdirSync(paths[sub], { recursive: true });
    requireRealFolder(paths[sub], realDir, sub);
  }
}

/** Reads a path input: absolute, a regular file, not a link, resolving inside one of the allowed read roots. */
function readInputFile(file, inputRoots, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new CodebuiltError('BAD_JOB', `${label} must be an absolute path`);
  let stat; let real;
  try { stat = fs.lstatSync(file); real = fs.realpathSync(file); } catch { throw new CodebuiltError('BAD_JOB', `${label} does not exist`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new CodebuiltError('BAD_JOB', `${label} must be a regular file, not a link`);
  const allowed = inputRoots.some((root) => { try { return inside(fs.realpathSync(root), real); } catch { return false; } });
  if (!allowed) throw new CodebuiltError('BAD_JOB', `${label} is not under a configured input root`);
  return fs.readFileSync(real);
}

function toBuffer(value, label, inputRoots) {
  if (typeof value === 'string') return readInputFile(value, inputRoots, label);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  throw new CodebuiltError('BAD_JOB', `${label} must be an object or an absolute path to a file under an input root`);
}

/** Copies the inputs in once and marks them read-only. Returns {name: sha256}. An identical existing copy is kept. */
export function writeInputs(paths, { script, voWav, words, pathPack, brief, overlaySpec }, inputRoots = []) {
  if (typeof script !== 'string' || !script.trim()) throw new CodebuiltError('BAD_JOB', 'script text is required');
  if (typeof brief !== 'string' || !brief.trim()) throw new CodebuiltError('BAD_JOB', 'brief text is required');
  const data = {
    'script.txt': Buffer.from(script), 'vo.wav': readInputFile(voWav, inputRoots, 'vo.wav'), 'words.json': toBuffer(words, 'words.json', inputRoots),
    'pathpack.json': toBuffer(pathPack, 'path pack', inputRoots), 'brief.md': Buffer.from(brief),
  };
  // codex ? gpt-6.1-sol ? 2026-11-17 13:53 +02:00: overlay uses the identical write-once input/hash path.
  if (overlaySpec !== undefined) {
    const raw = toBuffer(overlaySpec, 'overlay.json', inputRoots);
    const timing = JSON.parse(data['words.json'].toString('utf8'));
    if (!Number.isFinite(timing?.dur) || timing.dur <= 0 || !Number.isFinite(frameCountFor(timing))) {
      throw new CodebuiltError('BAD_JOB', 'overlay words.json dur must be a finite positive number');
    }
    parseOverlaySpec(raw.toString('utf8'), {videoSeconds: frameCountFor(timing) / FPS});
    data['overlay.json'] = raw;
  } else if (fs.lstatSync(path.join(paths.inputs,'overlay.json'), {throwIfNoEntry:false})) {
    throw new CodebuiltError('INPUT_CHANGED','unexpected overlay.json in a legacy job');
  }
  const hashes = {};
  for (const name of Object.keys(data)) {
    const target = path.join(paths.inputs, name);
    hashes[name] = crypto.createHash('sha256').update(data[name]).digest('hex');
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      if (hashRegularFile(target) !== hashes[name]) throw new CodebuiltError('INPUT_CHANGED', `${name} differs from the copy already in this job`, { name });
      continue;
    }
    fs.writeFileSync(target, data[name], { flag: 'wx' });
    fs.chmodSync(target, 0o444); // advisory only: the hash check is the protection
  }
  return hashes;
}

export const BUILD_SCRIPT = 'build/build.py';
const MAX_BUILD_SCRIPT_BYTES = 512 * 1024;

/**
 * The planner's build script (generated code) for the offline executor: <job>/build/build.py, written once by the host
 * before the container starts. Returns its SHA-256. An identical existing copy is kept; a different one is refused. The
 * hash is checked again after the run (verifyBuildScript): the script that ran must be the script the draft keeps.
 */
export function writeBuildScript(paths, text) {
  if (typeof text !== 'string' || !text.trim()) throw new CodebuiltError('BAD_JOB', 'buildScript text is required for a generated-code job');
  const data = Buffer.from(text);
  if (data.length > MAX_BUILD_SCRIPT_BYTES) throw new CodebuiltError('BAD_JOB', `buildScript is larger than ${MAX_BUILD_SCRIPT_BYTES} bytes`);
  const realDir = fs.realpathSync(paths.dir);
  const dir = path.join(paths.dir, 'build');
  fs.mkdirSync(dir, { recursive: true });
  requireRealFolder(dir, realDir, 'build');
  const target = path.join(dir, 'build.py');
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    if (hashRegularFile(target) !== hash) throw new CodebuiltError('INPUT_CHANGED', 'build/build.py differs from the copy already in this job', { name: BUILD_SCRIPT });
    return hash;
  }
  fs.writeFileSync(target, data, { flag: 'wx' });
  fs.chmodSync(target, 0o444); // advisory only: the hash check is the protection
  return hash;
}

/** Throws INPUT_CHANGED when the build script was modified, replaced, linked or removed during the run. */
export function verifyBuildScript(paths, hash) {
  if (hashRegularFile(path.join(paths.dir, 'build', 'build.py')) !== (hash ?? undefined)) {
    throw new CodebuiltError('INPUT_CHANGED', 'build/build.py was changed during the run', { name: BUILD_SCRIPT });
  }
}

/** Throws INPUT_CHANGED when any input copy was modified, replaced, linked or removed. */
export function verifyInputs(paths, hashes) {
  if (!hashes?.['overlay.json'] && fs.lstatSync(path.join(paths.inputs,'overlay.json'), {throwIfNoEntry:false})) throw new CodebuiltError('INPUT_CHANGED','unexpected overlay.json');
  if (hashRegularFile(path.join(paths.inputs, 'pathpack.json')) !== hashes?.['pathpack.json']) throw new CodebuiltError('INPUT_CHANGED', 'input pathpack.json was changed during the run');
  for (const name of [...INPUT_FILES, ...(hashes?.['overlay.json'] ? ['overlay.json'] : [])]) {
    if (hashRegularFile(path.join(paths.inputs, name)) !== (hashes?.[name] ?? undefined)) {
      throw new CodebuiltError('INPUT_CHANGED', `input ${name} was changed during the run`, { name });
    }
  }
}

// ---- preview mode (visual loop, KAN-934) -------------------------------------------------------------------------------
// A preview job renders a few small frames of the same build.py into <job>/preview. The host writes <job>/work/preview.json
// first (the kit reads it, see blender_worker/codebuilt/renderloop.py); after the container is gone the host collects only
// the exact frame files it asked for.
export const PREVIEW_SPEC = 'work/preview.json';
export const PREVIEW_CONTAINER_DIR = '/job/preview';
export const PREVIEW_MAX_FRAMES = 24;
export const PREVIEW_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const PREVIEW_SCALE_RANGE = Object.freeze([50, 50]);
/** The final render profile a preview scale is applied to: 1080x1920 (hold=1). At scale 50 a preview frame is 540x960. */
export const PREVIEW_FINAL_SIZES = Object.freeze([[1080, 1920]]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const previewDir = (paths) => path.join(paths.dir, 'preview');
const frameName = (frame) => `${String(frame).padStart(4, '0')}.png`;

export const previewSizes = (scale) => PREVIEW_FINAL_SIZES.map(([w, h]) => [Math.round((w * scale) / 100), Math.round((h * scale) / 100)]);

/** Throws BAD_JOB unless frames are 1..24 strictly increasing even integers >= 0 and scale is exactly 50. */
export function checkPreviewRequest(frames, scale) {
  const isInt = (n) => Number.isInteger(n);
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > PREVIEW_MAX_FRAMES) throw new CodebuiltError('BAD_JOB', `previewFrames must be a list of 1..${PREVIEW_MAX_FRAMES} frames`);
  if (!frames.every((f) => isInt(f) && f >= 0 && f % 2 === 0)) throw new CodebuiltError('BAD_JOB', 'previewFrames must be even integers >= 0');
  if (frames.some((f, i) => i > 0 && f <= frames[i - 1])) throw new CodebuiltError('BAD_JOB', 'previewFrames must be strictly increasing');
  if (!isInt(scale) || scale < PREVIEW_SCALE_RANGE[0] || scale > PREVIEW_SCALE_RANGE[1]) throw new CodebuiltError('BAD_JOB', `previewScale must be an integer ${PREVIEW_SCALE_RANGE[0]}..${PREVIEW_SCALE_RANGE[1]}`);
}

/** Writes <job>/work/preview.json once (read-only, advisory) and returns its SHA-256. An identical copy is kept; a different one is refused. */
export function writePreviewSpec(paths, { previewFrames, previewScale }) {
  checkPreviewRequest(previewFrames, previewScale);
  const data = Buffer.from(`${JSON.stringify({ version: 1, frames: previewFrames, scale: previewScale, out: PREVIEW_CONTAINER_DIR })}\n`);
  const realDir = fs.realpathSync(paths.dir);
  requireRealFolder(paths.work, realDir, 'work');
  const target = path.join(paths.dir, PREVIEW_SPEC);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    if (hashRegularFile(target) !== hash) throw new CodebuiltError('INPUT_CHANGED', 'work/preview.json differs from the copy already in this job', { name: PREVIEW_SPEC });
    return hash;
  }
  fs.writeFileSync(target, data, { flag: 'wx' });
  fs.chmodSync(target, 0o444);
  return hash;
}

/** Throws INPUT_CHANGED when the preview spec was modified, replaced, linked or removed during the run. */
export function verifyPreviewSpec(paths, hash) {
  if (hashRegularFile(path.join(paths.dir, PREVIEW_SPEC)) !== (hash ?? undefined)) {
    throw new CodebuiltError('INPUT_CHANGED', 'work/preview.json was changed during the run', { name: PREVIEW_SPEC });
  }
}

function confinedPreview(paths) {
  const realRoot = fs.realpathSync(paths.root);
  const realDir = requireRealFolder(paths.dir, realRoot, paths.jobId);
  try { return requireRealFolder(previewDir(paths), realDir, 'preview'); } catch (error) {
    throw new CodebuiltError('CONTAINED_VIOLATION', 'preview/ is not a real folder inside the job folder', { cause: error?.message });
  }
}

/** Unlinks the files in preview/ (no recursive delete) so a rerun starts clean. A subfolder or link is refused. */
export function clearPreview(paths) {
  if (!fs.lstatSync(previewDir(paths), { throwIfNoEntry: false })) return;
  confinedPreview(paths);
  for (const entry of fs.readdirSync(previewDir(paths))) {
    const target = path.join(previewDir(paths), entry);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodebuiltError('CONTAINED_VIOLATION', `unexpected non-file ${entry} in preview/`, { entry });
    fs.unlinkSync(target);
  }
}

/**
 * The preview frames the executor left, proven to be exactly the requested ones: names NNNN.png, regular, unlinked
 * single-name files, 1 byte to 4 MB, a PNG signature and an IHDR whose size is the same for every frame and equals the
 * scale applied to a known final size. Returns { dir, frames: [{name, sha256, bytes, w, h}] }; throws otherwise.
 */
export function collectPreview(paths, frames, scale) {
  checkPreviewRequest(frames, scale);
  if (!fs.lstatSync(previewDir(paths), { throwIfNoEntry: false })) throw new CodebuiltError('MISSING_OUTPUT', 'the executor left no preview/ folder', { missing: ['preview'], preview: true });
  const realPreview = confinedPreview(paths);
  const wanted = new Map(frames.map((f) => [frameName(f), f]));
  const present = fs.readdirSync(previewDir(paths));
  for (const entry of present) {
    const stat = fs.lstatSync(path.join(previewDir(paths), entry));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CodebuiltError('CONTAINED_VIOLATION', `unexpected non-file ${entry} in preview/`, { entry });
    if (!wanted.has(entry)) throw new CodebuiltError('CONTAINED_VIOLATION', `unexpected file ${entry} in preview/`, { entry });
  }
  const missing = [...wanted.keys()].filter((n) => !present.includes(n));
  if (missing.length) throw new CodebuiltError('MISSING_OUTPUT', `missing preview frames: ${missing.join(', ')}`, { missing, preview: true });
  const allowed = previewSizes(scale);
  const out = [];
  for (const name of wanted.keys()) {
    const file = path.join(previewDir(paths), name);
    const bad = (why) => new CodebuiltError('MISSING_OUTPUT', `preview frame ${name} is invalid: ${why}`, { missing: [name], preview: true });
    const stat = fs.lstatSync(file);
    if (stat.nlink !== 1) throw bad('a hard link');
    if (stat.size < 33 || stat.size > PREVIEW_MAX_FRAME_BYTES) throw bad('size');
    if (!inside(realPreview, fs.realpathSync(file))) throw bad('outside the folder');
    const bytes = fs.readFileSync(file);
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') throw bad('not a PNG');
    const w = bytes.readUInt32BE(16); const h = bytes.readUInt32BE(20);
    if (!allowed.some(([aw, ah]) => aw === w && ah === h)) throw bad(`size ${w}x${h}`);
    out.push({ name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, w, h });
  }
  if (out.some((f) => f.w !== out[0].w || f.h !== out[0].h)) throw new CodebuiltError('MISSING_OUTPUT', 'preview frames have different sizes', { missing: [], preview: true });
  return { dir: previewDir(paths), frames: out };
}

/** The collected preview when the recorded hashes still match, else null (resume of a completed preview job). */
export function previewMatches(paths, frames, scale, recorded) {
  try {
    const found = collectPreview(paths, frames, scale);
    return found.frames.length === recorded?.length && found.frames.every((f, i) => recorded[i]?.name === f.name && recorded[i]?.sha256 === f.sha256) ? found : null;
  } catch { return null; }
}

/** The real out/ folder, proven to be exactly <real job dir>/out inside the real root. */
function confinedOut(paths) {
  const realRoot = fs.realpathSync(paths.root);
  const realDir = requireRealFolder(paths.dir, realRoot, paths.jobId);
  try { return requireRealFolder(paths.out, realDir, 'out'); } catch (error) {
    throw new CodebuiltError('CONTAINED_VIOLATION', 'out/ is not a real folder inside the job folder', { cause: error?.message });
  }
}

/** Unlinks the files in out/ (no recursive delete) so a restart starts clean. A subfolder or link is refused. */
export function clearOutputs(paths) {
  confinedOut(paths);
  for (const entry of fs.readdirSync(paths.out)) {
    const target = path.join(paths.out, entry);
    if (!fs.lstatSync(target).isFile()) throw new CodebuiltError('CONTAINED_VIOLATION', `unexpected non-file ${entry} in out/`, { entry });
    fs.unlinkSync(target);
  }
}

/** codex · gpt-6.1-sol · 2026-11-18: discard stale post deliverables, retaining the post kit's audio scratch directory. */
export function clearPostOutputs(paths) {
  confinedOut(paths);
  for (const name of Object.values(OUTPUT_FILES)) {
    const target = path.join(paths.out, name);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CodebuiltError('CONTAINED_VIOLATION', `invalid post output ${name}`);
    fs.unlinkSync(target);
  }
}

/** Absolute, confined, non-empty, unlinked output files: {files, hashes, report}. Throws otherwise. */
export function collectOutputs(paths) {
  const realOut = confinedOut(paths);
  const files = {}; const hashes = {}; const missing = [];
  for (const [key, name] of Object.entries(OUTPUT_FILES)) {
    const target = path.join(paths.out, name);
    let ok = false;
    try {
      const stat = fs.lstatSync(target);
      ok = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && inside(realOut, fs.realpathSync(target));
    } catch { /* missing */ }
    if (!ok) { missing.push(name); continue; }
    files[key] = target; hashes[name] = hashRegularFile(target);
  }
  if (missing.length) throw new CodebuiltError('MISSING_OUTPUT', `missing or invalid outputs: ${missing.join(', ')}`, { missing });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(files.report, 'utf8')); } catch { /* handled below */ }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new CodebuiltError('MISSING_OUTPUT', 'report.json is not a JSON object', { missing: [OUTPUT_FILES.report] });
  return { files, hashes, report };
}

/** Only an explicit report status of "ok" is accepted (stopped_early is typed by the caller before this check). */
export function assertReportOk(report) {
  if (report.status !== 'ok') {
    throw new CodebuiltError('MISSING_OUTPUT', `report.json status must be "ok", got ${JSON.stringify(report.status ?? null)}`, { missing: [OUTPUT_FILES.report] });
  }
}

/** The collected outputs when the recorded hashes still match, else null (resume of a completed job). */
export function outputsMatch(paths, hashes) {
  try {
    const found = collectOutputs(paths);
    assertReportOk(found.report);
    return Object.entries(found.hashes).every(([name, hash]) => hashes?.[name] === hash) ? found : null;
  } catch { return null; }
}

// ---- post-only resume (a post layout refusal; the frames are kept) -----------------------------------------------------
/**
 * The identity of the executor's frames: {count, sha256} over every frames/*.png (name, size, content hash). null when frames/ is
 * not a real folder inside the job, holds no PNG, or holds a link, hard link or folder named like one. Called only with the fence gone.
 */
export function framesDigest(paths) {
  try {
    const dir = path.join(paths.dir, 'frames');
    requireRealFolder(dir, fs.realpathSync(paths.dir), 'frames');
    const names = fs.readdirSync(dir).filter((name) => /\.png$/i.test(name)).sort();
    if (!names.length) return null;
    const all = crypto.createHash('sha256');
    for (const name of names) {
      const file = path.join(dir, name);
      const digest = hashRegularFile(file);
      if (!digest) return null;
      all.update(`${name}\t${fs.lstatSync(file).size}\t${digest}\n`);
    }
    return { count: names.length, sha256: all.digest('hex') };
  } catch { return null; }
}

/**
 * Replaces the host-written inputs/overlay.json with a corrected spec that passes the same strict parser as the first write.
 * `videoSeconds` is frames / fps of the kept frames. Returns {sha256, previous}: previous is the replaced bytes so a failed post-only
 * attempt can put them back (restoreOverlayInput). A spec equal to the one it replaces is refused: it cannot change the outcome.
 */
export function replaceOverlayInput(paths, overlaySpec, videoSeconds) {
  if (!overlaySpec || typeof overlaySpec !== 'object' || Array.isArray(overlaySpec)) throw new CodebuiltError('BAD_JOB', 'the corrected overlay must be an object');
  const parsed = parseOverlaySpec(JSON.stringify(overlaySpec), { videoSeconds });
  const next = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
  const target = path.join(paths.inputs, 'overlay.json');
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new CodebuiltError('INPUT_CHANGED', 'input overlay.json is not a regular file', { name: 'overlay.json' });
  const previous = fs.readFileSync(target);
  const sha256 = crypto.createHash('sha256').update(next).digest('hex');
  if (previous.equals(next)) throw new CodebuiltError('BAD_JOB', 'the corrected overlay equals the refused overlay');
  writeOverlayBytes(target, next);
  return { sha256, previous };
}

function writeOverlayBytes(target, bytes) {
  fs.chmodSync(target, 0o666); // the read-only mark is advisory (see the top of this file); the hash check is the protection
  fs.unlinkSync(target);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  fs.chmodSync(target, 0o444);
}

/** Puts back the overlay bytes replaceOverlayInput returned. */
export function restoreOverlayInput(paths, previous) {
  writeOverlayBytes(path.join(paths.inputs, 'overlay.json'), previous);
}
