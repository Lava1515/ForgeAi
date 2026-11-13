// KAN-907: conservative Episode frame cleanup and a non-blocking disk check.
import fs from 'node:fs';
import path from 'node:path';
import { episodeRoot, validEpisodeId } from './artifacts.js';
import { validateState } from './stateMachine.js';

const FRAME_DIR = /^frames_[a-f0-9]{8}$/;
const FRAME_FILE = /^frame_\d+\.(?:png|jpe?g|exr)$/i;
const SHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const inside = (base, target) => {
  const rel = path.relative(base, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function validatedEpisode(episodeDir, root) {
  if (typeof episodeDir !== 'string' || !episodeDir) throw new Error('Invalid Episode folder');
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(episodeDir);
  const id = path.basename(candidate);
  if (!validEpisodeId(id) || id.includes('..')) throw new Error('Invalid Episode id');
  const parent = path.dirname(candidate);
  if (!samePath(fs.realpathSync(parent), rootReal)) throw new Error('Episode folder is outside EPISODE_ROOT');
  const info = fs.lstatSync(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Episode folder must be a real directory');
  const real = fs.realpathSync(candidate);
  if (!samePath(real, candidate) || !samePath(path.dirname(real), rootReal)) throw new Error('Episode folder is outside EPISODE_ROOT');
  return { id, dir: real };
}

function approvedCompleteState(dir, id) {
  try {
    const file = path.join(dir, 'state.json');
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return false;
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateState(state, id);
    return state.stages.draft.status === 'complete'
      && state.stages.finish.status === 'complete'
      && state.gates.animatic.status === 'approved';
  } catch { return false; }
}

function findFrameTargets(dir) {
  const targets = [];
  const shots = path.join(dir, 'shots');
  let shotsStat; let shotsReal;
  try { shotsStat = fs.lstatSync(shots); shotsReal = fs.realpathSync(shots); } catch { return targets; }
  if (!shotsStat.isDirectory() || shotsStat.isSymbolicLink() || !inside(dir, shotsReal) || !samePath(shotsReal, shots)) return targets;
  let shotEntries;
  try { shotEntries = fs.readdirSync(shots, { withFileTypes: true }); } catch { return targets; }
  for (const shot of shotEntries) {
    if (!SHOT_ID.test(shot.name) || !shot.isDirectory()) continue;
    const shotDir = path.join(shots, shot.name);
    const shotStat = fs.lstatSync(shotDir);
    if (!shotStat.isDirectory() || shotStat.isSymbolicLink() || !samePath(fs.realpathSync(shotDir), shotDir)) continue;
    for (const frameFolder of fs.readdirSync(shotDir, { withFileTypes: true })) {
      if (!FRAME_DIR.test(frameFolder.name) || !frameFolder.isDirectory()) continue;
      const folder = path.join(shotDir, frameFolder.name);
      const folderStat = fs.lstatSync(folder);
      if (!folderStat.isDirectory() || folderStat.isSymbolicLink() || !inside(dir, folder) || !samePath(fs.realpathSync(folder), folder)) continue;
      const files = fs.readdirSync(folder, { withFileTypes: true });
      const frameFiles = files.filter((entry) => FRAME_FILE.test(entry.name));
      for (const entry of frameFiles) {
        const target = path.join(folder, entry.name);
        const stat = fs.lstatSync(target);
        if ((!stat.isFile() && !stat.isSymbolicLink()) || !inside(dir, target)) continue;
        let real;
        try { real = fs.realpathSync(target); } catch { continue; }
        // A symlink is never traversed or removed when its referent escapes the Episode.
        if (!inside(dir, real)) continue;
        targets.push({ path: target, bytes: stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0, link: stat.isSymbolicLink() });
      }
    }
  }
  return targets;
}

export function deleteApprovedFrames({ episodeDir, episodesRoot = episodeRoot(), apply = false } = {}) {
  const episode = validatedEpisode(episodeDir, episodesRoot);
  if (!approvedCompleteState(episode.dir, episode.id)) return { eligible: false, dryRun: !apply, files: [], bytes: 0, freedBytes: 0 };
  const targets = findFrameTargets(episode.dir);
  const bytes = targets.reduce((total, target) => total + target.bytes, 0);
  if (apply) {
    for (const target of targets) {
      const current = fs.lstatSync(target.path);
      const real = fs.realpathSync(target.path);
      if (!inside(episode.dir, target.path) || !inside(episode.dir, real)) continue;
      if (target.link && current.isSymbolicLink()) fs.unlinkSync(target.path);
      else if (!target.link && current.isFile() && !current.isSymbolicLink()) fs.unlinkSync(target.path);
    }
    // Remove only empty, real frames_* folders. Non-frame entries keep the folder intact.
    for (const target of targets) {
      const folder = path.dirname(target.path);
      try {
        const stat = fs.lstatSync(folder);
        if (stat.isDirectory() && !stat.isSymbolicLink() && inside(episode.dir, fs.realpathSync(folder)) && fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
      } catch { /* already gone or not empty */ }
    }
  }
  return { eligible: true, dryRun: !apply, files: targets.map(({ path: file }) => file), bytes, freedBytes: apply ? bytes : 0 };
}

export async function checkDisk({ path: target, minFreeGB = 20, statfs = (value) => fs.promises.statfs(value) } = {}) {
  const minGB = Number.isFinite(minFreeGB) && minFreeGB >= 0 ? minFreeGB : 20;
  try {
    if (typeof target !== 'string' || !target) throw new Error('path required');
    const info = await statfs(target);
    const freeGB = (Number(info.bavail) * Number(info.bsize)) / (1024 ** 3);
    if (!Number.isFinite(freeGB) || freeGB < 0) throw new Error('invalid statfs result');
    const drive = path.parse(path.resolve(target)).root || 'the current drive';
    if (freeGB < minGB) return { ok: false, freeGB, minGB, message: `Low disk: ${freeGB.toFixed(1)} GB free on ${drive}, ${minGB} GB needed` };
    return { ok: true, freeGB, minGB, message: '' };
  } catch {
    return { ok: true, freeGB: null, minGB, message: 'Disk check could not check free space; render may continue' };
  }
}
