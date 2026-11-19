// codex · gpt-6.1-sol · 2026-11-17 17:21 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayScriptProblems, validateBuildScript, authorBuildPrompt, loadCodebuiltPathPack} from './planner.js';
const good = `from blender_worker.codebuilt import anchors, stage
def shot(t):
 anchors.mark('lid',(0,0,0))
 anchors.value('depth',t)
 stage.Camera(scene)
`;
const spec = {labels:[{anchor:'lid'}],counter:{value:'depth'}};
for (const code of [
 'from sys import modules', 'from sys import modules as m',
 'x=1; from builtins import getattr as ga', 'x=1; import builtins as b',
 'x=1; import pathlib', 'import math, pathlib', 'if True:\n import pathlib',
 "wm.highlight(*['BRA', (1,0,0)])", "wm.highlight_group(['BRA'], *['auto'])",
 "wm.highlight('BRA', label=True)", "wm.highlight_group(['BRA'], label='BRAZIL')",
 "bpy.ops.object.add(type='FO'+'NT')", 'bpy.ops.object.add(**kwargs)',
 "o=bpy.ops.object; o.add(type='FO'+'NT')",
 "from bpy import ops; ops.object.add(type='FO'+'NT')",
 "import bpy as B; B.ops.object.add(type='FO'+'NT')",
 "o=bpy.ops.object; o.add(type=''.join(['FO','NT']))",
 'bpy.ops.object.add()',
 "f=bpy.ops.object.add; f(type='FO'+'NT')",
 "map(lambda f: f(type='F'+'ONT'), [bpy.ops.object.add])",
 "wm.label('BRA')", 'f=wm.label', 'wm.callout()',
]) test(`overlay refuses ${code}`, () => {
 assert.ok(overlayScriptProblems(good + '\n' + code, spec).length);
});
for (const code of [
 "seen=set(); seen.add('x')", 'fc.keyframe_points.add(2)',
 'obj.vertex_groups.add(1)',
 "node.label = 'shader description'", "wm.highlight('BRA', (1,0,0))",
 "wm.highlight_group(['BRA'], (1,0,0))", "wm.highlight('BRA', label=False)",
 "bpy.ops.object.add(type='EMPTY')", "bpy.data.curves.new('path', type='CURVE')",
 'import math, numpy as np', 'from math import (sin, cos)',
]) test(`overlay accepts ${code}`, () => {
 assert.deepEqual(overlayScriptProblems(good + '\n' + code, spec), []);
});
test('overlay imports use Python syntax rather than line-start regex', () => {
 const code = good + '\nx=1; import pathlib';
 const options = {nframes:90, shotStarts:[0]};
 assert.ok(validateBuildScript(code,{...options,overlay:true,overlaySpec:spec}).includes('import not allowed: pathlib'));
 assert.ok(!validateBuildScript(code,options).some(x=>x.startsWith('import not allowed:')));
});
test('overlay prompt keeps set geometry, omits hidden text handles and stale text instructions', async () => {
 const pack = structuredClone(loadCodebuiltPathPack());
 pack.rules.formats = {...pack.rules.formats, journey:{overlay:true}};
 let prompt;
 prompt=authorBuildPrompt({topic:'A journey',duration:30,script:'Hello.',brief:'A journey',words:{dur:1.15,words:[{w:'Hello',s:0,e:1.15}]},pathPack:pack,formats:['journey'],shotStarts:[0],nframes:90});
 for (const name of ['cutaway_planet','polar_penguin','tunnel']) {
  const line = prompt.split('\n').find(l=>l.startsWith(name+'.build'));
  assert.ok(line, name+' geometry manual remains');
  assert.doesNotMatch(line, /\b(?:clock|label|readouts)\b/);
 }
 assert.doesNotMatch(prompt, /pops? a label|readout width|70 percent overlay safe area/i);
});
