// The hand-over folder (a NAS share later, a local folder at first) and the uploader's own state file.
//   <share>/inbox/<package_id>/   video.mp4, manifest.json, READY   (ForgeAi writes; READY last)
//   <share>/taken/<package_id>/   accepted: the uploader owns it
//   <share>/refused/<package_id>/ refused: kept 7 days so the owner can look
//   <share>/results/<package_id>.json   what happened (ForgeAi reads)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { isSafeId, manifestError } from './rules.js';

export const MAX_MANIFEST_BYTES = 200 * 1024;
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const LOCK_STALE_MS = 3 * 60 * 1000;

export function shareDirs(share) {
  const dir = (name) => path.join(share, name);
  return { root: share, inbox: dir('inbox'), taken: dir('taken'), refused: dir('refused'), results: dir('results'), lock: dir('uploader.lock') };
}

/** Creates the folders. Throws when the share cannot be reached (not mounted, no rights). */
export function ensureShare(share) {
  const dirs = shareDirs(share);
  for (const d of [dirs.inbox, dirs.taken, dirs.refused, dirs.results]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// A plain file or folder, never a link: a link in the share could point the uploader at any file on the machine.
function plain(p, kind) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

export function writeResult(dirs, pkg) {
  const { id, state, error = null, video_id = null, publish_at = null, public_at = null, youtube_channel_id = null, title = null } = pkg;
  writeJsonAtomic(path.join(dirs.results, `${id}.json`), {
    package_id: id, state, reason: error, video_id, url: video_id ? `https://www.youtube.com/shorts/${video_id}` : null,
    publish_at, public_at, youtube_channel_id, title, updated_at: new Date().toISOString(),
  });
}

function moveDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
}

/**
 * Takes every finished package out of the inbox. `packages` is the state's package map (mutated).
 * Accepted -> taken/, state 'queued'. Refused -> refused/, state 'refused'. A folder without READY is left alone.
 * -> [{ id, state, reason }] for the log.
 */
export async function intake(dirs, packages, now = () => new Date().toISOString()) {
  const events = [];
  let names = [];
  try { names = fs.readdirSync(dirs.inbox); } catch { return events; }
  for (const id of names) {
    const folder = path.join(dirs.inbox, id);
    if (!isSafeId(id) || !plain(folder, 'dir') || !plain(path.join(folder, 'READY'), 'file')) continue;
    const prior = packages[id];
    // The same package sent again changes nothing, unless the earlier one ended without a video on YouTube.
    if (prior && !['refused', 'removed'].includes(prior.state)) {
      fs.rmSync(folder, { recursive: true, force: true });
      events.push({ id, state: prior.state, reason: 'sent again; the first one stands' });
      continue;
    }
    const refuse = (reason, manifest) => {
      moveDir(folder, path.join(dirs.refused, id));
      packages[id] = { id, state: 'refused', error: reason, received_at: now(), title: typeof manifest?.title === 'string' ? manifest.title.slice(0, 100) : null,
        youtube_channel_id: typeof manifest?.youtube_channel_id === 'string' ? manifest.youtube_channel_id.slice(0, 40) : null };
      writeResult(dirs, packages[id]);
      events.push({ id, state: 'refused', reason });
    };
    const manifestFile = path.join(folder, 'manifest.json');
    const videoFile = path.join(folder, 'video.mp4');
    const mst = plain(manifestFile, 'file');
    const vst = plain(videoFile, 'file');
    if (!mst || mst.size > MAX_MANIFEST_BYTES) { refuse('manifest.json is missing or too large'); continue; }
    const manifest = readJson(manifestFile);
    if (!vst || vst.size === 0 || vst.size > MAX_VIDEO_BYTES) { refuse('video.mp4 is missing, empty or too large', manifest); continue; }
    const knownHashes = new Set(Object.values(packages).filter((p) => p.id !== id && p.sha256 && !['refused', 'removed'].includes(p.state)).map((p) => p.sha256));
    const bad = manifestError(manifest, { folderId: id, knownHashes });
    if (bad) { refuse(bad, manifest); continue; }
    if (await sha256File(videoFile) !== manifest.sha256) { refuse('the video file does not match the sha256 in the manifest (copy damaged?)', manifest); continue; }
    moveDir(folder, path.join(dirs.taken, id));
    const order = Math.max(0, ...Object.values(packages).map((p) => p.order ?? 0)) + 1;
    packages[id] = {
      id, state: 'queued', order, received_at: now(), sha256: manifest.sha256, youtube_channel_id: manifest.youtube_channel_id,
      title: manifest.title, video_type: typeof manifest.video_type === 'string' ? manifest.video_type.slice(0, 40) : null, bytes: vst.size,
    };
    writeResult(dirs, packages[id]);
    events.push({ id, state: 'queued', reason: null });
  }
  return events;
}

/** The accepted manifest and video path of a package, read again from taken/ at upload time. */
export function takenPackage(dirs, id) {
  if (!isSafeId(id)) return null;
  const folder = path.join(dirs.taken, id);
  const videoFile = path.join(folder, 'video.mp4');
  if (!plain(folder, 'dir') || !plain(videoFile, 'file')) return null;
  const manifest = readJson(path.join(folder, 'manifest.json'));
  return manifest ? { manifest, videoFile } : null;
}

/** Deletes the uploader's copy of a package (taken/ or refused/). Only ever a plain-named folder inside the share. */
export function deleteCopy(dirs, id) {
  if (!isSafeId(id)) return;
  for (const base of [dirs.taken, dirs.refused]) fs.rmSync(path.join(base, id), { recursive: true, force: true });
}

/** One uploader per share: a second one would publish every video twice. -> null, or why this one must not start. */
export function claimShare(dirs, nowMs = Date.now()) {
  const me = `${os.hostname()}:${process.pid}`;
  const lock = readJson(dirs.lock);
  if (lock && lock.owner !== me && nowMs - Date.parse(lock.beat || 0) < LOCK_STALE_MS) return `another uploader (${lock.owner}) is using this folder`;
  writeJsonAtomic(dirs.lock, { owner: me, beat: new Date(nowMs).toISOString() });
  return null;
}
export function releaseShare(dirs) {
  const lock = readJson(dirs.lock);
  if (lock?.owner === `${os.hostname()}:${process.pid}`) fs.rmSync(dirs.lock, { force: true });
}
