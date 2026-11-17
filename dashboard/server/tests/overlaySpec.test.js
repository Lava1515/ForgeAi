// codex ? gpt-6.1-sol ? 2026-11-17 13:53 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseOverlaySpec,extractOverlay,jobUsesOverlay} from '../episode/codebuilt/overlaySpec.js';
import {overlayScriptProblems,validateBuildScript} from '../episode/codebuilt/planner.js';
const fixtures=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../tests/fixtures/overlay');
for(const c of JSON.parse(fs.readFileSync(path.join(fixtures,'cases.json'))).cases) test(`overlay parity ${c.file}`,()=>{
 const raw=fs.readFileSync(path.join(fixtures,c.file),'utf8');
 if(c.ok) assert.doesNotThrow(()=>parseOverlaySpec(raw,{videoSeconds:c.videoSeconds}));
 else assert.throws(()=>parseOverlaySpec(raw,{videoSeconds:c.videoSeconds}),e=>e.code===c.code && e.where===c.where);
});
test('extract requires exactly one JSON fence and flag is strict',()=>{
 assert.throws(()=>extractOverlay('{"version":1}'));
 assert.throws(()=>extractOverlay('```json\n{}\n```\n```json\n{}\n```'));
 assert.equal(extractOverlay('```python\npass\n```\n```json\n{"version":1}\n```').version,1);
 assert.equal(jobUsesOverlay({rules:{formats:{journey:{overlay:true},map:{overlay:1}}}},['journey']),true);
 assert.equal(jobUsesOverlay({rules:{formats:{map:{overlay:1}}}},['map']),false);
});
const good = `from blender_worker.codebuilt import anchors, stage
def shot(t):
 anchors.mark('lid',(0,0,0))
 anchors.value('depth',t)
 stage.Camera(scene)
`;
const spec={labels:[{anchor:'lid'}],counter:{value:'depth'}};
test('overlay canonical marks are accepted; comments do not count',()=>{
 assert.deepEqual(overlayScriptProblems(good,spec),[]);
 assert.ok(overlayScriptProblems(good.replace("anchors.mark('lid',(0,0,0))","# anchors.mark('lid',(0,0,0))"),spec).some(x=>x.includes('point names')));
 assert.ok(overlayScriptProblems(good.replace("anchors.value('depth',t)","anchors.value('other',t)"),spec).some(x=>x.includes('value names')));
});
for(const call of ['anchors.write','anchors.reset','anchors.begin','anchors.capture','anchors.document','anchors.usage','anchors.discard','anchors._write','stage.text','stage.hud_text','stage.hud','stage.fit_text']) test(`overlay refuses ${call}`,()=>assert.ok(overlayScriptProblems(good+`\n${call}()`,spec).length));
for(const code of ['a=anchors','f=anchors.mark','from blender_worker.codebuilt import anchors as a','from blender_worker.codebuilt.anchors import write as x','getattr(anchors,"write")()','anchors.__dict__["write"]()','f=stage.text','bpy.data.curves.new("x",type="FONT")','anchors.mark=foo','from blender_worker.codebuilt import *','bpy.ops.object.text_add()','bpy.data.curves.new("x",type="FO"+"NT")','c=bpy.data.curves; c.new("x","FO"+"NT")']) test(`overlay refuses bypass ${code}`,()=>assert.ok(overlayScriptProblems(good+'\n'+code,spec).length));

import {planCodebuiltBuild} from '../episode/codebuilt/planner.js';
import {writeInputs,verifyInputs,ensureJobFolder,jobPaths} from '../episode/engines/codebuilt/jobFolder.js';
const scratch = path.resolve('../../output/temp');
fs.mkdirSync(scratch, {recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'overlay-spec-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const base=`from blender_worker.codebuilt import meshes, shotcheck, renderloop, timeline, anchors
OUT = '/job/frames'
NFRAMES = 90
SHOT_STARTS = [0]
FPS = 30
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.render.resolution_x = 1080
scene.render.resolution_y = 1920
scene.render.resolution_percentage = 100
scene.render.fps = FPS
scene.cycles.samples = 8
c = meshes.coll(scene, 'shot-0')
${Array.from({length:9},(_,i)=>`obj${i}=meshes.ball(c)`).join('\n')}
def shot(t):
 anchors.mark('lid',(0,0,0))
 anchors.value('depth',t)
timeline.apply_frame(scene, shots, colls, 0)
shotcheck.run_qa(scene, cam, apply, NFRAMES, shots, hold=1)
renderloop.render_frames(range(NFRAMES), OUT, apply, render_fn, hold=1, require_qa=True)
`;
const words={dur:1.15,words:[{w:'Hello',s:0,e:1.15}]};
const pack=JSON.parse(fs.readFileSync(path.resolve(fixtures,'../../../paths/codebuilt.json')));
pack.rules.formats={...pack.rules.formats,journey:{overlay:true}};
const planInput={topic:'A journey',duration:30,script:'Hello.',brief:'A visible journey',words,pathPack:pack,formats:['journey']};
const deps={direct:false,syntaxCheck:()=>'',qaStructureCheck:()=>[]};

// codex · gpt-6.1-sol · 2026-11-17 14:50 +02:00: exact review bypasses, through the public validator.
for (const bypass of [
 'from blender_worker.codebuilt.stage import text',
 'from blender_worker.codebuilt.stage import hud_text as h',
 'from blender_worker.codebuilt.diagram import Board',
 "sys.modules['blender_worker.codebuilt.stage'].text()",
 "sys.modules['blender_worker.codebuilt.anchors'].write()",
 "sys.modules['builtins'].getattr(anchors, 'write')()",
 "bpy.ops.object.add(type=''.join(['F','O','N','T']))",
 "bpy.ops.object.add(type='FO'+'NT')",
 "bpy.ops.object.add(type=chr(70)+'ONT')",
 'bpy.ops.object.add()',
 "f=bpy.ops.object.add; f(type='FO'+'NT')",
 "bpy.ops.object.add(type='MESH', **kwargs)",
 "b=diagram.Board(c); b.label('170 KM',(0,-0.8))",
 'f=b.label',
 "model.callout('engine','ENGINE')",
 "teardown._make_callout_label(c,'x','TEXT',1)",
 'f=wm.highlight; f("BRA",label=True)',
 "wm.label('Brazil','BRA')",
 "wm.highlight('BRA',label=True)",
 "wm.highlight_group(['BRA'],label='BRAZIL')",
 "wm.highlight('BRA','red',0,0.25,True,True,'BRAZIL')",
]) test(`overlay review bypass refused: ${bypass}`,()=>{
 assert.deepEqual(validateBuildScript(base,{nframes:90,shotStarts:[0],overlay:true,overlaySpec:spec}),[]);
 assert.ok(validateBuildScript(base+'\n'+bypass,{nframes:90,shotStarts:[0],overlay:true,overlaySpec:spec}).length);
 assert.deepEqual(validateBuildScript(base+'\n'+bypass,{nframes:90,shotStarts:[0]}),[]);
});
test('overlay accepts literal non-text object and curve constructors and unlabelled maps',()=>{
 assert.deepEqual(overlayScriptProblems(good+"\nbpy.ops.object.add(type='MESH')\nbpy.data.curves.new('path',type='CURVE')\nwm.highlight('BRA',label=False)\nwm.highlight_group(['BRA'])",spec),[]);
});

for (const dur of [undefined,'30',null,NaN,Infinity,-Infinity,0,-1,Number.MAX_VALUE]) test(`overlay staging rejects invalid duration ${String(dur)}`,()=>{
 const paths=jobPaths(root,'bad-dur-'+crypto.randomUUID()); ensureJobFolder(paths);
 const wav=path.join(paths.work,'source.wav'); fs.writeFileSync(wav,'wav');
 assert.throws(()=>writeInputs(paths,{script:'hello',brief:'brief',voWav:wav,words:{dur},pathPack:pack,overlaySpec:{version:1,tag:{text:'X',from:0,to:9999}}},[root]),e=>e.code==='BAD_JOB');
 assert.equal(fs.existsSync(path.join(paths.inputs,'overlay.json')),false);
});
test('overlay staging enforces exact frame-rounded time bound',()=>{
 const paths=jobPaths(root,'time-bound'); ensureJobFolder(paths);
 const wav=path.join(paths.work,'source.wav'); fs.writeFileSync(wav,'wav');
 const req={script:'hello',brief:'brief',voWav:wav,words,pathPack:pack,overlaySpec:{version:1,tag:{text:'X',from:0,to:3.001}}};
 assert.throws(()=>writeInputs(paths,req,[root]),e=>e.code==='bad_time');
 assert.ok(writeInputs(paths,{...req,overlaySpec:{version:1,tag:{text:'X',from:0,to:3}}},[root])['overlay.json']);
});
test('overlay repairs only JSON with at most two attempts',async()=>{
 const prompts=[];
 const result=await planCodebuiltBuild(planInput,{...deps,askFn:async prompt=>{
  prompts.push(prompt);
  return {text:prompts.length===1 ? '```python\n'+base+'```' : '```json\n{"version":1}\n```'};
 }});
 assert.equal(prompts.length,2);
 assert.match(prompts[0],/stage\.Camera/);
 assert.match(prompts[0],/shotcheck\.run_qa/);
 assert.match(prompts[0],/5\. Render the FINAL profile/);
 assert.doesNotMatch(prompts[0],/stage\.(?:text|hud_text|hud|fit_text)\(/);
 assert.doesNotMatch(prompts[0],/\.label\(|\.callout\(|readout text|label\s*=/i);
 assert.match(prompts[1],/Reply with one json block only/);
 assert.equal(result.overlaySpec.version,1);
 assert.equal(result.buildScript,base);
 let count=0;
 await assert.rejects(()=>planCodebuiltBuild(planInput,{...deps,askFn:async()=>{count++;return {text:count===1 ? '```python\n'+base+'```' : '```json\n{}\n```'};}}),e=>e.code==='BAD_OVERLAY');
 assert.equal(count,3);
});
test('overlay inputs are write-once and hashed, including unexpected injection',()=>{
 fs.mkdirSync(root,{recursive:true});
 const paths=jobPaths(root,'overlay-'+Date.now());ensureJobFolder(paths);
 const wav=path.join(paths.work,'source.wav');fs.writeFileSync(wav,'wav');
 const request={script:'hello',brief:'brief',voWav:wav,words,pathPack:pack,overlaySpec:{version:1}};
 const hashes=writeInputs(paths,request,[root]);
 assert.ok(hashes['overlay.json']);verifyInputs(paths,hashes);
 assert.deepEqual(writeInputs(paths,request,[root]),hashes);
 assert.throws(()=>writeInputs(paths,{...request,overlaySpec:{version:1,tag:{text:'X',from:0,to:1}}},[root]),e=>e.code==='INPUT_CHANGED');
 const file=path.join(paths.inputs,'overlay.json');fs.chmodSync(file,0o644);fs.writeFileSync(file,'{}');
 assert.throws(()=>verifyInputs(paths,hashes),e=>e.code==='INPUT_CHANGED');
 const legacy=jobPaths(root,'legacy-'+Date.now());ensureJobFolder(legacy);
 const {overlaySpec,...old}=request;const oldHashes=writeInputs(legacy,old,[root]);
 assert.equal(oldHashes['overlay.json'],undefined);
 fs.writeFileSync(path.join(legacy.inputs,'overlay.json'),'{}');
 assert.throws(()=>verifyInputs(legacy,oldHashes),e=>e.code==='INPUT_CHANGED');
});

import {createCodebuiltStarter} from '../episode/codebuilt/start.js';
import {checkRunRequest} from '../episode/codebuilt/runCoordinator.js';
test('request formats survive coordinator and typed journey cannot skip gate',()=>{
 assert.deepEqual(checkRunRequest({count:1,formats:['journey','journey','Bad!']}).formats,['journey']);
 const starter=createCodebuiltStarter({jobsDir:root,newId:()=> 'must-not-start'});
 assert.throws(()=>starter.start({topic:'A typed journey',duration:30,formats:['journey']}),e=>e.code==='bad_request');
 assert.throws(()=>starter.start({topic:'A typed teardown',duration:30,type:'teardown',formats:['journey']}),e=>e.code==='bad_request');
});

import {createCodebuiltRunCoordinator} from '../episode/codebuilt/runCoordinator.js';
test('coordinator gates a typed journey, forwards formats and premise, and ignores profile-only journey for teardown',async()=>{
 for(const kind of ['explicit','profile','teardown-profile','teardown-explicit']) {
  const teardown=kind.startsWith('teardown');
  const channel={id:'channel',video_types:[teardown?'teardown':'factual'],profile:{formats:kind.includes('profile')?['journey']:[]}};
  let picked=null;let started=null;
  const runsDir=path.join(root,'coordinator-'+kind+'-'+Date.now());
  const coord=createCodebuiltRunCoordinator({runsDir,getChannel:()=>channel,getChannels:()=>[channel],
   pickTopic:async input=>{picked=input;return {topic:'A gated journey',ranked:1,premise:{formats:['journey'],thing:'A probe'}};},
   starter:{start(input,internal){started={input,internal};return {id:'mock-job',step:'queued'};},get(){return {id:'mock-job',status:'done',step:'done',duration:30};}},
  });
  const run=coord.startRun({count:1,topic:'A typed topic',type:teardown?'teardown':'factual',duration:30,voice:'aiden',...(kind.includes('explicit')?{formats:['journey']}:{})});
  await coord.idle();
  if(kind==='teardown-explicit') {assert.equal(started,null);assert.equal(picked,null);continue;}
  assert.ok(started,JSON.stringify(coord.getRun(run.id)));
  if(kind==='teardown-profile') {assert.equal(picked,null);assert.equal(started.internal.premise,undefined);}
  else {assert.ok(picked);assert.equal(picked.inspiration,'A typed topic');assert.deepEqual(started.internal.premise.formats,['journey']);}
  if(kind==='explicit') {assert.deepEqual(picked.formats,['journey']);assert.deepEqual(started.input.formats,['journey']);}
 }
});

test('overlay allows the ready-set import the map and teardown skills show, nothing else under the kit package',()=>{
 assert.deepEqual(overlayScriptProblems('from blender_worker.codebuilt.sets import world_map\n'+good,spec),[]);
 assert.deepEqual(overlayScriptProblems('from blender_worker.codebuilt.sets import stealth_jet_teardown as jet_set\n'+good,spec),[]);
 for(const code of ['from blender_worker.codebuilt.stage import text','from blender_worker.codebuilt.sets.world_map import build','from blender_worker.codebuilt.sets import *','from blender_worker.codebuilt.sets import anchors','from blender_worker.codebuilt.sets import stage as s']) assert.ok(overlayScriptProblems(code+'\n'+good,spec).length,code);
});
