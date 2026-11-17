// codex · gpt-6.1-sol · 2026-11-17 22:36 +02:00: L-SOL-1 regression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCodebuiltGuides } from '../episode/codebuilt/skills.js';
import { guidesFor } from '../episode/codebuilt/planner.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pack = {
  skills: [{ skill: 'codebuilt-script', mode: 'guidance_only' }],
  rules: { skillsByStep: { script: ['codebuilt-script'] }, formats: { journey: { overlay: true } } },
};

test('classic script guide equals the archived 717 skill, independent of current loader dependencies', () => {
  const archived = execFileSync('git', ['show', '717d65f:.claude/skills/codebuilt-script/SKILL.md'], { cwd: root, encoding: 'utf8' });
  const body = archived.trim().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  // Git blobs use LF; this Windows checkout uses CRLF for skill contents.
  assert.equal(guidesFor(pack, 'script', '', 'factual').replaceAll('\r\n', '\n'), `### codebuilt-script\n${body}`.replaceAll('\r\n', '\n'));
});

test('overlay, authored and overlay formats retain script overlay guidance', () => {
  for (const options of [{ route: 'overlay' }, { route: 'authored' }, { formats: ['journey'] }]) {
    assert.match(loadCodebuiltGuides({ pack, step: 'script', ...options }), /## When text is drawn after the render/);
  }
  assert.match(guidesFor(pack, 'script', '', 'factual', 'overlay'), /## When text is drawn after the render/);
  assert.match(guidesFor(pack, 'script', '', 'factual', 'classic', ['journey']), /## When text is drawn after the render/);
});

test('all six appended sections stay out of classic guidance and remain on overlay routes', () => {
  for (const name of ['codebuilt-script', 'codebuilt-direction', 'codebuilt-scene-generation', 'codebuilt-look-review', 'codebuilt-maps', 'codebuilt-teardown']) {
    const isolated = { skills: [{ skill: name, mode: 'guidance_only' }], rules: { skillsByStep: { probe: [name] } } };
    const classic = loadCodebuiltGuides({ pack: isolated, step: 'probe' });
    assert.doesNotMatch(classic, /## When text is drawn after the render/, name);
    assert.match(loadCodebuiltGuides({ pack: isolated, step: 'probe', route: 'overlay' }), /## When text is drawn after the render/, name);
    const archived = execFileSync('git', ['show', `717d65f:.claude/skills/${name}/SKILL.md`], { cwd: root, encoding: 'utf8' });
    const body = archived.trim().replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    assert.equal(classic.replaceAll('\r\n', '\n'), `### ${name}\n${body}`.replaceAll('\r\n', '\n'), name);
  }
});
