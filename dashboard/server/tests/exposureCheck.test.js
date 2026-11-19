// codex · gpt-6.1-sol · 2026-11-19 14:31 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFinalExposure, exposureAdvice } from '../episode/codebuilt/exposureCheck.js';

test('exposure warnings reach author feedback with earlier final-sheet advice', () => {
  const prompt = exposureAdvice([{ tiles: [
    { frame: 30, exposure: { issues: ['pale'] } },
    { frame: 90, exposure: { issues: ['black_region'] } },
  ] }], ['final-sheet tile 8 has a large black region; add fill light']);
  assert.match(prompt, /frame 30 is washed out; lower exposure/);
  assert.match(prompt, /frame 90 has a large black region/);
  assert.match(prompt, /final-sheet tile 8/);
  assert.match(prompt, /does not require a fix verdict/);
  assert.equal(exposureAdvice([{ tiles: [{ frame: 30 }] }]), '');
});

test('final-sheet measurement is advisory even when Python fails or returns bad data', async () => {
  for (const [error, stdout] of [[Error('no python'), ''], [null, 'bad json'], [null, '{}']]) {
    const result = await checkFinalExposure({ jobDir: process.cwd(), execFileFn: (_exe, _args, _opts, cb) => cb(error, stdout) });
    assert.deepEqual(result, { findings: [], unavailable: true });
  }
  const result = await checkFinalExposure({ jobDir: process.cwd(), execFileFn: (_exe, _args, _opts, cb) => cb(null, '{"findings":["tile 8 needs fill"]}') });
  assert.deepEqual(result.findings, ['tile 8 needs fill']);
});
