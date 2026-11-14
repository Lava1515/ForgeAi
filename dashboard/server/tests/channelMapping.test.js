import test from 'node:test';
import assert from 'node:assert/strict';
import { setCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';
import { startCodebuiltRunHandler } from '../routes/codebuiltRuns.js';
import { createVideoResearch } from '../routes/videoResearch.js';

test('HTTP run leaves an omitted channel for the coordinator to map', async () => {
  let received;
  setCodebuiltRunCoordinator({ startRun(input) { received = input; return { id: 'mock' }; } });
  try {
    const res = { status(code) { assert.equal(code, 202); return this; }, json() {} };
    await startCodebuiltRunHandler({ body: { count: 3, type: 'history' } }, res);
    assert.equal(Object.hasOwn(received, 'channelId'), false);
  } finally { setCodebuiltRunCoordinator(null); }
});

test('a researched history selection starts a history job', async () => {
  let received;
  const flow = createVideoResearch({
    channels: () => [{ id: 'history-channel' }],
    youtube: async () => [],
    ask: async () => ({ _agy: true, candidates: [{ topic: 'How Roman roads connected the empire', why: 'A concrete history premise', sources: [{ url: 'https://example.test/source', title: 'Source' }] }] }),
    start: (input) => { received = input; return { id: 'mock' }; },
  });
  const result = await flow.research({ channelId: 'history-channel', type: 'history', query: 'Roman roads' });
  flow.create({ researchId: result.id, auto: true });
  assert.equal(received.type, 'history');
});
