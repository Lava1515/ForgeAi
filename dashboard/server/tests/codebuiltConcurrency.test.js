import { authorOptions, authorPlanner, renderPack } from './helpers/authored.js';
// codex · gpt-6.1-sol · 2026-11-16 08:56 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';
import { AutoTopicError } from '../episode/codebuilt/autoTopic.js';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
async function until(predicate) {
  for (let i = 0; i < 2000; i += 1) { if (predicate()) return; await tick(); }
  assert.fail('condition did not become true');
}
function scratch(t) {
  const parent = 'C:/code/ForgeAi/output/temp';
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'q1-concurrency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function rig(root, hooks = {}) {
  let seq = 0;
  const events = [];
  const starter = createCodebuiltStarter({
    jobsDir: root, episodesRoot: path.join(root, 'episodes'), newId: () => `q1-${++seq}`,
    planner: authorPlanner(async input => { events.push(['plan', input.topic, input.duration]); await hooks.plan?.(input); }),
    authorLoop: authorOptions(root, {visual: async input => { events.push(['visual', input.jobId]); await hooks.visual?.(input); }}),
    scriptStage: async (input) => {
      events.push(['script', input.topic, input.duration, input.autoDuration]);
      await hooks.script?.(input);
      return { script: `Narration for ${input.topic}`, brief: 'brief', pathPack: renderPack, ...(hooks.duration ? { duration: hooks.duration } : {}) };
    },
    factCheckStage: async () => ({ verified: true }),
    voiceStage: async (input) => {
      events.push(['voice', input.runId]);
      await hooks.voice?.(input);
      const out = { voPath: path.join(input.outDir, 'vo.wav'), wordsPath: path.join(input.outDir, 'words.json'), manifestPath: path.join(input.outDir, 'voice.json') };
      fs.writeFileSync(out.voPath, 'fixture');
      fs.writeFileSync(out.wordsPath, JSON.stringify({dur:28,words:[]}));
      fs.writeFileSync(out.manifestPath, JSON.stringify({ video_seconds: hooks.duration ?? 30 }));
      return out;
    },
    composeRunner: async () => ({ runner: { run: async (input) => {
      events.push(['render', input.jobId]);
      await hooks.render?.(input);
      fs.mkdirSync(path.join(root, input.jobId), { recursive: true });
    } } }),
    lightMetadataStage: async () => ({}),
    toDraft: (input) => { events.push(['draft', input.jobId, input.requestedDuration]); return { id: `draft-${input.jobId}` }; },
  });
  return { starter, events };
}

test('next script overlaps visual work; all GPU phases remain exclusive', async (t) => {
  const root = scratch(t); const visual = deferred(); const secondScript = deferred();
  let gpu = 0; let maximum = 0;
  const enter = () => { gpu += 1; maximum = Math.max(maximum, gpu); };
  const { starter, events } = rig(root, {
    script: async ({ topic }) => { if (topic === 'second') await secondScript.promise; },
    voice: async () => { enter(); await tick(); gpu -= 1; },
    visual: async ({ jobId }) => { enter(); if (jobId === 'q1-1') await visual.promise; gpu -= 1; },
    render: async () => { enter(); await tick(); gpu -= 1; },
  });
  const first = starter.start({ topic: 'first', duration: 30 });
  await until(() => events.some(([phase]) => phase === 'visual'));
  const second = starter.start({ topic: 'second', duration: 30 });
  const third = starter.start({ topic: 'third', duration: 30 });
  await until(() => events.some(([phase, topic]) => phase === 'script' && topic === 'second'));
  secondScript.resolve();
  await until(() => starter.get(second.id).step === 'voicing');
  assert.equal(events.filter(([phase]) => phase === 'voice').length, 1);
  assert.equal(starter.get(third.id).status, 'queued');
  assert.throws(() => starter.resume(first.id), { code: 'conflict' });
  starter.abort(third.id);
  visual.resolve();
  await starter.idle();
  assert.equal(maximum, 1);
  assert.equal(starter.get(first.id).status, 'done');
  assert.equal(starter.get(second.id).status, 'done');
  assert.equal(starter.get(third.id).status, 'aborted');
  assert.equal(events.filter(([phase, topic]) => phase === 'script' && topic === 'third').length, 0);
});

test('abort removes a GPU waiter without releasing the GPU owner, across starter instances', async (t) => {
  const root = scratch(t); const hold = deferred();
  const a = rig(path.join(root, 'a'), { visual: () => hold.promise });
  const b = rig(path.join(root, 'b'));
  const first = a.starter.start({ topic: 'owner', duration: 30 });
  await until(() => a.events.some(([phase]) => phase === 'visual'));
  const waiting = b.starter.start({ topic: 'waiter', duration: 30 });
  await until(() => b.starter.get(waiting.id).step === 'voicing');
  b.starter.abort(waiting.id);
  await b.starter.idle();
  assert.equal(b.starter.get(waiting.id).status, 'aborted');
  assert.equal(b.events.filter(([phase]) => phase === 'voice').length, 0);
  assert.equal(a.starter.get(first.id).status, 'previewing'); // injected loop has no phase callback
  hold.resolve();
  await a.starter.idle();
  assert.equal(a.starter.get(first.id).status, 'done');
});

test('quarantined render fails closed before the next voice starts', async (t) => {
  const root = scratch(t); const ready = deferred();
  const { starter, events } = rig(root, {
    script: async ({ topic }) => { if (topic === 'second') await ready.promise; },
    render: async ({ jobId }) => {
      fs.mkdirSync(path.join(root, '.cb6-locks'), { recursive: true });
      fs.writeFileSync(path.join(root, '.cb6-locks', `${jobId}.lock`), 'quarantined');
      throw new Error('cleanup uncertain');
    },
  });
  const first = starter.start({ topic: 'first', duration: 30 });
  const second = starter.start({ topic: 'second', duration: 30 });
  await until(() => starter.get(first.id).status === 'failed');
  ready.resolve(); await starter.idle();
  assert.equal(starter.get(second.id).status, 'failed');
  assert.equal(events.filter(([phase]) => phase === 'voice').length, 1);
});

test('abort keeps GPU ownership until active render cleanup finishes', async (t) => {
  const root = scratch(t); const render = deferred();
  const { starter, events } = rig(root, { render: ({ jobId }) => jobId === 'q1-1' ? render.promise : undefined });
  const first = starter.start({ topic: 'first', duration: 30 });
  await until(() => starter.get(first.id).step === 'building');
  const second = starter.start({ topic: 'second', duration: 30 });
  await until(() => starter.get(second.id).step === 'voicing');
  starter.abort(first.id); await tick();
  assert.equal(events.filter(([phase]) => phase === 'voice').length, 1);
  assert.throws(() => starter.resume(first.id), { code: 'conflict' });
  render.resolve(); await starter.idle();
  assert.equal(starter.get(first.id).status, 'aborted');
  assert.equal(starter.get(second.id).status, 'done');
});

test('ordinary voice failure releases the GPU and does not launch the same job twice', async (t) => {
  const root = scratch(t);
  const { starter, events } = rig(root, { voice: ({ runId }) => { if (runId === 'q1-1') throw new Error('voice failed'); } });
  const first = starter.start({ topic: 'first', duration: 30 });
  const second = starter.start({ topic: 'second', duration: 30 });
  await starter.idle();
  assert.equal(starter.get(first.id).status, 'failed');
  assert.equal(starter.get(second.id).status, 'done');
  for (const id of [first.id, second.id]) assert.equal(events.filter(([phase, job]) => phase === 'voice' && job === id).length, 1);
});

test('duplicate id cannot overwrite a live job or restart its pipeline', async (t) => {
  const hold = deferred(); const root = scratch(t); let compositions = 0;
  const starter = createCodebuiltStarter({ jobsDir: root, newId: () => 'same-id', planner: {}, authorLoop: authorOptions(root), composeRunner: async () => {
    compositions += 1; await hold.promise; throw new Error('unavailable');
  } });
  const first = starter.start({ topic: 'first', duration: 30 });
  assert.throws(() => starter.start({ topic: 'duplicate', duration: 30 }), { code: 'conflict' });
  starter.abort(first.id);
  assert.throws(() => starter.resume(first.id), { code: 'conflict' });
  hold.resolve(); await starter.idle();
  assert.equal(compositions, 1);
  assert.equal(starter.get(first.id).topic, 'first');
  assert.equal(starter.get(first.id).status, 'aborted');
});

function coordinatorRig(root) {
  const jobs = new Map(); const starts = []; const aborts = [];
  const channel = { id: 'channel', video_types: ['factual'] };
  const coordinator = createCodebuiltRunCoordinator({
    runsDir: root, pollMs: 1, getChannel: () => channel, getChannels: () => [channel],
    pickTopic: async ({ previousTopics }) => ({ topic: `Bridge engineering ${previousTopics.length}`, ranked: 1 }),
    starter: {
      start: (input, internal) => {
        const id = `job-${starts.length}`;
        starts.push({ input, internal });
        const job = { id, status: 'building', step: 'building', duration: 45 };
        jobs.set(id, job); return job;
      },
      get: (id) => jobs.get(id),
      abort: (id) => { aborts.push(id); Object.assign(jobs.get(id), { status: 'aborted' }); },
    },
  });
  return { coordinator, jobs, starts, aborts };
}

// codex · gpt-6.1-sol · 2026-11-19 14:24 +02:00: proof-day empty picks and fact blocks must terminate.
test('empty picks retry once, use the channel pool, and stop after two blocked topics', async (t) => {
  const starts = []; let picks = 0;
  const channel = { id: 'channel', video_types: ['factual'] };
  const coordinator = createCodebuiltRunCoordinator({
    runsDir: scratch(t), pollMs: 1, getChannel: () => channel, getChannels: () => [channel],
    autoInputs: () => ({ growth: { ideas: [{ topic: 'First bridge', rank: 1 }, { topic: 'Second bridge', rank: 2 }, { topic: 'Third bridge', rank: 3 }] } }),
    pickTopic: async () => { picks += 1; throw new AutoTopicError('theme_no_candidates'); },
    starter: {
      start: (input) => { starts.push(input.topic); return { id: `job-${starts.length}`, status: 'queued' }; },
      get: () => ({ status: 'failed', step: 'factchecking', error: { code: 'fact_check_blocked' } }),
    },
  });
  const run = coordinator.startRun({ type: 'factual', voice: 'aiden', duration: 30 });
  await coordinator.idle();
  assert.equal(picks, 2);
  assert.deepEqual(starts, ['First bridge', 'Second bridge']);
  assert.equal(coordinator.getRun(run.id).videos[0].error.code, 'fact_check_blocked');
});
// codex · gpt-6.1-sol · 2026-11-19 14:38 +02:00: review regressions for topic ownership and abort at a blocked-job handoff.
for (const scenario of ['owner', 'abort']) test(`fact-block retry respects ${scenario}`, async (t) => {
  let terminal = false; let starts = 0; let run;
  const channel = { id: 'channel', video_types: ['factual'] };
  const coordinator = createCodebuiltRunCoordinator({
    runsDir: scratch(t), pollMs: 1, getChannel: () => channel, getChannels: () => [channel],
    autoInputs: () => ({ growth: { ideas: [{ topic: 'Next bridge' }] } }),
    pickTopic: async () => ({ topic: 'Auto bridge', ranked: 1 }),
    starter: {
      start: () => ({ id: `job-${++starts}`, status: 'queued' }),
      get: () => {
        if (!terminal) return { status: 'building' };
        if (scenario === 'abort') coordinator.abortRun(run.id);
        return { status: 'failed', step: 'factchecking', error: { code: 'fact_check_blocked' } };
      },
      abort: () => {}, // The job has already failed when the abort reaches the starter.
    },
  });
  run = coordinator.startRun({ type: 'factual', voice: 'aiden', duration: 30, ...(scenario === 'owner' ? { topic: 'Owner bridge' } : {}) });
  terminal = true;
  await coordinator.idle();
  const done = coordinator.getRun(run.id);
  assert.equal(starts, 1);
  assert.equal(done.videos[0].status, scenario === 'owner' ? 'failed' : 'aborted');
  assert.equal(done.summary.running, 0);
});

test('batch lookahead is bounded; abort drains both jobs and leaves the third unstarted', async (t) => {
  const { coordinator, starts, aborts } = coordinatorRig(scratch(t));
  const run = coordinator.startRun({ count: 3, theme: 'Bridge engineering', type: 'factual', duration: 30, voice: 'aiden' });
  await until(() => starts.length === 2);
  await tick(); assert.equal(starts.length, 2);
  assert.throws(() => coordinator.startRun({ count: 1, topic: 'Another', type: 'factual' }), { code: 'run_active' });
  coordinator.abortRun(run.id); await coordinator.idle();
  assert.deepEqual(new Set(aborts), new Set(['job-0', 'job-1']));
  const done = coordinator.getRun(run.id);
  assert.equal(done.status, 'aborted');
  assert.equal(done.summary.aborted, 3);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].internal.autoDuration, false);
});
test('individual failure frees lookahead and selected Auto duration reaches the run', async (t) => {
  const { coordinator, starts, jobs } = coordinatorRig(scratch(t));
  const run = coordinator.startRun({ count: 3, theme: 'Bridge engineering', type: 'factual', voice: 'aiden' });
  await until(() => starts.length === 2);
  jobs.get('job-0').status = 'failed';
  await until(() => starts.length === 3);
  jobs.get('job-1').status = 'done'; jobs.get('job-2').status = 'done';
  await coordinator.idle();
  const done = coordinator.getRun(run.id);
  assert.equal(done.summary.failed, 1); assert.equal(done.summary.done, 2);
  assert.equal(starts[0].internal.autoDuration, true);
  assert.equal(done.videos[1].duration, 45);
});

test('persistence failure aborts both in-flight jobs before a third can start', async (t) => {
  const root = scratch(t);
  const { coordinator, starts, jobs, aborts } = coordinatorRig(root);
  const run = coordinator.startRun({ count: 3, theme: 'Bridges', type: 'factual', duration: 30, voice: 'aiden' });
  await until(() => starts.length === 2);
  const record = path.join(root, run.id, 'run.json');
  fs.unlinkSync(record); fs.mkdirSync(record);
  jobs.get('job-0').step = 'previewing';
  await coordinator.idle();
  const done = coordinator.getRun(run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'persistence_failed');
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(aborts), new Set(['job-0', 'job-1']));
  assert.equal(done.videos[0].error.code, 'persistence_failed');
  assert.equal(done.videos[1].error.code, 'persistence_failed');
  assert.equal(done.videos[2].status, 'aborted');
});
