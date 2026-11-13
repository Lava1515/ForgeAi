import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJobArtifactHandlers } from '../routes/jobArtifacts.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artifact-'));
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
