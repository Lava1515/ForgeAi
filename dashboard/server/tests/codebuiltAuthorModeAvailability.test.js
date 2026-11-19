import test from 'node:test';
import assert from 'node:assert/strict';
import { listCodebuiltHandler } from '../routes/codebuilt.js';
import { setCodebuiltStarter } from '../episode/codebuilt/start.js';

const call = async () => {
  const out = {};
  const res = { json(value) { out.json = value; return this; } };
  await listCodebuiltHandler({}, res);
  return out.json;
};

test('jobs list reports author availability without a flag and preserves its jobs array', async () => {
  const jobs = [{ id: 'existing-job', status: 'done' }];
  setCodebuiltStarter({ list: () => jobs });
  const old = process.env.FORGEAI_AUTHOR_MODE;
  try {
    for (const value of ['1', undefined, '', '0', 'true', ' 1']) {
      if (value === undefined) delete process.env.FORGEAI_AUTHOR_MODE;
      else process.env.FORGEAI_AUTHOR_MODE = value;
      const response = await call();
      assert.deepEqual(response.jobs, jobs);
      assert.equal(response.authorModeAvailable, true);
      assert.equal(typeof response.authorModeAvailable, 'boolean');
      assert.deepEqual(Object.keys(response).sort(), ['authorModeAvailable', 'jobs']);
    }
  } finally {
    if (old === undefined) delete process.env.FORGEAI_AUTHOR_MODE;
    else process.env.FORGEAI_AUTHOR_MODE = old;
    setCodebuiltStarter(null);
  }
});
