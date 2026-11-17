// codex · gpt-6.1-sol · 2026-11-17 17:25 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCodebuiltStarter, START_VERSION } from './start.js';
import { jobUsesOverlay } from './overlaySpec.js';
import { createBuildJobRunner } from '../engines/codebuilt/runner.js';
import { normaliseScript } from '../voice.js';
import { createHostOutputProducer } from '../engines/codebuilt/producer.js';
import { hostExecFile } from './hostEffects.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function wavFixture() {
  const rate = 16000; const frames = rate * 30; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = Math.floor(rate * 0.3); i < Math.floor(rate * 29.8); i += 1) bytes.writeInt16LE(4000, 44 + i * 2);
  return bytes;
}


for (const scenario of ['missing','stale','invalid','preview-failure','final-failure','classic']) test(`real overlay resume: ${scenario}`, async () => {
  const root = path.resolve(fileURLToPath(new URL('../../../../',import.meta.url)),'output/agent-jobs/u1a/test-' + scenario + '-' + crypto.randomBytes(4).toString('hex'));
  const id = 'pair-resume'; const state = path.join(root,'.start',id); const loop = path.join(state,'loop','r1');
  fs.mkdirSync(loop,{recursive:true});
    const script = 'The careful narration validates every measured word boundary before saved scene code continues after a paused job resumes safely today';
    const brief = '# Cached brief';
    const overlay = true;
    const pathPack = { id: 'codebuilt', skills: [], ...(overlay ? {rules:{formats:{journey:{overlay:true}}}} : {}) };
    const newBuild = "from blender_worker.codebuilt import anchors\ndef shot(t):\n anchors.mark('new_point',(0,0,0))\n";
    const overlaySpec = {version:1,labels:[{anchor:'new_point',title:'NEW',from:0,to:1,side:'left'}]};
    const wav = wavFixture();
    fs.writeFileSync(path.join(state, 'script.txt'), script);
    fs.writeFileSync(path.join(state, 'brief.md'), brief);
    fs.writeFileSync(path.join(state, 'pathpack.json'), JSON.stringify(pathPack));
    fs.writeFileSync(path.join(state, 'vo.wav'), wav);
    const tokens = normaliseScript(script).words;
    const weights = tokens.map((word, i) => word.length * (i % 3 === 0 ? 1 : i % 3 === 1 ? 1.31 : 0.78));
    const total = 28.54; const sum = weights.reduce((a, b) => a + b, 0); let cursor = 0.3;
    const timed = tokens.map((word, i) => { const s = cursor; const e = s + total * weights[i] / sum; cursor = e + 0.04; return { w: word, s: Number(s.toFixed(3)), e: Number(e.toFixed(3)) }; });
    timed[timed.length - 1].e = 29.6;
    fs.writeFileSync(path.join(state, 'words.json'), JSON.stringify({ dur: 30, words: timed }));
    fs.writeFileSync(path.join(state, 'voice.json'), JSON.stringify({ script_sha256: hash(normaliseScript(script).text), audio_sha256: hash(wav), word_timing_source: 'aligned', video_seconds: 30 }));
    const cachedBuild = 'cached loop-produced build source';
    fs.writeFileSync(path.join(loop, 'build.py'), cachedBuild);
    if (scenario !== 'missing') fs.writeFileSync(path.join(loop, 'overlay.json'), JSON.stringify({version:1,build_sha256:hash(scenario === 'stale' ? 'other code' : cachedBuild),spec:scenario === 'invalid' ? {version:2} : overlaySpec}));

  fs.writeFileSync(path.join(state,'planner-plan.json'),JSON.stringify({nframes:955,shotStarts:[0],places:['room']}));
  const classic = scenario === 'classic';
  if (classic) fs.writeFileSync(path.join(state,'pathpack.json'),JSON.stringify({id:'codebuilt',skills:[]}));
  fs.writeFileSync(path.join(state,'status.json'),JSON.stringify({version:START_VERSION,id,topic:'Resume pair',duration:30,voice:'aiden',...(classic?{}:{formats:['journey']}),status:'failed',step:'looking',steps:[]}));
  let plans=0; let finals=0; let looks=0; const previewIds=[];
  const runner=createBuildJobRunner({root,inputRoots:[state],produceOutputs:createHostOutputProducer({execFileFn:hostExecFile}),runIsolatedJob:async ({jobDir})=>{
    if (fs.existsSync(path.join(jobDir,'work','preview.json'))) {
      previewIds.push(path.basename(jobDir));
      if (scenario === 'preview-failure' && previewIds.length === 1) return {status:'contained_violation'};
      const spec=JSON.parse(fs.readFileSync(path.join(jobDir,'work','preview.json')));
      const out=path.join(jobDir,'preview'); fs.mkdirSync(out,{recursive:true});
      execFileSync('python',['-c',`from PIL import Image; import sys,json,pathlib; d=pathlib.Path(sys.argv[1]); frames=json.loads(sys.argv[2]); im=Image.effect_noise((540,960),80).convert('RGB'); [im.save(d/('%04d.png'%f)) for f in frames]`,out,JSON.stringify(spec.frames)]);
      fs.writeFileSync(path.join(jobDir,'work','anchors-preview.json'),JSON.stringify({version:1,width:540,height:960,frames:Object.fromEntries(spec.frames.map(f=>[String(f),{p:{new_point:[0.7,0.35,1]},v:{}}]))}));

      return {status:'ok',ok:true};
    }
    finals++; return {status:'failed'};
  }});
  if (['missing','stale','invalid'].includes(scenario)) {
    await runner.run({jobId:id+'-a0-pv1',kind:'generated-code',mode:'preview',script,brief,voWav:path.join(state,'vo.wav'),words:path.join(state,'words.json'),pathPack,buildScript:cachedBuild,overlaySpec:{version:1,tag:{text:'OLD',from:0,to:1}},previewFrames:[0],previewScale:50,timeoutMs:30000});
  }
  const priorPreviewCount=previewIds.length;
  const starter=createCodebuiltStarter({jobsDir:root,episodesRoot:path.join(root,'episodes'),planner:{KIT_CONTRACT:'kit',validateBuildScript:()=>[],planCodebuiltBuild:async()=>{plans++;return {buildScript:newBuild,overlaySpec,shotStarts:[0],nframes:955,places:['room']};}},validateReusableBuild:()=>[],composeRunner:async()=>({runner}),visualLoop:{probe:async()=>({passed:true}),askLook:async(text,images)=>(looks++,{text:JSON.stringify({verdict:'pass',sheet_codes:[...new Set([...text.matchAll(/code in its header: ([A-Z0-9]{5})/g)].map(m=>m[1]))],shots:[{id:'shot-0',sees:'Visible subject and camera.',ok:true}],findings:[]}),receipt:{noSessionPersistence:true,toolsOffered:0,transport:'stdin-image-blocks',imageCount:images.length,imageSha256:images.map(i=>hash(i.bytes)),promptSha256:hash(text)}})}});
  const first=starter.resume(id); await starter.idle();
  assert.equal(first.resumes.at(-1).fromStep, ['missing','stale','invalid'].includes(scenario)?'planning':'visual_loop');
  assert.equal(plans,['missing','stale','invalid'].includes(scenario)?1:0);
  assert.equal(starter.get(id).error?.code,scenario === 'preview-failure' || classic?'preview_failed':'build_failed');
  if (!classic) {
    assert.ok(previewIds.length>priorPreviewCount);
    assert.ok(previewIds.slice(priorPreviewCount).every(id=>id.includes('-a1-pv')),'first resume carries attempt 1 independently of round numbering');
    const roundDirs=fs.readdirSync(path.join(state,'loop')).filter(n=>/^r[0-9]+$/.test(n));
    for (const name of roundDirs) {
      const dir=path.join(state,'loop',name); if(name==='r1' && ['missing','stale','invalid'].includes(scenario)) continue;
      const pair=JSON.parse(fs.readFileSync(path.join(dir,'overlay.json'))); assert.equal(pair.build_sha256,hash(fs.readFileSync(path.join(dir,'build.py')))); assert.equal(pair.version,1);
    }
    if(scenario !== 'preview-failure') {
      const pair=JSON.parse(fs.readFileSync(path.join(state,'loop','accepted.overlay.json'))); assert.equal(pair.build_sha256,hash(fs.readFileSync(path.join(state,'loop','accepted.build.py'))));
      const acceptedLooks=looks;
      starter.resume(id); await starter.idle(); assert.equal(finals,2,'retry reaches real runner with identical accepted inputs'); assert.equal(starter.get(id).error?.code,'build_failed');
      assert.equal(looks,acceptedLooks,'accepted final retry reuses receipt without another look');
    } else {starter.resume(id);await starter.idle();assert.equal(new Set(previewIds).size,previewIds.length);}
    assert.ok(previewIds.every(id=>/-a[012]-pv[0-9]+$/.test(id)));
  } else assert.ok(previewIds.every(id=>!/-a[0-9]+-pv/.test(id)));
});

test('overlay decisions include explicit routes and format packs',()=>{assert.equal(jobUsesOverlay({},[]),false);for(const route of ['overlay','authored'])assert.equal(jobUsesOverlay({},[],route),true);assert.equal(jobUsesOverlay({rules:{formats:{journey:{overlay:true}}}},['journey'],'classic'),true);});

test('an attempt preview quarantine blocks resume before reading a pair', () => {
  const root = path.resolve(fileURLToPath(new URL('../../../../',import.meta.url)), 'output/agent-jobs/u1a/lock-' + crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(path.join(root,'.start','locked'),{recursive:true});
  fs.mkdirSync(path.join(root,'.cb6-locks'));
  fs.writeFileSync(path.join(root,'.start','locked','status.json'),JSON.stringify({id:'locked',status:'failed'}));
  fs.writeFileSync(path.join(root,'.cb6-locks','locked-a2-pv1.lock'),'{}');
  const starter = createCodebuiltStarter({jobsDir:root});
  assert.equal(starter.get('locked').resumable,false);
  assert.throws(()=>starter.resume('locked'),error=>error.code === 'conflict');
});
