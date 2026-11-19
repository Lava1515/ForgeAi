// codex · gpt-6.1-sol · 2026-11-19 20:02 +02:00: flat draft regression; no Blender or render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSurfaces, surfaceAdvice } from '../episode/codebuilt/surfaceCheck.js';
import { AUTHOR_KIT_CONTRACT } from '../episode/codebuilt/planner.js';
import { assetContractText } from '../episode/codebuilt/assetCatalog.js';

test('plain subject and ground are reported; comments, strings and small eyes are not role failures', () => {
  const r = checkSurfaces(`# materials.wood('subject')
s = "materials.rock('ground')"
subject_material = materials.pbr('hero', (1, 0, 0))
ground_material = materials.pbr('floor', (1, 0, 0))
eye = materials.pbr('eye', (0, 0, 0))
`);
  assert.deepEqual(r.counts, { pbr: 3, surface: 0, noise: 0, hdri: 0 });
  assert.deepEqual(r.roles, {subject:{pbr:1,surface:0},ground:{pbr:1,surface:0}});
  assert.equal(r.plain[2].role, 'other');
  assert.match(surfaceAdvice(r), /Return fix this round/);
  assert.equal(r.findings.length, 5);
});

test('named actual helpers and library sky satisfy the static check with plain small details', () => {
  const r = checkSurfaces(`subject_material = materials.painted_metal('subject_body')
ground_material = materials.noise_mat('ground', (0,0,0), (1,1,1), .5, 2)
eye = materials.pbr('eye', (0,0,0))
library.hdri(scene, 'listed_sky')
`);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.counts, {pbr:1,surface:1,noise:1,hdri:1});
});

test('missing interpreter or invalid source reports unavailable, never executes source', () => {
  assert.match(checkSurfaces('invalid', {spawn:()=>({status:1})}).findings[0], /unavailable/);
  assert.match(checkSurfaces('this is not valid python !!!').findings[0], /unavailable/);
});

test('authored requirements survive missing catalog; available library is required for lighting', () => {
  assert.match(AUTHOR_KIT_CONTRACT, /AUTHOR SURFACE REQUIREMENTS/);
  assert.match(AUTHOR_KIT_CONTRACT, /AUTHOR LIGHTING REQUIRED/);
  const text = assetContractText([{kind:'hdri',id:'sky'}]);
  assert.doesNotMatch(text, /optional/i);
  assert.match(text, /required for authored scene lighting/);
});
