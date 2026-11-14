// Live progress of a code-built job for the dashboard (owner, 2026-11-14: "I don't see anything in progress in the UI").
// The job list already carries the step history; this adds what only the disk knows while a job runs: how many frames of the
// final render exist, how many are planned, and the newest preview sheet the visual check looked at.
//
//   GET /api/codebuilt/jobs/:jobId/progress          -> { id, frames: { done, total } | null, plan: { shots, places } | null, sheets: [{ round, url }] }
//   GET /api/codebuilt/jobs/:jobId/progress/sheet/:n -> image/jpeg, the first preview sheet of look round n (0 based)
//
// Read-only and deliberately narrow. The frames folder belongs to the job container, so nothing in it is opened: only the names of
// its entries are counted, after checking that the job folder and the frames folder are real directories (no link or junction).
// Plan and sheets come from the host stage folder (.start/<id>), which the container cannot write. A sheet is served only when it
// is a regular, singly linked JPEG of a sane size. Unlike the artifact routes this one answers while the job is active: that is its point.
import fs from 'node:fs';
import path from 'node:path';
import { jobsRoot } from '../episode/codebuilt/draftAdapter.js';
import { assertRealDir } from '../episode/codebuilt/jobPaths.js';

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,50}$/;
const FRAME = /^\d{4}\.png$/;
const MAX_ROUNDS = 12;
const MAX_SHEET_BYTES = 3 * 1024 * 1024;
const MAX_PLAN_BYTES = 512 * 1024;
const MAX_FRAMES_LISTED = 6000;

function regularFile(file, maxBytes) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= maxBytes ? st : null;
  } catch { return null; }
}

function stageDir(root, id) {
  const realRoot = assertRealDir(path.resolve(root), 'job root');
  assertRealDir(path.join(realRoot, '.start'), 'job state root');
  return { realRoot, stage: assertRealDir(path.join(realRoot, '.start', id), 'job stage') };
}

/** Frames of the final render on disk: names only, never contents. Null when the folder is absent or not a plain directory. */
function countFrames(realRoot, id) {
  try {
    assertRealDir(path.join(realRoot, id), 'job output');
    const frames = assertRealDir(path.join(realRoot, id, 'frames'), 'frames');
    let n = 0; let seen = 0;
    const dir = fs.opendirSync(frames);
    try {
      for (let entry = dir.readSync(); entry && seen < MAX_FRAMES_LISTED; entry = dir.readSync()) { seen += 1; if (FRAME.test(entry.name)) n += 1; }
    } finally { dir.closeSync(); }
    return n;
  } catch { return null; }
}

function readPlan(stage) {
  const file = path.join(stage, 'planner-plan.json');
  if (!regularFile(file, MAX_PLAN_BYTES)) return null;
  try {
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    const total = Number.isInteger(plan?.nframes) && plan.nframes > 0 && plan.nframes < 100000 ? plan.nframes : null;
    const shots = Array.isArray(plan?.shotStarts) ? plan.shotStarts.length : null;
    const places = Array.isArray(plan?.places) ? plan.places.length : null;
    return { total, shots, places };
  } catch { return null; }
}

function sheetFile(stage, round) {
  const file = path.join(stage, 'loop', `r${round}`, 'sheets', 'sheet_1.jpg');
  return regularFile(file, MAX_SHEET_BYTES) ? file : null;
}

export function createJobProgressHandlers({ root = jobsRoot } = {}) {
  const rootOf = () => (typeof root === 'function' ? root() : root);
  const progress = (req, res) => {
    const id = String(req.params.jobId ?? '');
    if (!JOB_ID.test(id)) return res.status(404).json({ error: 'Progress unavailable' });
    let dirs;
    try { dirs = stageDir(rootOf(), id); } catch { return res.status(404).json({ error: 'Progress unavailable' }); }
    const plan = readPlan(dirs.stage);
    const done = countFrames(dirs.realRoot, id);
    const sheets = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (sheetFile(dirs.stage, round)) sheets.push({ round, url: `/api/codebuilt/jobs/${encodeURIComponent(id)}/progress/sheet/${round}` });
    }
    res.set('Cache-Control', 'no-store');
    return res.json({
      id,
      frames: done === null && !plan?.total ? null : { done: done ?? 0, total: plan?.total ?? null },
      plan: plan ? { shots: plan.shots, places: plan.places } : null,
      sheets,
    });
  };
  const sheet = (req, res) => {
    const id = String(req.params.jobId ?? '');
    const round = Number(req.params.round);
    if (!JOB_ID.test(id) || !Number.isInteger(round) || round < 0 || round >= MAX_ROUNDS) return res.status(404).json({ error: 'Sheet unavailable' });
    let file = null;
    try { file = sheetFile(stageDir(rootOf(), id).stage, round); } catch { file = null; }
    if (!file) return res.status(404).json({ error: 'Sheet unavailable' });
    let bytes;
    try { bytes = fs.readFileSync(file); } catch { return res.status(404).json({ error: 'Sheet unavailable' }); }
    if (bytes.length > MAX_SHEET_BYTES || !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return res.status(404).json({ error: 'Sheet unavailable' });
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length) });
    return res.end(bytes);
  };
  return { progress, sheet };
}

export function mountJobProgress(app, options) {
  const handlers = createJobProgressHandlers(options);
  app.get('/api/codebuilt/jobs/:jobId/progress', handlers.progress);
  app.get('/api/codebuilt/jobs/:jobId/progress/sheet/:round', handlers.sheet);
}
