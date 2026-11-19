import { authorOptions, authorPlanner, renderPack } from './helpers/authored.js';
// codex · gpt-6.1-sol · 2026-11-16 08:56 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';

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
    factCheckStage: hooks.factCheck ?? (async () => ({ verified: true })),
    voiceStage: async (input) => {
      events.push(['voice', input.runId]);
      await hooks.voice?.(input);
      const out = { voPath: path.join(input.outDir, 'vo.wav'), wordsPath: path.join(input.outDir, 'words.json'), manifestPath: path.join(input.outDir, 'voice.json') };
      fs.writeFileSync(out.voPath, 'fixture');
      const seconds = hooks.voiceSeconds?.() ?? hooks.duration ?? 30;
      fs.writeFileSync(out.wordsPath, JSON.stringify({ dur: seconds - 2, words: Array.from({ length: 20 }, () => ({ w: 'word' })) }));
      fs.writeFileSync(out.manifestPath, JSON.stringify({ video_seconds: seconds }));
      return out;
    },
    composeRunner: async () => ({ runner: { run: async (input) => {
      events.push(['render', input.jobId]);
      await hooks.render?.(input);
      fs.mkdirSync(path.join(root, input.jobId), { recursive: true });
    } } }),
    lightMetadataStage: async () => ({}),
    toDraft: (input) => { events.push(['draft', input.jobId, input.requestedDuration]); return { id: `draft-${input.jobId}`, metadata: { social: { duration_seconds: input.requestedDuration } } }; },
  });
  return { starter, events };
}

for (const autoDuration of [false, true]) test(`script duration override respects Auto=${autoDuration}`, async (t) => {
  const root = scratch(t);
  const { starter, events } = rig(root, { duration: 45 });
  const job = starter.start({ topic: 'duration', duration: 60 }, { factCheck: true, runId: 'run-length', autoDuration });
  await starter.idle();
  assert.equal(starter.get(job.id).duration, autoDuration ? 45 : 60);
  assert.equal(events.find(([phase]) => phase === 'script')[3], autoDuration ? true : undefined);
  if (autoDuration) {
    assert.equal(starter.get(job.id).status, 'done');
    assert.equal(events.find(([phase]) => phase === 'plan')[2], 45);
    assert.equal(events.find(([phase]) => phase === 'draft')[2], 45);
    assert.equal(starter.get(job.id).length_check.requested_s, 45);
    assert.equal(starter.get(job.id).length_check.within_tolerance, true);
  } else assert.equal(starter.get(job.id).error.code, 'too_short');
});

test('Auto rejects a duration outside the S2 contract before spending on voice', async (t) => {
  const { starter, events } = rig(scratch(t), { duration: 46 });
  const job = starter.start({ topic: 'invalid selection', duration: 30 }, { factCheck: true, runId: 'run-invalid', autoDuration: true });
  await starter.idle();
  assert.equal(starter.get(job.id).error.code, 'script_failed');
  assert.equal(events.filter(([phase]) => phase === 'voice').length, 0);
});

test('selected Auto duration survives the measured-length script/voice retry', async (t) => {
  let take = 0;
  const { starter, events } = rig(scratch(t), { duration: 45, voiceSeconds: () => ++take === 1 ? 30 : 45 });
  const job = starter.start({ topic: 'retry duration', duration: 30 }, { factCheck: true, runId: 'run-retry', autoDuration: true });
  await starter.idle();
  assert.equal(starter.get(job.id).status, 'done');
  assert.equal(starter.get(job.id).duration, 45);
  const scripts = events.filter(([phase]) => phase === 'script');
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0][3], true);
  assert.equal(scripts[1][2], 45);
  assert.equal(scripts[1][3], undefined);
});

test('resume preserves selected duration when reusing script after voice failure', async (t) => {
  let takes = 0;
  const { starter, events } = rig(scratch(t), { duration: 45, voice: () => { if (++takes === 1) throw new Error('voice failed'); } });
  const job = starter.start({ topic: 'resume duration', duration: 30 }, { factCheck: true, runId: 'run-resume', autoDuration: true });
  await starter.idle();
  assert.equal(starter.get(job.id).status, 'failed');
  starter.resume(job.id); await starter.idle();
  assert.equal(starter.get(job.id).duration, 45);
  assert.equal(starter.get(job.id).status, 'done');
  assert.equal(events.filter(([phase]) => phase === 'script').length, 1);
  assert.equal(events.find(([phase]) => phase === 'plan')[2], 45);
});

test('fact-check rewrite receives the fixed selection without Auto', async (t) => {
  let checks = 0;
  const { starter, events } = rig(scratch(t), {
    duration: 45,
    factCheck: async () => ++checks === 1 ? { verified: false, facts: { claims: [{ text: 'claim', verdict: 'uncertain' }] } } : { verified: true },
  });
  const job = starter.start({ topic: 'correct duration', duration: 30 }, { factCheck: true, runId: 'run-correct', autoDuration: true });
  await starter.idle();
  assert.equal(starter.get(job.id).status, 'done');
  const scripts = events.filter(([phase]) => phase === 'script');
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0][3], true);
  assert.equal(scripts[1][2], 45);
  assert.equal(scripts[1][3], undefined);
});

test('coordinator retains Auto intent despite a resolved 30-second fallback', async (t) => {
  const root = scratch(t); let started;
  const channel = { id: 'channel', video_types: ['factual'] };
  const coordinator = createCodebuiltRunCoordinator({
    runsDir: root, getChannel: () => channel, getChannels: () => [channel],
    resolveAuto: () => ({ body: { seconds: 30 }, resolved: {} }),
    starter: {
      start(input, internal) { started = { input, internal }; return { id: 'duration-job', step: 'queued' }; },
      get() { return { id: 'duration-job', status: 'done', step: 'done', duration: 45 }; },
    },
  });
  const run = coordinator.startRun({ count: 1, topic: 'A bridge', type: 'factual', voice: 'aiden' });
  await coordinator.idle();
  assert.equal(started.input.duration, 30);
  assert.equal(started.internal.autoDuration, true);
  const result = coordinator.getRun(run.id);
  assert.equal(result.videos[0].duration, 45);
  assert.equal(result.videos[0].resolved.duration.value, 45);
});
