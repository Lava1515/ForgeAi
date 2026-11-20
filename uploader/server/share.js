// The hand-over folder (a NAS share later, a local folder at first). Other machines may be able to write to it, so:
//   - a package counts only when ForgeAi signed its manifest (a key that never lies on the share);
//   - the uploader copies an accepted video into its OWN folder and uploads from that copy, never from the share;
//   - nothing on the share is deleted recursively: only the three known files, then the empty folder.
//
//   <share>/inbox/<package_id>/            video.mp4, manifest.json, READY   (ForgeAi writes; READY last)
//   <share>/claimed/<package_id>.<owner>/  a package one uploader has taken (rename: the first one wins)
//   <share>/results/<package_id>.json      what happened, signed (ForgeAi reads)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { isSafeId, manifestError } from './rules.js';

export const MAX_MANIFEST_BYTES = 200 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const LOCK_STALE_MS = 3 * 60 * 1000;
const PACKAGE_FILES = ['video.mp4', 'manifest.json', 'READY'];

// ---- the hand-over key and signatures (the same few lines live in dashboard/server/routes/uploader.js) ----
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));
export function sign(key, purpose, obj) {
  const { mac: _mac, ...rest } = obj;
  return crypto.createHmac('sha256', key).update(`${purpose}\n${canonical(rest)}`).digest('hex');
}
export function verified(key, purpose, obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.mac !== 'string' || !/^[0-9a-f]{64}$/.test(obj.mac)) return false;
  return crypto.timingSafeEqual(Buffer.from(obj.mac, 'hex'), Buffer.from(sign(key, purpose, obj), 'hex'));
}
/** UPLOADER_KEY, or the key file (made on first use). Both programs must see the same key; it is never written to the share. */
export function handoverKey(repoRoot, env = process.env) {
  if (env.UPLOADER_KEY) { if (env.UPLOADER_KEY.length < 32) throw new Error('UPLOADER_KEY must be 32 characters or more'); return env.UPLOADER_KEY; }
  const file = path.resolve(env.UPLOADER_KEY_FILE || path.join(repoRoot, 'data/uploader/handover.key'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (key.length < 32) throw new Error(`The hand-over key file is damaged: ${file}`);
  return key;
}

// ---- the folders ----
export function shareDirs(share) {
  const dir = (name) => path.join(share, name);
  return { root: share, inbox: dir('inbox'), claimed: dir('claimed'), results: dir('results'), lock: dir('uploader.lock') };
}

// A plain file or folder, never a link: a link on the share could point us at any file on this machine.
function plain(p, kind) {
  let st;
  try { st = fs.lstatSync(p); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  return (kind === 'dir' ? st.isDirectory() : st.isFile()) ? st : null;
}
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Creates the folders and makes sure each one really sits inside the share. Throws when the share is away or was tampered with. */
export function ensureShare(share) {
  const dirs = shareDirs(share);
  fs.mkdirSync(share, { recursive: true });
  const root = fs.realpathSync(share);
  for (const name of ['inbox', 'claimed', 'results']) {
    fs.mkdirSync(dirs[name], { recursive: true });
    if (!plain(dirs[name], 'dir') || !same(fs.realpathSync(dirs[name]), path.join(root, name))) throw new Error(`"${name}" in the hand-over folder is a link, not a folder`);
  }
  return dirs;
}

/** Atomic write inside a folder we own (the state folder). */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null, maxBytes = 50 * 1024 * 1024) {
  try { if (fs.statSync(file).size > maxBytes) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The signed answer ForgeAi reads. Throws when the share is away; the engine tries again on a later pass. */
export function writeResult(dirs, key, pkg) {
  if (!isSafeId(pkg.id)) return;
  const body = JSON.parse(JSON.stringify({
    package_id: pkg.id, submission_id: pkg.submission_id || null, sha256: pkg.sha256 || null, state: pkg.state, reason: pkg.error || null, video_id: pkg.video_id || null,
    publish_at: pkg.publish_at || null, public_at: pkg.public_at || null, youtube_channel_id: pkg.youtube_channel_id || null, updated_at: new Date().toISOString(),
  }));
  body.mac = sign(key, 'result', body);
  const file = path.join(dirs.results, `${pkg.id}.json`);
  const tmp = path.join(dirs.results, `.${pkg.id}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: 'utf8', flag: 'wx' }); // a new, unguessable name: never writes through a planted link
  if (fs.existsSync(file) && !plain(file, 'file')) { fs.rmSync(tmp, { force: true }); throw new Error('the result file is a link'); }
  fs.renameSync(tmp, file);
}

/** Removes a package folder on the share: the three known plain files, then the folder if it is empty. Never recursive. */
export function removePackageDir(folder) {
  if (!plain(folder, 'dir')) return;
  for (const name of PACKAGE_FILES) { if (plain(path.join(folder, name), 'file')) { try { fs.unlinkSync(path.join(folder, name)); } catch { /* next pass */ } } }
  try { fs.rmdirSync(folder); } catch { /* not empty or busy: left where it is */ }
}

const onlyPackageFiles = (folder) => {
  try { return fs.readdirSync(folder).every((name) => PACKAGE_FILES.includes(name) && plain(path.join(folder, name), 'file')); } catch { return false; }
};

/**
 * Takes every finished, signed package out of the inbox into the uploader's own folder (`localDir`).
 * `packages` is the state's package map (mutated); `save()` writes the state and is called before a share copy is removed,
 * so a crash at any point leaves either the claimed folder or the saved state, never neither.
 * -> [{ id, state, reason }] for the log.
 */
export async function intake(dirs, { packages, key, owner, localDir, consumed = {}, save = () => {}, now = () => new Date().toISOString() }) {
  const events = [];
  // 1. Claim: rename inbox/<id> to claimed/<id>.<owner>. On one file system the rename is atomic, so two uploaders cannot both take it.
  let names = [];
  try { names = fs.readdirSync(dirs.inbox); } catch { /* the claims below are still worked through */ }
  for (const id of names) {
    const folder = path.join(dirs.inbox, id);
    if (!isSafeId(id) || !plain(folder, 'dir') || !plain(path.join(folder, 'READY'), 'file')) continue;
    if (!onlyPackageFiles(folder)) { events.push({ id, state: 'ignored', reason: 'the folder holds something other than video.mp4, manifest.json and READY; left untouched' }); continue; }
    try { fs.renameSync(folder, path.join(dirs.claimed, `${id}.${owner}`)); } catch { /* another uploader took it, or it is still being written */ }
  }
  // 2. Work through what this uploader has claimed (also what a crash left behind).
  let claimed = [];
  try { claimed = fs.readdirSync(dirs.claimed).filter((n) => n.endsWith(`.${owner}`)); } catch { return events; }
  for (const name of claimed) {
    const id = name.slice(0, -(owner.length + 1));
    const folder = path.join(dirs.claimed, name);
    if (!isSafeId(id) || !plain(folder, 'dir') || !onlyPackageFiles(folder)) continue;
    // One package that cannot be read must not stop the others, or the uploads that follow intake.
    try { await takeOne(id, folder); } catch (err) { events.push({ id, state: 'ignored', reason: `could not be read (${err.code || String(err.message).slice(0, 80)}); tried again on the next pass` }); }
  }
  return events;

  async function takeOne(id, folder) {
    const prior = packages[id];
    // The same package sent again changes nothing, unless the earlier one ended without a video on YouTube.
    if (prior && !['refused', 'removed'].includes(prior.state)) { removePackageDir(folder); events.push({ id, state: prior.state, reason: 'sent again; the first one stands' }); return; }
    const mst = plain(path.join(folder, 'manifest.json'), 'file');
    const manifest = mst && mst.size <= MAX_MANIFEST_BYTES ? readJson(path.join(folder, 'manifest.json')) : null;
    // Not signed by ForgeAi: not ours to act on. No result is written, so a stranger cannot overwrite a real answer either.
    if (!verified(key, 'manifest', manifest) || manifest.package_id !== id) { removePackageDir(folder); events.push({ id, state: 'ignored', reason: 'not signed by ForgeAi; removed from the inbox' }); return; }
    // A signed package is good for one intake. A copy of it put back later (after the owner removed it, say) is not a new send.
    if (consumed[manifest.submission_id]) { removePackageDir(folder); events.push({ id, state: 'ignored', reason: 'this send was already taken once; removed from the inbox' }); return; }
    // The state must be on disk before the share copy goes. If the save fails, the change is taken back and the claim
    // stays where it is, so the next pass starts this package again from the beginning.
    const commit = (pkg, clean = () => {}) => {
      const before = packages[id]; const had = consumed[manifest.submission_id];
      packages[id] = pkg;
      if (isSafeId(manifest.submission_id)) consumed[manifest.submission_id] = now();
      try { save(); } catch (err) {
        if (before) packages[id] = before; else delete packages[id];
        if (had) consumed[manifest.submission_id] = had; else delete consumed[manifest.submission_id];
        clean();
        throw err;
      }
    };
    const refuse = (reason) => {
      commit({ id, state: 'refused', error: reason, received_at: now(), ended_at: now(), sha256: manifest.sha256, submission_id: isSafeId(manifest.submission_id) ? manifest.submission_id : null, title: String(manifest.title || '').slice(0, 100), youtube_channel_id: manifest.youtube_channel_id, result_due: true });
      fs.rmSync(path.join(localDir, id), { recursive: true, force: true });
      removePackageDir(folder);
      events.push({ id, state: 'refused', reason });
    };
    const knownHashes = new Set(Object.values(packages).filter((p) => p.id !== id && p.sha256 && !['refused', 'removed'].includes(p.state)).map((p) => p.sha256));
    const bad = manifestError(manifest, { folderId: id, knownHashes });
    if (bad) { refuse(bad); return; }
    const vst = plain(path.join(folder, 'video.mp4'), 'file');
    if (!vst || vst.size === 0 || vst.size > MAX_VIDEO_BYTES) { refuse('video.mp4 is missing, empty or larger than 512 MB'); return; }
    // Copy first, then check the copy: what was checked is exactly what will be uploaded.
    const local = path.join(localDir, id);
    fs.rmSync(local, { recursive: true, force: true });
    fs.mkdirSync(local, { recursive: true });
    fs.copyFileSync(path.join(folder, 'video.mp4'), path.join(local, 'video.mp4'));
    const bytes = fs.statSync(path.join(local, 'video.mp4')).size;
    if (bytes > MAX_VIDEO_BYTES || await sha256File(path.join(local, 'video.mp4')) !== manifest.sha256) { refuse('the video file does not match the sha256 in the manifest (copy damaged?)'); return; }
    writeJsonAtomic(path.join(local, 'manifest.json'), manifest);
    const order = Math.max(0, ...Object.values(packages).map((p) => p.order ?? 0)) + 1;
    commit({ id, state: 'queued', order, received_at: now(), sha256: manifest.sha256, submission_id: manifest.submission_id, youtube_channel_id: manifest.youtube_channel_id,
      title: manifest.title, video_type: typeof manifest.video_type === 'string' ? manifest.video_type.slice(0, 40) : null, bytes, result_due: true }, () => fs.rmSync(local, { recursive: true, force: true }));
    removePackageDir(folder);
    events.push({ id, state: 'queued', reason: null });
  }
}

/** The uploader's own verified copy of a package: { manifest, videoFile } or null. */
export function localPackage(localDir, id) {
  if (!isSafeId(id)) return null;
  const videoFile = path.join(localDir, id, 'video.mp4');
  const manifest = readJson(path.join(localDir, id, 'manifest.json'), null, MAX_MANIFEST_BYTES * 2);
  return manifest && plain(videoFile, 'file') ? { manifest, videoFile } : null;
}
export function deleteLocal(localDir, id) {
  if (isSafeId(id)) fs.rmSync(path.join(localDir, id), { recursive: true, force: true });
}

/** A stable name for this uploader, kept in its state folder. */
export function ownerId(stateDir) {
  const file = path.join(stateDir, 'owner-id');
  try { fs.writeFileSync(file, `${os.hostname().replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'host'}-${crypto.randomBytes(4).toString('hex')}`, { flag: 'wx' }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  return fs.readFileSync(file, 'utf8').trim();
}

/**
 * One uploader per share. The lock file is created exclusively; a lock whose owner has not written for 3 minutes is taken over.
 * -> null when this uploader holds the lock, or why it must not work now. Called at the start of a pass and before every upload.
 */
export function claimShare(dirs, owner, nowMs = Date.now()) {
  const mine = () => JSON.stringify({ owner, beat: new Date(nowMs).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(dirs.lock, mine(), { flag: 'wx' }); return null; } catch (err) { if (err.code !== 'EEXIST') throw err; }
    if (!plain(dirs.lock, 'file')) return 'the lock in the hand-over folder is not a plain file';
    const lock = readJson(dirs.lock, null, 4096);
    if (lock?.owner === owner) { fs.writeFileSync(dirs.lock, mine()); return null; }
    if (lock && nowMs - Date.parse(lock.beat || 0) < LOCK_STALE_MS) return `another uploader (${String(lock.owner).slice(0, 60)}) is using this folder`;
    try { fs.unlinkSync(dirs.lock); } catch { /* someone else was faster: the next try decides */ }
  }
  return 'another uploader took the hand-over folder';
}
export function releaseShare(dirs, owner) {
  if (readJson(dirs.lock, null, 4096)?.owner === owner) fs.rmSync(dirs.lock, { force: true });
}
