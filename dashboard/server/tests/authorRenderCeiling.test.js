// codex - gpt-6.1-sol - 2026-11-18 11:56 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAuthorFor } from '../episode/codebuilt/authorLoop.js';
import { hash, authorArgv } from '../episode/codebuilt/authorCall.js';
const root='C:/code/ForgeAi/output/agent-jobs/n2-render-ceiling';
const spec={version:1}; const code='# scene\n# camera\n# light\n# material\n# world\n# setup\n# timeline\n# layers\n# reusable mesh\n# framing\ndef shot_0(t):\n    pass\n';
const look=(verdict='pass',codes=['ABCDE'])=>JSON.stringify({look:{sheet_codes:codes,verdict,shots:[{id:'shot-0',sees:'The subject fills the frame.',ok:true}],findings:verdict==='fix'?[{severity:'P1',issue:'Needs a better camera.'}]:[],targets:[],edits:[]},notes:'Remember the subject.'});
function rig(overrides={},hooks={}) {
 const stage=fs.mkdtempSync(path.join(root,'loop-')); let previews=0,sheets=0,calls=0,now=0;
 const input={jobId:'test',stageDir:stage,measurementMode:true,probe:{passed:true},writePrompt:'Write code',brief:'brief',script:'script',kitContract:'kit',shots:[{subject:'subject',narration:'words'}],shotStarts:[0],nframes:900,validate:()=>[],...overrides};
 const deps={now:()=>now,newCode:()=> 'ABCDE',runPreview:async()=>{previews++; hooks.preview?.(()=>{now=3660001;});const dir=path.join(stage,'frames');fs.mkdirSync(dir,{recursive:true});return {dir,frames:[{name:'1.png',sha256:'frame'}]};},makeSheets:async({outDir})=>{sheets++;hooks.sheet?.(()=>{now=3660001;});fs.mkdirSync(outDir,{recursive:true});const p=path.join(outDir,'sheet.jpg');fs.writeFileSync(p,'pixels');return [{path:p,code:'ABCDE',sha256:hash('pixels'),tiles:[{n:1,frame:1}]}];},askAuthor:async(prompt,images)=>{calls++;hooks.call?.(()=>{now=3660001;},calls);return {text:calls===1?'```python\n'+code+'```\n```json\n'+JSON.stringify(spec)+'\n```':(hooks.reply?.(calls)??look()),rawUsage:hooks.usage??{input_tokens:10,output_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0},receipt:{argvSha256:hash(JSON.stringify(authorArgv())),promptSha256:hash(prompt),imageSha256:images.map(i=>hash(i.bytes)),imageCount:images.length,noSessionPersistence:true,toolsOffered:0,transport:'stdin-image-blocks'}};},...hooks.deps};
 return {input,deps,stage,counts:()=>({previews,sheets,calls})};
}
import {createCodebuiltStarter} from '../episode/codebuilt/start.js';
test('D2 ceiling stops final render above 90 minutes, permits equality, and fails closed without timing',async t=>{
 for (const c of [
  {name:'above', ceiling:90, timing:{render_s:1350.25,rendered:900}, error:'author_render_over_ceiling'},
  {name:'last preview above despite earlier below', ceiling:90, firstTiming:100, timing:{render_s:1350.25,rendered:900},error:'author_render_over_ceiling'},
  {name:'last preview below despite earlier above', ceiling:90, firstTiming:2000, timing:{render_s:100,rendered:900}},
  {name:'equal', ceiling:90, timing:{render_s:1350,rendered:900}},
  {name:'below', ceiling:90, timing:{render_s:1349.75,rendered:900}},
  {name:'absent ceiling', timing:{render_s:2000,rendered:900}},
  {name:'missing timing', ceiling:90, error:'author_render_over_ceiling', reason:'render_timing_unavailable'},
  {name:'no ceiling and no timing'},
  {name:'invalid timing', ceiling:90, timing:{render_s:-1,rendered:900}, error:'author_render_over_ceiling', reason:'render_timing_unavailable'},
 ]) await t.test(c.name,async t=>{ 
 const r=rig({}, {reply:n=>{
  if(c.firstTiming&&n===2){const body=JSON.parse(look('fix'));body.look.targets=['shot_0'];body.look.edits=[{op:'replace_def',name:'shot_0',source:'def shot_0(t):\n    pass'}];return JSON.stringify(body);}
  return look();
 }}),prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';let finals=0,drafts=0;
 const config=path.join(root,'starter-config');fs.mkdirSync(config,{recursive:true});
 const capsFile=path.join(r.stage,'caps.json');fs.writeFileSync(capsFile,JSON.stringify({measuredAt:'2026-11-17',cliVersion:'2.1.322',model:'sonnet',runs:[{previews:3},{previews:3},{previews:3}],caps:{billableTotal:1472004,contextPeak:900000},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}}));
 const preview=r.deps.runPreview;
 r.deps.runPreview=async req=>{const result=await preview(req);const timing=c.firstTiming&&r.counts().previews===1?{render_s:c.firstTiming,rendered:900}:c.timing;if(timing){const work=path.join(path.dirname(result.dir),'work');fs.mkdirSync(work,{recursive:true});fs.writeFileSync(path.join(work,'render-timing.json'),JSON.stringify(timing));}return result;};
 const pack={id:'codebuilt',skills:[],rules:{routes:{overlay:{render:{RENDER_BUDGET_S_PER_FRAME:1.5,...(c.ceiling===undefined?{}:{maxFinalMinutes:c.ceiling})}}}}};
 const options={jobsDir:r.stage,newId:()=> 'journey-author',episodesRoot:r.stage,planner:{planCodebuiltScript:async()=>({script:'The drill stops.',brief:'A deep hole.',pathPack:pack,shots:[{subject:'A drill',narration:'The drill stops.'}]}),planCodebuiltDirection:async()=>({direction:{narrations:['The drill stops.'],places:[{id:'p1',base:'custom',what:'rock'}],shots:[{place:'p1',shows:'drill',action:'turns',camera:'follows'}]},shotStarts:[0]}),authorBuildPrompt:()=> 'Write code',KIT_CONTRACT:'kit',frameCountFor:()=>900,validateBuildScript:()=>[],pythonSyntaxCheck:()=>null,pythonQaStructureCheck:()=>[],planCodebuiltBuild:async()=>{throw Error('must not call classic build');}},voiceStage:async({outDir})=>{const voPath=path.join(outDir,'vo.wav'),wordsPath=path.join(outDir,'words.json'),manifestPath=path.join(outDir,'voice.json');fs.writeFileSync(voPath,'fixture');fs.writeFileSync(wordsPath,JSON.stringify({dur:28,words:[]}));fs.writeFileSync(manifestPath,JSON.stringify({video_seconds:30}));return {voPath,wordsPath,manifestPath};},factCheckStage:async()=>({verified:true}),composeRunner:async()=>({runner:{run:async req=>{finals++;fs.mkdirSync(path.join(r.stage,req.jobId),{recursive:true});assert.equal(req.route,'authored');assert.equal(req.buildScript,code);assert.equal(req.overlaySpec.version,1);}}}),authorLoop:{...r.deps,capsFile,repoRoot:'C:/code/ForgeAi',configDir:config,probe:async()=>({passed:true}),sheetMaker:{makeSheets:r.deps.makeSheets}},lightMetadataStage:async()=>({}),toDraft:()=>{drafts++;return {id:'fake-draft'};}};
 const starter=createCodebuiltStarter(options);
 const premise={formats:['journey'],thing:'drill',move:'down',story_question:'How deep can it go?',ending_answer:'The drill gets too hot.',turn:'Then it stops',who:'The drillers',want:'Reach the mantle',landmarks:['one','two','three'],counter:{what:'depth',unit:'km'},last_number:12};
 try{const job=starter.start({topic:'Drill',duration:30,route:'authored',formats:['journey']},{factCheck:true,runId:'batch',premise});await starter.idle();const result=starter.get(job.id);
 if(c.error){
 await t.test('adapter throws approved code on accepted retry',async()=>{
  const stage=path.join(r.stage,'.start',job.id);
  await assert.rejects(runAuthorFor({rec:result,stage,scripted:{script:'The drill stops.',brief:'A deep hole.'},voice:{wordsPath:path.join(stage,'words.json')},pathPack:pack,pl:options.planner,runtime:{},jobsDir:r.stage,injected:options.authorLoop}),error=>error.code===c.error&&(!c.reason||error.detail?.reason===c.reason));
 });
 await t.test('no final render or draft',()=>{assert.equal(finals,0);assert.equal(drafts,0);});assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(result.error.code,c.error);}
 else {assert.equal(result.status,'done',JSON.stringify(result.error));assert.equal(finals,1);assert.equal(drafts,1);}}finally{await starter.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
 });
});
