import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { jobsRoot } from '../episode/codebuilt/draftAdapter.js';
import { assertRealDir, findLinks, samePath } from '../episode/codebuilt/jobPaths.js';
import { scanReparsePoints } from '../episode/codebuilt/reparse.js';
import { buildCostRecord, normalizeJobCalls, scrubCost } from '../perf/creationCost.js';
import { redactLogText } from './redact.js';
import { MAX_LOOKS, MAX_CRASH_FIXES } from '../episode/codebuilt/visualLoop.js';

const specs = {
  script: ['stage', 'script.txt'], shots: ['stage', 'shots.json'],
  finalReport: ['job', 'final/report.json'], finalVideo: ['job', 'final/video.mp4'], finalSheet: ['job', 'final/contact_sheet.jpg'],
  stageCost: ['stage', 'cost_calls.json'], cost: ['job', 'cost_calls.json'], report: ['job', 'out/report.json'],
  video: ['job', 'out/video.mp4'], contactSheet: ['job', 'out/contact_sheet.png'],
};
for (let round = 1; round <= MAX_LOOKS + MAX_CRASH_FIXES; round += 1) {
  specs[`round${round}`] = ['stage', `loop/r${round - 1}/look.json`];
  for (let sheet = 1; sheet <= 9; sheet += 1) specs[`round${round}sheet${sheet}`] = ['stage', `loop/r${round - 1}/sheets/sheet_${sheet}.jpg`];
}
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const TERMINAL = new Set(['done', 'failed', 'aborted']);
const LIST_BUDGET = 4 * 1024 * 1024;
const mime = (rel) => rel.endsWith('.mp4') ? 'video/mp4' : rel.endsWith('.png') ? 'image/png' : rel.endsWith('.jpg') ? 'image/jpeg' : rel.endsWith('.json') ? 'application/json' : 'text/plain';

function safeSnapshot(root, id, scanner) {
  if (!JOB_ID.test(id) || id.includes('..') || RESERVED.test(id)) return null;
  try {
    const realRoot = assertRealDir(path.resolve(root), 'job root');
    assertRealDir(path.join(realRoot, '.start'), 'job state root');
    const stage = path.join(realRoot, '.start', id);
    const job = path.join(realRoot, id);
    // A terminal dashboard record alone cannot prove a runner is gone (including a quarantined/orphaned container).
    const lockDir = path.join(realRoot, '.cb6-locks');
    let jobExists = false;
    try { assertRealDir(job, 'job output'); jobExists = true; } catch (error) { if (error?.code !== 'ENOENT') return null; }
    try {
      const lockDirReal = assertRealDir(lockDir, 'job lock folder');
      if (fs.readdirSync(lockDirReal).some((name) => name === `${id}.lock` || (name.startsWith(`${id}-pv`) && /^\d+\.lock$/.test(name.slice(id.length + 3))))) return null;
    } catch (error) { if (error?.code !== 'ENOENT' || jobExists) return null; }
    for (const dir of [stage, job]) {
      try { assertRealDir(dir, 'artifact tree'); } catch (error) { if (dir === job && error?.code === 'ENOENT') continue; return null; }
      // Scan only this job's trees before opening even its status marker. An unrelated
      // job's links or entry count must not block this one. No cross-request caching.
      const tree = findLinks(dir, { reparseScan: (target) => {
        const result = scanner(target);
        if (!result || result.complete !== true) throw new Error('incomplete reparse scan');
        return result;
      } });
      if (!tree.complete || tree.truncated || tree.errors?.length || tree.links?.length) return null;
    }
    const statusFile = path.join(stage, 'status.json');
    const statusSt = fs.lstatSync(statusFile);
    if (!statusSt.isFile() || statusSt.isSymbolicLink() || statusSt.nlink !== 1 || statusSt.size > 1024 * 1024) return null;
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (status.id !== id || !TERMINAL.has(status.status)) return null;
    return { root: realRoot, stage, job };
  } catch { return null; }
}

function readChecked(snapshot, key, budget, keepMediaFd = false) {
  if (!Object.hasOwn(specs, key)) return { status: 'unavailable' };
  const [area, rel] = specs[key];
  const base = area === 'stage' ? snapshot.stage : snapshot.job;
  const parts = rel.split('/');
  let current = base;
  let fd;
  try {
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const dirStat = fs.lstatSync(current);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { status: 'unavailable' };
    }
    const file = path.join(current, parts.at(-1));
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !samePath(file, fs.realpathSync.native(file))) return { status: 'unavailable' };
    const type = mime(rel);
    const media = /^(?:image|video)\//.test(type);
    const cap = media ? 512 * 1024 * 1024 : 2 * 1024 * 1024;
    if (!before.size || before.size > cap) return { status: 'unavailable' };
    // Open now and verify the opened inode against the checked directory entry. The descriptor pins the object across
    // the response; sendFile(path) would reopen later and permit a replace-between-check-and-open race.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== before.dev || after.ino !== before.ino) {
      fs.closeSync(fd); return { status: 'unavailable' };
    }
    if (media) {
      if (keepMediaFd) return { status: 'available', fd, type, size: opened.size };
      fs.closeSync(fd); fd = undefined;
      return { status: 'available', type, size: opened.size };
    }
    if (opened.size > budget.remaining) { fs.closeSync(fd); return { status: 'unavailable' }; }
    budget.remaining -= opened.size;
    const raw = fs.readFileSync(fd, 'utf8');
    fs.closeSync(fd); fd = undefined;
    if (type === 'application/json') {
      const data = scrubCost(JSON.parse(raw));
      return { status: 'available', ...(key === 'cost' || key === 'stageCost' ? { internalCost: data } : { text: JSON.stringify(data, null, 2) }), type };
    }
    return { status: 'available', text: redactLogText(raw), type };
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    return { status: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unavailable' };
  }
}

const unavailable = () => Object.fromEntries(Object.keys(specs).filter((key) => key !== 'stageCost').map((key) => [key, { status: 'unavailable' }]));

export function createJobArtifactHandlers({ root = jobsRoot(), reparseScan = scanReparsePoints } = {}) {
  const list = (req, res) => {
    const id = String(req.params.jobId ?? '');
    const snapshot = safeSnapshot(root, id, reparseScan);
    const artifacts = snapshot ? {} : unavailable();
    if (snapshot) {
      const budget = { remaining: LIST_BUDGET };
      for (const key of Object.keys(specs).filter((name) => name !== 'stageCost')) {
        artifacts[key] = readChecked(snapshot, key, budget);
        if (artifacts[key].status === 'available' && /^(?:image|video)\//.test(artifacts[key].type)) {
          artifacts[key].url = `/api/codebuilt/jobs/${encodeURIComponent(id)}/artifacts/${key}`;
        }
      }
      if (artifacts.cost?.status === 'missing') artifacts.cost = readChecked(snapshot, 'stageCost', budget);
      if (artifacts.cost?.status === 'available') {
        const calls = artifacts.cost.internalCost;
        delete artifacts.cost.internalCost;
        artifacts.cost.text = JSON.stringify(calls, null, 2);
        artifacts.cost.summary = buildCostRecord({ calls: normalizeJobCalls(calls) }).summary;
      }
    }
    res.set('Cache-Control', 'no-store').json({ artifacts });
  };
  const file = (req, res) => {
    const id = String(req.params.jobId ?? '');
    const key = String(req.params.key ?? '');
    const snapshot = safeSnapshot(root, id, reparseScan);
    if (!snapshot) return res.status(404).json({ error: 'Artifact unavailable' });
    const result = readChecked(snapshot, key, { remaining: Infinity }, true);
    if (result.status !== 'available' || result.fd === undefined) return res.status(404).json({ error: 'Artifact unavailable' });
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': result.type, 'Content-Length': String(result.size) });
    // pipeline destroys the source on response close/error, including a browser
    // cancelling a video request, so the pinned descriptor is always released.
    return pipeline(createReadStream(null, { fd: result.fd, autoClose: true }), res, () => {});
  };
  return { list, file };
}

export function mountJobArtifacts(app, options) {
  const handlers = createJobArtifactHandlers(options);
  app.get('/api/codebuilt/jobs/:jobId/artifacts', handlers.list);
  app.get('/api/codebuilt/jobs/:jobId/artifacts/:key', handlers.file);
}
