// KAN-824: the Episode folder: ids, containment, artifact names and atomic writes.
// Everything that touches the disk for an Episode goes through here so the safety rules live in one place:
//  - ids are a closed alphabet (no dot, no separator, no reserved Windows device name),
//  - the folder must be a real direct child of the episodes root (a symlink or junction is refused, never followed),
//  - artifact names are a fixed list (an engine can never choose a path),
//  - writes are temp file + rename, so a crash or a full disk leaves the previous file whole.
// This server is single-process and EPISODE_ROOT is trusted local disk; lstat-to-write TOCTOU races are outside this boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
export const STATE_FILE = 'state.json';
export const ARTIFACT_NAMES = Object.freeze(['plan.json', 'brief.json', 'sources.json', 'spec.json', 'look.json', 'animatic.json', 'shots.json', 'finish.json', 'draft.json']);
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
export const MAX_STATE_BYTES = 64 * 1024;

const MESSAGES = Object.freeze({
  invalid_id: 'Invalid episode id', bad_request: 'Invalid request', not_found: 'Not found', conflict: 'Request conflicts with the Episode state',
  invalid_state: 'Episode state is invalid', too_large: 'Request too large', bad_artifact: 'Invalid artifact', internal: 'Episode request failed',
});
const STATUS = Object.freeze({ invalid_id: 400, bad_request: 400, not_found: 404, conflict: 409, invalid_state: 422, too_large: 413, bad_artifact: 500, internal: 500 });

// The message is always the generic text for the code: no path, no state and no stack ever rides on an EpisodeError.
export class EpisodeError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.internal);
    this.name = 'EpisodeError';
    this.code = MESSAGES[code] ? code : 'internal';
    this.status = STATUS[this.code];
  }
}

export function episodeRoot() {
  return path.resolve(process.env.EPISODE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output/episodes'));
}

export function validEpisodeId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) && !id.includes('..') && !RESERVED.test(id);
}
function requireId(id) { if (!validEpisodeId(id)) throw new EpisodeError('invalid_id'); }

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function realRoot(root, fsApi) {
  try { return fsApi.realpathSync(root); } catch { throw new EpisodeError('not_found'); }
}

// An existing Episode folder, as a real path. Anything that is not a plain directory directly under the root is "not found".
export function resolveEpisodeDir(root, id, fsApi = fs) {
  requireId(id);
  const rootReal = realRoot(root, fsApi);
  const candidate = path.join(rootReal, id);
  let real;
  try {
    if (!fsApi.lstatSync(candidate).isDirectory()) throw new Error('not a directory'); // false for a symlink or a junction
    real = fsApi.realpathSync(candidate);
  } catch { throw new EpisodeError('not_found'); }
  if (!sameName(path.dirname(real), rootReal) || !sameName(path.basename(real), id)) throw new EpisodeError('not_found');
  return real;
}

// Make a new Episode folder. An existing name (folder, file, link) is a conflict; nothing is overwritten.
export function createEpisodeDir(root, id, fsApi = fs) {
  requireId(id);
  fsApi.mkdirSync(root, { recursive: true });
  const rootReal = realRoot(root, fsApi);
  try { fsApi.mkdirSync(path.join(rootReal, id)); }
  catch (error) { throw new EpisodeError(error && error.code === 'EEXIST' ? 'conflict' : 'internal'); }
  return resolveEpisodeDir(root, id, fsApi);
}

export function removeEmptyEpisodeDir(root, id, fsApi = fs) {
  try { fsApi.rmdirSync(resolveEpisodeDir(root, id, fsApi)); } catch { /* best effort: only ever removes an empty folder */ }
}

// Ids of real Episode folders (a plain directory with a state.json). Never creates the root.
export function listEpisodeIds(root, fsApi = fs) {
  let entries;
  try { entries = fsApi.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !validEpisodeId(entry.name)) continue;
    try { if (fsApi.lstatSync(path.join(root, entry.name, STATE_FILE)).isFile()) ids.push(entry.name); } catch { /* no state.json: not an Episode */ }
  }
  return ids.sort();
}

export function atomicWrite(folder, filename, content, fsApi = fs) {
  const target = path.join(folder, filename);
  const temp = path.join(folder, `.${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try { fsApi.writeFileSync(temp, content, { flag: 'wx' }); fsApi.renameSync(temp, target); }
  catch (error) { try { fsApi.unlinkSync(temp); } catch { /* temp may not exist */ } throw error; }
}

function checkedName(name, allowState) {
  if (!ARTIFACT_NAMES.includes(name) && !(allowState && name === STATE_FILE)) throw new EpisodeError('bad_artifact');
}

export function writeArtifact(dir, name, content, fsApi = fs) {
  checkedName(name, false);
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) throw new EpisodeError('too_large');
  atomicWrite(dir, name, content, fsApi);
}

export function writeStateFile(dir, content, fsApi = fs) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_STATE_BYTES) throw new EpisodeError('too_large');
  atomicWrite(dir, STATE_FILE, content, fsApi);
}

// Text of an artifact (or state.json), or null when it is absent or not a plain file (a symlink is never followed). Oversize throws too_large.
export function readArtifact(dir, name, fsApi = fs) {
  checkedName(name, true);
  const file = path.join(dir, name);
  let stat;
  try { stat = fsApi.lstatSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > (name === STATE_FILE ? MAX_STATE_BYTES : MAX_ARTIFACT_BYTES)) throw new EpisodeError('too_large');
  try { return fsApi.readFileSync(file, 'utf8'); } catch { return null; }
}
