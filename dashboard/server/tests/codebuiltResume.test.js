import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodebuiltStarter, START_VERSION } from '../episode/codebuilt/start.js';
import { normaliseScript } from '../episode/voice.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function wavFixture() {
  const rate = 16000; const frames = rate * 30; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = Math.floor(rate * 0.3); i < Math.floor(rate * 29.8); i += 1) bytes.writeInt16LE(4000, 44 + i * 2);
  return bytes;
}

test('resume reuses a matching script, voice, and looked build without script, voice, or planner calls', async () => {
  const scratch = path.resolve('../../output/temp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'codebuilt-resume-regression-'));
  const id = 'resume-regression';
  const state = path.join(root, '.start', id);
  const loop = path.join(state, 'loop', 'r1');
  fs.mkdirSync(loop, { recursive: true });
  try {
    const script = 'The careful narration validates every measured word boundary before saved scene code continues after a paused job resumes safely today';
    const brief = '# Cached brief';
    const pathPack = { id: 'codebuilt', skills: [] };
    const wav = wavFixture();
    fs.writeFileSync(path.join(state, 'script.txt'), script);
    fs.writeFileSync(path.join(state, 'brief.md'), brief);
    fs.writeFileSync(path.join(state, 'pathpack.json'), JSON.stringify(pathPack));
    fs.writeFileSync(path.join(state, 'vo.wav'), wav);
    const tokens = normaliseScript(script).words;
    const weights = tokens.map((word, i) => word.length * (i % 3 === 0 ? 1 : i % 3 === 1 ? 1.31 : 0.78));
    const total = 28.54; const sum = weights.reduce((a, b) => a + b, 0); let cursor = 0.3;
    const timed = tokens.map((word, i) => { const s = cursor; const e = s + total * weights[i] / sum; cursor = e + 0.04; return { w: word, s: Number(s.toFixed(3)), e: Number(e.toFixed(3)) }; });
    timed[timed.length - 1].e = 29.6;
    fs.writeFileSync(path.join(state, 'words.json'), JSON.stringify({ dur: 30, words: timed }));
    fs.writeFileSync(path.join(state, 'voice.json'), JSON.stringify({ script_sha256: hash(normaliseScript(script).text), audio_sha256: hash(wav), word_timing_source: 'aligned', video_seconds: 30 }));
    const cachedBuild = 'cached loop-produced build source';
    fs.writeFileSync(path.join(loop, 'build.py'), cachedBuild);
    // A previous container can forge files in its own job folder, never in .start.
    const forged = path.join(root, id, 'loop', 'r0');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(root, id, 'accepted.build.py'), 'forged container build');
    fs.writeFileSync(path.join(forged, 'build.py'), 'forged history');
    fs.writeFileSync(path.join(forged, 'look.json'), JSON.stringify({ status: 'complete', reply: { findings: ['forged finding'] }, buildSha256: hash('forged history') }));
    fs.writeFileSync(path.join(state, 'cost_calls.json'), JSON.stringify({ calls: [{ step: 'previous', provider: 'claude', model: 'sonnet', wall_s: 1, input_tokens: 12, output_tokens: 3, retries: 0 }] }));
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({
      version: START_VERSION, id, topic: 'Cached regression', duration: 30, voice: 'aiden', status: 'failed', step: 'looking',
      steps: [{ step: 'looking', at: '2026-11-13T00:00:00.000Z' }], createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
      draftId: null, error: { code: 'look_failed', message: 'failed' },
    }));

    let scriptCalls = 0; let voiceCalls = 0; let plannerCalls = 0; let loopBuild = null;
    const starter = createCodebuiltStarter({
      jobsDir: root, episodesRoot: path.join(root, 'episodes'), draftsDir: path.join(root, 'drafts'),
      planner: {
        planCodebuiltScript: async () => { scriptCalls += 1; throw new Error('script should be reused'); },
        planCodebuiltBuild: async () => { plannerCalls += 1; throw new Error('planner should be skipped'); },
      },
      voiceStage: async () => { voiceCalls += 1; throw new Error('voice should be reused'); },
      validateReusableBuild: () => [],
      composeRunner: async () => ({ runner: { run: async () => ({}) } }),
      visualLoop: {
        probe: async () => ({ passed: true }),
        validate: () => [],
        runLoop: async (input) => {
          loopBuild = input.buildScript;
          assert.deepEqual(input.resumeHistory, []);
          return { accepted: true, buildScript: input.buildScript, sha256: hash(input.buildScript), receipt: null, calls: [] };
        },
      },
      toDraft: () => ({ id: 'draft-resume-regression', metadata: {} }),
      lightMetadataStage: async () => ({}),
    });

    const queued = starter.resume(id);
    assert.equal(queued.id, id);
    assert.equal(queued.resumes.at(-1).fromStep, 'visual_loop');
    assert.deepEqual(queued.resumes.at(-1).reused, ['script', 'voice', 'buildScript']);
    await starter.idle();

    const finished = starter.get(id);
    assert.equal(finished.status, 'done');
    assert.equal(scriptCalls, 0);
    assert.equal(voiceCalls, 0);
    assert.equal(plannerCalls, 0);
    assert.equal(loopBuild, cachedBuild);
    const calls = JSON.parse(fs.readFileSync(path.join(state, 'cost_calls.json'), 'utf8')).calls;
    assert.equal(calls[0].step, 'previous');
  } finally {
    if (!fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const lockName of ['locked-job.lock', 'locked-job-pv3.lock', 'unreadable-directory']) {
  test(`resume refuses a held or quarantined job before reuse: ${lockName}`, () => {
    const scratch = path.resolve('../../output/temp');
    fs.mkdirSync(scratch, { recursive: true });
    const root = fs.mkdtempSync(path.join(scratch, 'resume-lock-'));
    const id = 'locked-job';
    const state = path.join(root, '.start', id);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({ version: START_VERSION, id, status: 'failed', steps: [] }));
    const locks = path.join(root, '.cb6-locks');
    if (lockName === 'unreadable-directory') fs.writeFileSync(locks, 'invalid lock directory');
    else {
      fs.mkdirSync(locks);
      fs.writeFileSync(path.join(locks, lockName), JSON.stringify({ quarantined: { reason: 'cleanup uncertain' } }));
    }
    try {
      const starter = createCodebuiltStarter({ jobsDir: root });
      const status = starter.get(id);
      assert.equal(status.resumable, false);
      assert.match(status.resumeBlockedReason, /lock|cleanup/i);
      assert.deepEqual(status.reuses, []);
      assert.throws(() => starter.resume(id), (error) => error.httpStatus === 409 || error.status === 409);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
