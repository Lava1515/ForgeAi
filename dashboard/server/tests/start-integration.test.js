import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';

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
