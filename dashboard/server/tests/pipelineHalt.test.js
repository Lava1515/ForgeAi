// claude-pro · claude-fable-5-2 · 2026-11-20: the sidebar's Pause and Kill Switch did nothing to a code-built video (owner 13:04).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pipelineHalt } from '../routes/control.js';
import { stopAllCodebuilt } from '../routes/codebuiltRuns.js';
import { createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';
import { createVideoResearch } from '../routes/videoResearch.js';

const tick = () => new Promise((r) => setImmediate(r));
async function until(predicate) { for (let i = 0; i < 4000; i += 1) { if (predicate()) return; await tick(); } assert.fail('condition did not become true'); }
function scratch(t) {
  const parent = 'C:/code/ForgeAi/output/temp'; fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'pipeline-halt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function coordinatorRig(t, halt) {
  const channel = { id: 'channel', video_types: ['factual'] }; const started = []; const aborted = [];
  const coordinator = createCodebuiltRunCoordinator({
    runsDir: scratch(t), getChannel: () => channel, getChannels: () => [channel], pollMs: 1, halt,
    resolveAuto: () => ({ body: { seconds: 30 }, resolved: {} }),
    starter: {
      start(input) { const id = `halt-job-${started.length + 1}`; started.push(id); return { id, step: 'queued' }; },
      get(id) { return { id, status: 'done', step: 'done', duration: 30 }; },
      abort(id) { aborted.push(id); },
    },
  });
  return { coordinator, started, aborted };
}

test('pipelineHalt reads pause and the Kill Switch, and an unreadable state never blocks', () => {
  assert.equal(pipelineHalt({ status: 'running', kill_switch_active: false }), null);
  assert.equal(pipelineHalt({ status: 'paused' }), 'pipeline_paused');
  assert.equal(pipelineHalt({ status: 'stopped' }), 'pipeline_halted');
  assert.equal(pipelineHalt({ status: 'running', kill_switch_active: true }), 'pipeline_halted');
  assert.equal(pipelineHalt(null), null);
});

test('a paused or halted pipeline refuses a new batch', (t) => {
  for (const code of ['pipeline_paused', 'pipeline_halted']) {
    const { coordinator, started } = coordinatorRig(t, () => code);
    assert.throws(() => coordinator.startRun({ count: 1, topic: 'A bridge', type: 'factual', voice: 'aiden' }), { code, status: 409 });
    assert.equal(started.length, 0);
  }
});

test('Pause holds the next video until Start; the Kill Switch ends the batch before it', async (t) => {
  // The first reading is startRun's own check (the batch is allowed in); the later ones are the loop's, before each video.
  {
    let state = 'pipeline_paused', reads = 0;
    const { coordinator, started } = coordinatorRig(t, () => (reads++ === 0 ? null : state));
    const run = coordinator.startRun({ count: 1, topic: 'A bridge', type: 'factual', voice: 'aiden' });
    for (let i = 0; i < 200; i += 1) await tick();
    assert.equal(started.length, 0, 'no video starts while paused');
    state = null;
    await coordinator.idle();
    assert.equal(started.length, 1);
    assert.equal(coordinator.getRun(run.id).status, 'done');
  }
  {
    let reads = 0;
    const { coordinator, started } = coordinatorRig(t, () => (reads++ === 0 ? null : 'pipeline_halted'));
    const run = coordinator.startRun({ count: 1, topic: 'A bridge', type: 'factual', voice: 'aiden' });
    await coordinator.idle();
    assert.equal(started.length, 0);
    const result = coordinator.getRun(run.id);
    assert.equal(result.status, 'aborted');
    assert.equal(result.videos[0].status, 'aborted');
  }
});

test('stopAllCodebuilt aborts only what is active and survives a refusal', () => {
  const calls = [];
  const stopped = stopAllCodebuilt({
    coordinator: { listRuns: () => [{ id: 'run-live', status: 'running' }, { id: 'run-old', status: 'done' }, { id: 'run-stale', status: 'running' }],
      abortRun(id) { if (id === 'run-stale') throw new Error('not live'); calls.push(id); } },
    starter: { list: () => [{ id: 'job-a', status: 'building' }, { id: 'job-b', status: 'done' }, { id: 'job-c', status: 'failed' }], abort(id) { calls.push(id); } },
  });
  assert.deepEqual(calls, ['run-live', 'job-a']);
  assert.deepEqual(stopped, { runs: 1, jobs: 1 });
});

test('the Research form creates a teardown as a teardown', async () => {
  const starts = [];
  const flow = createVideoResearch({
    channels: () => [{ id: 'channel-a', name: 'Channel A' }], youtube: async () => [],
    ask: async () => ({ _agy: true, candidates: [{ topic: 'How a stealth jet hides', why: 'parts', sources: [{ url: 'https://example.test/jet', title: 'Source' }] }] }),
    start: (input) => { starts.push(input); return { id: 'run-a' }; },
  });
  const result = await flow.research({ channelId: 'channel-a', type: 'teardown', query: 'jet' });
  flow.create({ researchId: result.id, auto: true, duration: 45 });
  assert.equal(starts[0].type, 'teardown');
});
