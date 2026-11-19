// The run the New Video page shows. Bug of 2026-11-19: after a reload the page forgot a running batch, showed nothing and offered Start again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const clientRoot = fileURLToPath(new URL('..', import.meta.url));

test('a run that is still going is shown after a reload; a finished one is kept only if it was already shown', async () => {
  const vite = await createServer({ root: clientRoot, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { pickShownRun } = await vite.ssrLoadModule('/src/components/episode/CodebuiltStart.jsx');
    const going = { id: 'run-b', status: 'running', videos: [] };
    const old = { id: 'run-a', status: 'done', videos: [] };
    assert.equal(pickShownRun([going, old], null), going);            // reload: nothing shown before
    assert.equal(pickShownRun([going, old], old), going);             // a new run replaces an old result
    assert.equal(pickShownRun([old], null), null);                    // no stale result after a reload
    const fresh = { ...old, summary: { drafts: 1 } };
    assert.equal(pickShownRun([fresh], old), fresh);                  // the shown run is refreshed when it ends
    assert.equal(pickShownRun(undefined, old), old);                  // a bad answer keeps what is shown
    assert.equal(pickShownRun([{ id: 'run-c', status: 'aborting', videos: [] }], null).id, 'run-c');
  } finally { await vite.close(); }
});
