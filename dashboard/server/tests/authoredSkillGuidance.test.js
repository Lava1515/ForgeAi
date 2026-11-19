// codex · gpt-6.1-sol · 2026-11-17 22:36 +02:00: L-SOL-1 regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadCodebuiltGuides } from '../episode/codebuilt/skills.js';
import { guidesFor } from '../episode/codebuilt/planner.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pack = {
  skills: [{ skill: 'codebuilt-script', mode: 'guidance_only' }],
  rules: { skillsByStep: { script: ['codebuilt-script'] }, formats: { journey: { overlay: true } } },
};

test('overlay, authored and overlay formats retain script overlay guidance', () => {
  for (const options of [{ route: 'overlay' }, { route: 'authored' }, { formats: ['journey'] }]) {
    assert.match(loadCodebuiltGuides({ pack, step: 'script', ...options }), /## When text is drawn after the render/);
  }
  assert.match(guidesFor(pack, 'script', '', 'factual', 'overlay'), /## When text is drawn after the render/);
  assert.match(guidesFor(pack, 'script', '', 'factual', 'classic', ['journey']), /## When text is drawn after the render/);
});

test('all six authored guides retain text-after-render guidance', () => {
  for (const name of ['codebuilt-script', 'codebuilt-direction', 'codebuilt-scene-generation', 'codebuilt-look-review', 'codebuilt-maps', 'codebuilt-teardown']) {
    const isolated = { skills: [{ skill: name, mode: 'guidance_only' }], rules: { skillsByStep: { probe: [name] } } };
    assert.match(loadCodebuiltGuides({ pack: isolated, step: 'probe', route: 'authored' }), /## When text is drawn after the render/, name);
  }
});
