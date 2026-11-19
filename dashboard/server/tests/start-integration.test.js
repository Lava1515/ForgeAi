import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';

// codex · gpt-6.1-sol · 2026-11-19: a missing route needs no author-mode flag.
test('a job with no route starts as authored', async () => {
  const jobsDir = fs.mkdtempSync('C:/code/ForgeAi/output/agent-jobs/c4-remove-classic/default-');
  const prior = process.env.FORGEAI_AUTHOR_MODE;
  delete process.env.FORGEAI_AUTHOR_MODE;
  const starter = createCodebuiltStarter({ jobsDir, planner: {}, composeRunner: async () => { throw new Error('test runner unavailable'); } });
  try {
    const job = starter.start({ topic: 'How do bridges work?', duration: 60 });
    assert.equal(job.route, 'authored');
    const record = JSON.parse(fs.readFileSync(path.join(jobsDir, '.start', job.id, 'status.json'), 'utf8'));
    assert.equal(record.route, 'authored');
  } finally {
    await starter.idle();
    if (prior !== undefined) process.env.FORGEAI_AUTHOR_MODE = prior;
    fs.rmSync(jobsDir, { recursive: true });
  }
});

test('factual and history jobs start after loop removal, including batch history', async () => {
  const scratch = 'C:/code/ForgeAi/output/temp';
  fs.mkdirSync(scratch, { recursive: true });
  const jobsDir = fs.mkdtempSync(path.join(scratch, 'start-integration-'));
  // Stop execution before any model, renderer or network call; exercise the real queue/persistence.
  const starter = createCodebuiltStarter({ jobsDir, planner: {}, composeRunner: async () => { throw new Error('test runner unavailable'); } });
  try {
    for (const [input, internal, history] of [
      [{ topic: 'How do bridges work?', duration: 60 }, {}, false],
      [{ topic: 'How did Roman bridges work?', duration: 60, type: ' HISTORY ' }, {}, true],
      [{ topic: 'How did Roman bridges work?', duration: 60 }, { factCheck: true, runId: 'run-history', choices: { type: 'history' } }, true],
    ]) {
      const job = starter.start(input, internal);
      const record = JSON.parse(fs.readFileSync(path.join(jobsDir, '.start', job.id, 'status.json'), 'utf8'));
      if (history) {
        assert.equal(record.contentMode, 'history');
        assert.equal(record.factCheck, true);
        assert.equal(record.choices.type, 'history');
      } else assert.notEqual(record.contentMode, 'history');
      await starter.idle();
      assert.equal(starter.get(job.id).status, 'failed');
    }
  } finally {
    await starter.idle();
    fs.rmSync(jobsDir, { recursive: true });
  }
});
