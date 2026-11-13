import fs from 'node:fs';
import path from 'node:path';
import { jobsRoot } from '../episode/codebuilt/draftAdapter.js';
import { assertRealDir, samePath } from '../episode/codebuilt/jobPaths.js';
import { buildCostRecord, normalizeJobCalls, scrubCost } from '../perf/creationCost.js';
import { redactLogText } from './redact.js';

const specs = {
  script: ['stage', 'script.txt'],
  shots: ['stage', 'shots.json'],
  finalReport: ['job', 'final/report.json'],
  finalVideo: ['job', 'final/video.mp4'],
  finalSheet: ['job', 'final/contact_sheet.jpg'],
  stageCost: ['stage', 'cost_calls.json'],
  cost: ['job', 'cost_calls.json'],
  report: ['job', 'out/report.json'],
  video: ['job', 'out/video.mp4'],
  contactSheet: ['job', 'out/contact_sheet.png'],
};
for (let round = 1; round <= 3; round += 1) {
  specs[`round${round}`] = ['stage', `loop/r${round}/look.json`];
  for (let sheet = 1; sheet <= 9; sheet += 1) specs[`round${round}sheet${sheet}`] = ['stage', `loop/r${round}/sheets/sheet_${sheet}.jpg`];
}
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const mime = (rel) => rel.endsWith('.mp4') ? 'video/mp4' : rel.endsWith('.png') ? 'image/png' : rel.endsWith('.jpg') ? 'image/jpeg' : rel.endsWith('.json') ? 'application/json' : 'text/plain';

function readArtifact(root, id, key) {
  if (!Object.hasOwn(specs, key) || typeof id !== 'string' || !JOB_ID.test(id) || id.includes('..') || RESERVED.test(id)) return { status: 'unavailable' };
  const [area, rel] = specs[key];
  const parts = [...(area === 'stage' ? ['.start', id] : [id]), ...rel.split('/')];
  try {
    const realRoot = assertRealDir(path.resolve(root), 'job root');
    let current = realRoot;
    for (const part of parts.slice(0, -1)) current = assertRealDir(path.join(current, part), 'artifact directory');
    const file = path.join(current, parts.at(-1));
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(file, fs.realpathSync.native(file))) return { status: 'unavailable' };
    const type = mime(rel);
    const media = /^(?:image|video)\//.test(type);
    if (!stat.size || stat.size > (media ? 512 * 1024 * 1024 : 2 * 1024 * 1024)) return { status: 'unavailable' };
    if (media) return { status: 'available', file, type };
    const raw = fs.readFileSync(file, 'utf8');
    if (type === 'application/json') {
      const data = scrubCost(JSON.parse(raw));
      return { status: 'available', data, text: JSON.stringify(data, null, 2), type };
    }
    return { status: 'available', text: redactLogText(raw), type };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
}

function artifactEntry(root, id, key) {
  let result = readArtifact(root, id, key);
  if (key === 'cost' && result.status === 'missing') result = readArtifact(root, id, 'stageCost');
  const { file, type, ...entry } = result;
  return { ...entry, ...(file ? { media: type, url: `/api/codebuilt/jobs/${encodeURIComponent(id)}/artifacts/${key}` } : {}) };
}

export function createJobArtifactHandlers({ root = jobsRoot() } = {}) {
  const list = (req, res) => {
    const id = String(req.params.jobId ?? '');
    const artifacts = Object.fromEntries([...Object.keys(specs).filter((key) => key !== 'stageCost'), 'cost'].map((key) => [key, artifactEntry(root, id, key)]));
    if (artifacts.cost.status === 'available') {
      const calls = artifacts.cost.data;
      artifacts.cost.summary = buildCostRecord({ calls: normalizeJobCalls(calls) }).summary;
    }
    res.set('Cache-Control', 'no-store').json({ artifacts });
  };
  const file = (req, res) => {
    const result = readArtifact(root, String(req.params.jobId ?? ''), String(req.params.key ?? ''));
    if (result.status !== 'available' || !result.file) return res.status(404).json({ error: 'Artifact unavailable' });
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': result.type });
    return res.send(fs.readFileSync(result.file));
  };
  return { list, file };
}

export function mountJobArtifacts(app, options) {
  const handlers = createJobArtifactHandlers(options);
  app.get('/api/codebuilt/jobs/:jobId/artifacts', handlers.list);
  app.get('/api/codebuilt/jobs/:jobId/artifacts/:key', handlers.file);
}
