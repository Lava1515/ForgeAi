import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobUsesOverlay, loadCodebuiltGuides, runWithJobFormats } from '../episode/codebuilt/skills.js';
import { directionPrompt } from '../episode/codebuilt/direction.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'paths/codebuilt.json'), 'utf8'));

test('journey format enables overlay and loads its journey guidance at script, direction, and build', () => {
  assert.equal(jobUsesOverlay(pack, ['journey']), true);
  assert.equal(jobUsesOverlay(pack, ['map']), false);
  assert.equal(jobUsesOverlay(pack, ['unknown']), false);
  for (const step of ['script', 'direction', 'build']) {
    assert.match(loadCodebuiltGuides({ pack, step, root, formats: ['journey'] }), /one physical thing/i);
  }
});

test('a job scoped to journey receives the format-specific direction prompt limits', () => {
  const prompt = runWithJobFormats(['journey'], () => directionPrompt({
    topic: 'A rolling ball', duration: 27, script: 'A ball rolls.', brief: 'Simple.',
    phrases: [{ i: 0, start: 0, end: 1, text: 'A ball rolls.' }], videoSeconds: 27, setManual: '', propsManual: '',
  }));
  assert.match(prompt, /PLACES\. 1 to 3 places/);
  assert.match(prompt, /2\.2 to 16 seconds/);
  const ordinary = directionPrompt({
    topic: 'A rolling ball', duration: 27, script: 'A ball rolls.', brief: 'Simple.',
    phrases: [{ i: 0, start: 0, end: 1, text: 'A ball rolls.' }], videoSeconds: 27, setManual: '', propsManual: '', formats: [],
  });
  assert.match(ordinary, /PLACES\. 1 to 4 places/);
  assert.match(ordinary, /2\.2 to 16 seconds/);
});
