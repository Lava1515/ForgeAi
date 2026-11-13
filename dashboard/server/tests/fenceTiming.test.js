import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runIsolatedJob } from '../episode/codebuilt/runJob.js';
import { APPROVED_LAUNCHES } from '../episode/codebuilt/policy.js';
import { createBuildJobRunner } from '../episode/engines/codebuilt/runner.js';
import { jobPaths } from '../episode/engines/codebuilt/jobFolder.js';

function fixture() {
  const scratch = path.resolve('../../output/temp');
  fs.mkdirSync(scratch, { recursive: true });
  return fs.mkdtempSync(path.join(scratch, 'fence-timing-'));
}

test('a refused simulated launch records host phases without starting a process', async () => {
  const root = fixture();
  const jobDir = path.join(root, 'timing-job');
  fs.mkdirSync(path.join(jobDir, 'work'), { recursive: true });
  const launch = APPROVED_LAUNCHES[0];
  try {
    const report = await runIsolatedJob({ jobRoot: root, jobDir, jobId: 'timing-job', runtime: 'docker', kind: 'stub', image: launch.image, command: [...launch.command], gpu: false, limits: { ...launch.limits }, timeoutMs: 1000, allowNoLeakScan: true }, {
      spawnFn: () => { assert.fail('image refusal must not spawn'); },
      dockerFn: async (args) => args[0] === 'image' ? 'missing-image' : '',
      watchRoots: [{ root, depth: 1, exclude: [jobDir, path.join(root, '.cb6-locks')] }],
    });
    assert.equal(report.status, 'image_not_local');
    assert.equal(report.started, false);
    assert.equal(report.cleanup.verified, true);
    const phases = report.timing.hostPhases;
    assert.equal(phases.clock, 'monotonic_ms');
    assert.deepEqual(Object.keys(phases.atMs), ['validated', 'reaped', 'locked', 'leaseReady', 'snapshotBefore', 'fenceReturned', 'snapshotAfter', 'resourcesSettled', 'auditComplete']);
    const times = Object.values(phases.atMs);
    assert.ok(times.every((value, i) => Number.isFinite(value) && value >= 0 && (i === 0 || value >= times[i - 1])));
    assert.ok(phases.totalMs >= times.at(-1));
    assert.equal(fs.existsSync(path.join(root, '.cb6-locks', 'timing-job.lock')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed fence timings survive classification in host-owned job state', async () => {
  const root = fixture();
  const wav = path.join(root, 'source.wav');
  fs.writeFileSync(wav, 'fixture audio');
  const timing = { hostPhases: { clock: 'monotonic_ms', atMs: { fenceReturned: 17 }, totalMs: 20 } };
  try {
    const runner = createBuildJobRunner({ root, inputRoots: [root], runIsolatedJob: async () => ({ status: 'agent_exited', ok: false, timing }) });
    await assert.rejects(runner.run({ jobId: 'failed-timing', timeoutMs: 1000, script: 'fixture script', brief: 'fixture brief', voWav: wav, words: { words: [] }, pathPack: { id: 'codebuilt' } }), { code: 'AGENT_EARLY_STOP' });
    const state = JSON.parse(fs.readFileSync(jobPaths(root, 'failed-timing').state, 'utf8'));
    assert.equal(state.status, 'failed');
    assert.deepEqual(state.fenceTiming, timing);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
