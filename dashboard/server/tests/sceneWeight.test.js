// Bug of 2026-11-13 (job mwez63ee-fa76e6): a 13-shot build that made its scene through its own helper functions was
// refused twice as "too little scene: 2 of 39", because only the literal text meshes.<shape>( was counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneWeightOf } from '../episode/codebuilt/planner.js';

test('literal mesh, figure and set calls count as before', () => {
  assert.equal(sceneWeightOf('a = meshes.box(c)\nb = meshes.ball(c)\nf = figures.make_person(c, 0)\ncity_street.build(c)\n'), 6);
});

test('repeated calls of a mesh-building helper count', () => {
  const src = ['def block(c, x):', '    return meshes.box(c, x)', '', ...Array.from({ length: 40 }, (_, i) => `block(c, ${i})`)].join('\n');
  assert.ok(sceneWeightOf(src) >= 39, `got ${sceneWeightOf(src)}`);
});

test('a helper that builds nothing adds nothing, however often it is called', () => {
  const src = ['def lerp(a, b, t):', '    return a + (b - a) * t', '', ...Array.from({ length: 40 }, () => 'x = lerp(0, 1, 0.5)'), 'meshes.box(c)'].join('\n');
  assert.equal(sceneWeightOf(src), 1);
});

test('a helper of helpers counts, capped per call', () => {
  const src = ['def leg(c):', '    return meshes.box(c)', 'def table(c):', '    leg(c); leg(c); leg(c); leg(c)', '    return meshes.box(c)', 'table(c)', 'table(c)', 'table(c)'].join('\n');
  const w = sceneWeightOf(src);
  assert.ok(w >= 8 && w <= 20, `got ${w}`);
});

// Bug of 2026-11-13 (job mwf06gtw-069893): shot collections named through a variable were reported as missing.
import { validateBuildScript } from '../episode/codebuilt/planner.js';

test('shot collections named through a variable are found', () => {
  const src = "for _i in range(3):\n    _name = 'shot-%d' % _i\n    _c = meshes.coll(scene, _name)\n";
  const why = validateBuildScript(src, { nframes: 90, shotStarts: [0, 1, 2] });
  assert.ok(!why.some((r) => /collection 'shot-\d+' is missing/.test(r)), why.join('; '));
});

test('a script with no shot collections at all is still refused', () => {
  const why = validateBuildScript("x = 1\n", { nframes: 90, shotStarts: [0, 1, 2] });
  assert.ok(why.some((r) => /collection 'shot-0' is missing/.test(r)));
});
