// codex · gpt-6.1-sol · 2026-11-14: a silent job must never spend a voice request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { loopBrief } from '../episode/codebuilt/planner.js';

test('loop jobs never call scripting, narration fact checking or the voice service', async () => {
  const scratch = path.resolve('../../output/temp/loop-format');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'no-voice-'));
  let voiceRequests = 0, builds = 0;
  const starter = createCodebuiltStarter({
    jobsDir: root, visualLoop: false,
    scriptStage: async () => { throw new Error('must not script a loop'); },
    factCheckStage: async () => { throw new Error('must not check narration'); },
    voiceStage: async () => { voiceRequests += 1; throw new Error('must not request voice'); },
    planner: { loopBrief, planCodebuiltBuild: async (input) => {
      assert.equal(input.script, '');
      assert.equal(input.words, undefined);
      assert.equal(input.pathPack.videoType, 'loop');
      return { buildScript: '# fixture', nframes: 300, shotStarts: [0] };
    } },
    composeRunner: async () => ({ runner: { run: async (input) => {
      builds += 1;
      fs.mkdirSync(path.join(root, input.jobId), { recursive: true });
      assert.equal(input.voWav, undefined);
      assert.equal(input.words, undefined);
      assert.equal(input.pathPack.loop.nframes, 300);
    } } }),
    lightMetadataStage: async () => ({}),
    // Adapter integration belongs to lane B/supervisor, not this regression.
    toDraft: () => ({ id: 'loop-draft-fixture', metadata: { social: { duration_seconds: 10 } } }),
  });
  const job = starter.start({ topic: 'A ring passes through a ring', type: 'loop', duration: 10, loop_idea: 'periodic orbit' },
    { factCheck: true, runId: 'loop-run', choices: { type: 'loop' } });
  await starter.idle();
  assert.equal(starter.get(job.id).status, 'done');
  assert.equal(voiceRequests, 0);
  assert.equal(builds, 1);
  assert.equal(fs.existsSync(path.join(root, '.start', job.id, 'script.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '.start', job.id, 'words.json')), false);
});
