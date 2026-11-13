// KAN-826: the only way the finish step reaches the disk.
//  - Inputs come from the Episode folder by a relative path with an extension allow-list, a size cap, and real-path containment:
//    the real path of the file must be exactly where the relative path says, so no symlink or junction (in the file or any parent) can redirect it.
//  - The step writes only to <episode>/final and <episode>/tmp-finish, and only when those are plain folders (never a link).
import fs from 'node:fs';
import path from 'node:path';
import { FinishError } from './limits.js';

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const OWNED = Object.freeze(['final', 'tmp-finish']);
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function realEpisode(episodeDir) {
  let real;
  try { real = fs.realpathSync(episodeDir); } catch { throw new FinishError('the Episode folder cannot be resolved'); }
  return real;
}

export function resolveEpisodeFile(episodeDir, rel, { exts, maxBytes, label = 'file' } = {}) {
  if (typeof rel !== 'string' || !rel || rel.length > 300) throw new FinishError(`${label}: the path must be a non-empty relative string`);
  const segments = rel.split('/');
  for (const seg of segments) {
    if (!SEGMENT.test(seg) || seg.endsWith('.') || RESERVED.test(seg)) throw new FinishError(`${label}: the path is not an allowed relative path inside the Episode`);
  }
  const ext = path.extname(rel).toLowerCase();
  if (!Array.isArray(exts) || !exts.includes(ext)) throw new FinishError(`${label}: the file type is not allowed`);
  const root = realEpisode(episodeDir);
  const expected = path.join(root, ...segments);
  let stat; let real;
  try {
    stat = fs.lstatSync(expected);
    real = fs.realpathSync(expected);
  } catch { throw new FinishError(`${label}: the file is missing`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new FinishError(`${label}: not a plain file`);
  if (!sameName(real, expected)) throw new FinishError(`${label}: the path leaves the Episode folder`);
  if (stat.size > maxBytes) throw new FinishError(`${label}: the file is too large`);
  if (stat.size === 0) throw new FinishError(`${label}: the file is empty`);
  return real;
}

// <episode>/final or <episode>/tmp-finish as a real folder; created when absent, refused when it is a link or a file.
export function ensureOwnedDir(episodeDir, name) {
  if (!OWNED.includes(name)) throw new FinishError('the finish step may only write to final and tmp-finish');
  const root = realEpisode(episodeDir);
  const target = path.join(root, name);
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { /* absent */ }
  if (!stat) fs.mkdirSync(target);
  stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameName(fs.realpathSync(target), target)) throw new FinishError(`the ${name} folder is not a plain folder inside the Episode`);
  return target;
}
