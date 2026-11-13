import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobArtifactHandlers } from '../routes/jobArtifacts.js';

function fixture() {
  const scratch = path.resolve('../../output/temp'); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'forge-artifact-'));
  const stage = path.join(root, '.start', 'job1');
  const job = path.join(root, 'job1');
  fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(job, { recursive: true }); fs.mkdirSync(path.join(root, '.cb6-locks'));
  fs.writeFileSync(path.join(stage, 'status.json'), JSON.stringify({ id: 'job1', status: 'done' }));
  fs.writeFileSync(path.join(stage, 'script.txt'), 'safe script');
  fs.writeFileSync(path.join(stage, 'cost_calls.json'), JSON.stringify({ calls: [{ step: 'script', provider: 'test', model: 'm', wall_s: 2 }] }));
  return { root, stage, job, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function invoke(handler, params) {
  let body;
  const res = {
    headers: {}, statusCode: 200,
    set(value) { Object.assign(this.headers, value); return this; },
    json(value) { body = value; return this; },
    status(code) { this.statusCode = code; return this; },
  };
  handler({ params }, res);
  return { body, res };
}

test('artifact listing is terminal gated, bounded, and cost fallback exposes no duplicate raw data', () => {
  const f = fixture();
  try {
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: () => ({ complete: true, points: [], errors: [] }) });
    const { body } = invoke(handlers.list, { jobId: 'job1' });
    assert.equal(body.artifacts.script.text, 'safe script');
    assert.equal(body.artifacts.cost.status, 'available');
    assert.match(body.artifacts.cost.text, /"calls"/);
    assert.ok(body.artifacts.cost.summary);
    assert.equal('data' in body.artifacts.cost, false);
    assert.equal('internalCost' in body.artifacts.cost, false);
    fs.writeFileSync(path.join(f.stage, 'status.json'), JSON.stringify({ id: 'job1', status: 'running' }));
    const active = invoke(handlers.list, { jobId: 'job1' }).body.artifacts;
    assert.equal(active.script.status, 'unavailable');
  } finally { f.cleanup(); }
});

test('media listing closes descriptors and supplies URLs for actual loop artifacts', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.job, 'out'));
  fs.writeFileSync(path.join(f.job, 'out', 'video.mp4'), 'fixture video');
  const round = path.join(f.stage, 'loop', 'r0'); fs.mkdirSync(path.join(round, 'sheets'), { recursive: true });
  fs.writeFileSync(path.join(round, 'look.json'), JSON.stringify({ status: 'complete' }));
  fs.writeFileSync(path.join(round, 'sheets', 'sheet_1.jpg'), 'fixture image');
  const open = fs.openSync; const close = fs.closeSync; const held = new Set();
  fs.openSync = (...args) => { const fd = open(...args); held.add(fd); return fd; };
  fs.closeSync = (fd) => { held.delete(fd); return close(fd); };
  try {
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: () => ({ complete: true, points: [], errors: [] }) });
    const artifacts = invoke(handlers.list, { jobId: 'job1' }).body.artifacts;
    assert.equal(held.size, 0, 'list must release every opened file');
    assert.equal(artifacts.video.fd, undefined);
    assert.equal(artifacts.video.url, '/api/codebuilt/jobs/job1/artifacts/video');
    assert.equal(artifacts.round1.status, 'available');
    assert.equal(artifacts.round1sheet1.url, '/api/codebuilt/jobs/job1/artifacts/round1sheet1');
  } finally {
    fs.openSync = open; fs.closeSync = close;
    for (const fd of held) close(fd);
    f.cleanup();
  }
});

test('artifact scans are confined to this job and preview locks block access', () => {
  const f = fixture(); const scanned = [];
  try {
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: (dir) => {
      scanned.push(dir);
      return { complete: true, points: dir === f.root ? [path.join(dir, 'unrelated-job', 'link')] : [], errors: [] };
    } });
    assert.equal(invoke(handlers.list, { jobId: 'job1' }).body.artifacts.script.status, 'available');
    assert.deepEqual(new Set(scanned), new Set([f.stage, f.job]));
    fs.writeFileSync(path.join(f.root, '.cb6-locks', 'job1-pv2.lock'), 'quarantined');
    scanned.length = 0;
    assert.equal(invoke(handlers.list, { jobId: 'job1' }).body.artifacts.script.status, 'unavailable');
    assert.equal(scanned.length, 0, 'lock refusal precedes artifact scans');
  } finally { f.cleanup(); }
});

test('injected WSL/container reparse point makes the complete artifact request fail closed', () => {
  const f = fixture();
  try {
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: (dir) => ({ complete: true, points: [path.join(dir, '.start', 'job1', 'status.json')], errors: [] }) });
    const result = invoke(handlers.list, { jobId: 'job1' }).body.artifacts;
    assert.equal(result.script.status, 'unavailable');
    assert.equal(result.cost.status, 'unavailable');
  } finally { f.cleanup(); }
});

test('hard-linked artifacts are refused even when the tree scan found no links', () => {
  const f = fixture();
  const other = path.join(f.root, 'outside.txt');
  try {
    fs.writeFileSync(other, 'sensitive'); fs.unlinkSync(path.join(f.stage, 'script.txt')); fs.linkSync(other, path.join(f.stage, 'script.txt'));
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: () => ({ complete: true, points: [], errors: [] }) });
    assert.equal(invoke(handlers.list, { jobId: 'job1' }).body.artifacts.script.status, 'unavailable');
  } finally { f.cleanup(); }
});

test('missing job parent keeps staged cost available as the cost fallback', () => {
  const f = fixture();
  try {
    fs.rmdirSync(f.job);
    const handlers = createJobArtifactHandlers({ root: f.root, reparseScan: () => ({ complete: true, points: [], errors: [] }) });
    const artifacts = invoke(handlers.list, { jobId: 'job1' }).body.artifacts;
    assert.equal(artifacts.cost.status, 'available');
    assert.ok(artifacts.cost.summary);
  } finally { f.cleanup(); }
});
