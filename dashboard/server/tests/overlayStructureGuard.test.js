// claude-pro · claude-sonnet-5-5 · 2026-11-18 (Fable check 1, fix 2): overlay builds refuse the F01-F04 text-in-3D routes early; classic is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayScriptProblems,validateBuildScript} from '../episode/codebuilt/planner.js';
const good = `from blender_worker.codebuilt import anchors, stage
def shot(t):
 anchors.mark('lid',(0,0,0))
 anchors.value('depth',t)
`;
const spec={labels:[{anchor:'lid'}],counter:{value:'depth'}};
const forms={
 F01:"me=bpy.data.meshes.new_from_object(seed.evaluated_get(dg))",
 F01b:"me=seed.to_mesh()",
 F02:"s=ng.nodes.new('GeometryNode'+'StringToCurves')",
 F03:"oi=ng.nodes.new('GeometryNodeObjectInfo')",
 F04:"scene.background_set=other",
};
test('overlay accepts the plain build',()=>assert.deepEqual(overlayScriptProblems(good,spec),[]));
for(const [id,body] of Object.entries(forms)) test(`overlay refuses ${id} with a clear message`,()=>{
 const p=overlayScriptProblems(good+'\n'+body,spec);
 assert.ok(p.some(x=>/cannot (convert objects|use the Geometry Nodes)/.test(x)),JSON.stringify(p));
});
