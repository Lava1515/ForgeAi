// codex - gpt-6.1-sol - 2026-11-17 22:59 +02:00: A1 transport, caps and authored route regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAuthorLoop, verifyAuthorReceipt } from '../episode/codebuilt/authorLoop.js';
import { hash, authorArgv } from '../episode/codebuilt/authorCall.js';
const root=path.resolve(import.meta.dirname,'../../../output/agent-jobs/a1-fix1');
fs.mkdirSync(root,{recursive:true});
const spec={version:1}; const code='# scene\n# camera\n# light\n# material\n# world\n# setup\n# timeline\n# layers\n# reusable mesh\n# framing\ndef shot_0(t):\n    pass\n';
const look=(verdict='pass',codes=['ABCDE'])=>JSON.stringify({look:{sheet_codes:codes,verdict,shots:[{id:'shot-0',sees:'The subject fills the frame.',ok:true}],findings:verdict==='fix'?[{severity:'P1',issue:'Needs a better camera.'}]:[],targets:[],edits:[]},notes:'Remember the subject.'});
// claude-pro · claude-sonnet-5-5 · 2026-11-18 17:55 +02:00: the loop now needs a layout check; this stub reports a clean layout bound to the exact files it was given.
const fakeLayout=async({overlaySpec,words,anchors,nframes})=>({version:1,ok:true,framesChecked:nframes,fps:30,previewFrames:1,anchoredFrames:0,blocking:[],labelHidden:[],inputs:{overlaySha256:hash(fs.readFileSync(overlaySpec)),anchorsSha256:anchors?hash(fs.readFileSync(anchors)):null,wordsSha256:words?hash(fs.readFileSync(words)):null}});
function rig(overrides={},hooks={}) {
 const stage=fs.mkdtempSync(path.join(root,'loop-')); let previews=0,sheets=0,calls=0,now=0;
 const input={jobId:'test',stageDir:stage,measurementMode:true,probe:{passed:true},writePrompt:'Write code',brief:'brief',script:'script',kitContract:'kit',shots:[{subject:'subject',narration:'words'}],shotStarts:[0],nframes:900,validate:()=>[],...overrides};
 const deps={now:()=>now,layoutCheck:fakeLayout,newCode:()=> 'ABCDE',runPreview:async()=>{previews++; hooks.preview?.(()=>{now=3660001;});const dir=path.join(stage,'frames');fs.mkdirSync(dir,{recursive:true});return {dir,frames:[{name:'1.png',sha256:'frame'}]};},makeSheets:async({outDir})=>{sheets++;hooks.sheet?.(()=>{now=3660001;});fs.mkdirSync(outDir,{recursive:true});const p=path.join(outDir,'sheet.jpg');fs.writeFileSync(p,'pixels');return [{path:p,code:'ABCDE',sha256:hash('pixels'),tiles:[{n:1,frame:1}]}];},askAuthor:async(prompt,images)=>{calls++;hooks.call?.(()=>{now=3660001;},calls);return {text:images.length===0?'```python\n'+code+'```\n```json\n'+JSON.stringify(spec)+'\n```':(hooks.reply?.(calls)??look()),rawUsage:hooks.usage??{input_tokens:10,output_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0},receipt:{argvSha256:hash(JSON.stringify(authorArgv())),promptSha256:hash(prompt),imageSha256:images.map(i=>hash(i.bytes)),imageCount:images.length,noSessionPersistence:true,toolsOffered:0,transport:'stdin-image-blocks'}};},...hooks.deps};
 return {input,deps,stage,counts:()=>({previews,sheets,calls})};
}
test('accept exact stored pair, preserve attempt and verify second receipt',async()=>{const r=rig(); const out=await runAuthorLoop(r.input,r.deps);assert.equal(out.accepted,true);assert.equal(out.buildScript,code);verifyAuthorReceipt(out,r.input);const journal=fs.readFileSync(path.join(r.stage,'author/a0/journal.jsonl'),'utf8');assert.ok(!journal.includes(r.stage));fs.appendFileSync(path.join(r.stage,'author/accepted.build.py'),'x');assert.throws(()=>verifyAuthorReceipt(out,r.input));});
test('sixth preview never starts; never unapproved',async()=>{const r=rig({}, {reply:n=>{const r=JSON.parse(look('fix')); if(n<6){r.look.targets=['shot_0'];r.look.edits=[{op:'replace_def',name:'shot_0',source:'def shot_0(t):\n    pass'}];}return JSON.stringify(r);}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_rounds'});assert.equal(r.counts().previews,5);});
for(const step of ['call','preview','sheet'])test(`minute 61 stops before next action after ${step}`,async()=>{const r=rig({}, {[step]:(expire)=>expire()});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_time'});assert.equal(r.counts()[step==='call'?'previews':step==='preview'?'sheets':'calls'],step==='sheet'?1:0);});
test('reserve blocks before call',async()=>{const r=rig({caps:{billableTotal:1,contextPeak:900000}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_tokens'});assert.equal(r.counts().calls,0);});
test('measured caps mandatory outside explicit harness mode',async()=>{const r=rig({measurementMode:false,capsFile:path.join(root,'nonexistent')});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_caps_unmeasured'});});
test('usage above context cap stops before preview',async()=>{const r=rig({}, {usage:{input_tokens:900001,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_context_full'});assert.equal(r.counts().previews,0);});
test('wrong sheet codes exhaust shared repairs, no accepted pair',async()=>{const r=rig({}, {reply:()=>look('pass',['WRONG'])});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_reply'});assert.equal(r.counts().calls,5);assert.ok(!fs.existsSync(path.join(r.stage,'author/accepted.build.py')));});
test('invalid name pair is never previewed',async()=>{const r=rig({validate:()=>['names must all be marked']});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_reply'});assert.equal(r.counts().previews,0);});

// codex · gpt-6.1-sol · 2026-11-17 22:46 +02:00: integration and failure regressions.
import {runAuthorFor} from '../episode/codebuilt/authorLoop.js';
test('accepted resume makes no call; lost sheet starts fresh W with new attempt',async()=>{const r=rig();const out=await runAuthorLoop(r.input,r.deps);const before=r.counts();await runAuthorLoop(r.input,r.deps);assert.deepEqual(r.counts(),before);fs.unlinkSync(path.join(r.stage,'author/a0/r0/sheets/sheet-0.jpg'));const next=rig();await assert.rejects(runAuthorLoop(r.input,{...next.deps,askAuthor:async()=>{throw Object.assign(Error(),{code:'stopped'});}}),{code:'stopped'});assert.ok(fs.existsSync(path.join(r.stage,'author/a1/write')));});
test('one character changed between pass and return is refused',async()=>{const r=rig({}, {reply:()=>{fs.appendFileSync(path.join(r.stage,'author/a0/r0/build.py'),'x');return look();}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_hash'});assert.ok(!fs.existsSync(path.join(r.stage,'author/accepted.build.py')));});
test('passing reply over token cap fails before accepted output',async()=>{const r=rig({caps:{billableTotal:50000}}, {usage:{input_tokens:50001,output_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_tokens'});assert.equal(r.counts().previews,0);});
test('invalid replacement overlay and scoped edits are refused atomically',async()=>{let refused=false;const r=rig({validate:(c,s)=>s.labels?.length?['unmarked point']:[]},{reply:n=>{if(n===2){const body=JSON.parse(look('fix'));body.look.targets=['shot_0'];body.look.edits=[{op:'replace_def',name:'shot_0',source:'def shot_0(t):\n    x = 7'}];body.overlay={version:1,labels:[{anchor:'missing',title:'Name',from:0,to:1}]};return JSON.stringify(body);} refused=true;return look();}});const out=await runAuthorLoop(r.input,r.deps);assert.ok(refused);assert.equal(out.buildScript,code);assert.equal(out.overlaySpec.labels.length,0);assert.equal(r.counts().previews,1);});
test('author helper passes exact current overlay to preview and reuses accepted on final retry',async()=>{
 const r=rig();const prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';
 const config=path.join(root,'adapter-config');fs.mkdirSync(config,{recursive:true});
 const capsFile=path.join(r.stage,'measured.json');fs.writeFileSync(capsFile,JSON.stringify({measuredAt:'2026-11-17',cliVersion:'2.1.322',model:'sonnet',runs:[{previews:3},{previews:3},{previews:3}],caps:{billableTotal:1472004,contextPeak:900000},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}}));
 const wordsPath=path.join(r.stage,'words.json');fs.writeFileSync(wordsPath,JSON.stringify({dur:28,words:[]}));let directions=0,previews=0;
 const input={rec:{id:'adapter',topic:'Journey',duration:30,route:'authored',formats:['journey']},stage:r.stage,signal:new AbortController().signal,scripted:{script:'narration',brief:'brief'},voice:{wordsPath},pathPack:{rules:{routes:{overlay:{render:{RENDER_BUDGET_S_PER_FRAME:1.5}}}}},jobsDir:r.stage,runtime:{runner:{}},pl:{planCodebuiltDirection:async()=>{directions++;return {direction:{narrations:['spoken'],places:[{id:'p1',base:'custom',what:'world'}],shots:[{place:'p1',shows:'subject',action:'moves',camera:'orbit'}]},shotStarts:[0]};},frameCountFor:()=>900,authorBuildPrompt:()=> 'Write code',validateBuildScript:()=>[],pythonSyntaxCheck:()=>null,pythonQaStructureCheck:()=>[]},injected:{...r.deps,capsFile,repoRoot:path.resolve(import.meta.dirname,'../../..'),configDir:config,probe:async()=>({passed:true}),runPreview:async req=>{previews++;assert.equal(req.route,'authored');assert.equal(req.overlaySpec.version,1);return r.deps.runPreview(req);},sheetMaker:{makeSheets:r.deps.makeSheets}}};
 try{const out=await runAuthorFor(input);out.verifyReceipt();assert.equal(out.accepted,true);await runAuthorFor(input);assert.equal(directions,1);assert.equal(previews,1);}finally{if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});
import {createCodebuiltStarter} from '../episode/codebuilt/start.js';
import {authorBuildPrompt, loadCodebuiltPathPack} from '../episode/codebuilt/planner.js';
test('author build prompt carries word times, overlay rules, RL1 profile and author guidance',()=>{
 const pack=loadCodebuiltPathPack();
 const prompt=authorBuildPrompt({topic:'A drill',duration:30,script:'The drill stops.',brief:'A deep hole',words:{dur:28,words:[{w:'drill',s:1,e:1.5}]},pathPack:pack,nframes:900,shotStarts:[0],formats:['journey']});
 assert.match(prompt,/drill@1.00-1.50/);assert.match(prompt,/RL1 render profile/);assert.match(prompt,/one python block and one json block only; no notes/);assert.match(prompt,/67-79%/);assert.match(prompt,/Code-built author/);assert.doesNotMatch(prompt,/\.callout\(|stage\.text\(/);
});
// claude-pro | claude-fable-5-2 | 2026-11-20: 'fail' is job mwo3d0mg-da7091, whose one repair failed after a finished render; the first video stays the draft.
for(const blackFinal of [false,true,'fail'])test(`authored final black=${blackFinal}: returns at most once before draft`,async()=>{
 const r=rig(),prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';let finals=0,drafts=0;const renderedIds=new Set();
 const config=path.join(root,'starter-config');fs.mkdirSync(config,{recursive:true});
 const capsFile=path.join(r.stage,'caps.json');fs.writeFileSync(capsFile,JSON.stringify({measuredAt:'2026-11-17',cliVersion:'2.1.322',model:'sonnet',runs:[{previews:3},{previews:3},{previews:3}],caps:{billableTotal:1472004,contextPeak:900000},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}}));
 const pack={id:'codebuilt',skills:[],rules:{routes:{overlay:{render:{RENDER_BUDGET_S_PER_FRAME:1.5}}}}};
 const starter=createCodebuiltStarter({jobsDir:r.stage,newId:()=> 'journey-author',episodesRoot:r.stage,planner:{planCodebuiltScript:async()=>({script:'The drill stops.',brief:'A deep hole.',pathPack:pack,shots:[{subject:'A drill',narration:'The drill stops.'}]}),planCodebuiltDirection:async()=>({direction:{narrations:['The drill stops.'],places:[{id:'p1',base:'custom',what:'rock'}],shots:[{place:'p1',shows:'drill',action:'turns',camera:'follows'}]},shotStarts:[0]}),authorBuildPrompt:()=> 'Write code',KIT_CONTRACT:'kit',frameCountFor:()=>900,validateBuildScript:()=>[],pythonSyntaxCheck:()=>null,pythonQaStructureCheck:()=>[],planCodebuiltBuild:async()=>{throw Error('must not call classic build');}},voiceStage:async({outDir})=>{const voPath=path.join(outDir,'vo.wav'),wordsPath=path.join(outDir,'words.json'),manifestPath=path.join(outDir,'voice.json');fs.writeFileSync(voPath,'fixture');fs.writeFileSync(wordsPath,JSON.stringify({dur:28,words:[]}));fs.writeFileSync(manifestPath,JSON.stringify({video_seconds:30}));return {voPath,wordsPath,manifestPath};},factCheckStage:async()=>({verified:true}),composeRunner:async()=>({runner:{run:async req=>{finals++;if(blackFinal==='fail'&&finals===2)throw Error('repair render died');assert.ok(!renderedIds.has(req.jobId),'a changed build must use a new fenced job');renderedIds.add(req.jobId);fs.mkdirSync(path.join(r.stage,req.jobId),{recursive:true});assert.equal(req.route,'authored');assert.equal(req.buildScript,code);assert.equal(req.overlaySpec.version,1);}}}),authorLoop:{...r.deps,checkFinalExposure:async()=>({tiles:[{issues:blackFinal?['black_region']:[]}],findings:blackFinal?['final-sheet tile 1 has a large black region']:[]}),capsFile,repoRoot:path.resolve(import.meta.dirname,'../../..'),configDir:config,probe:async()=>({passed:true}),sheetMaker:{makeSheets:r.deps.makeSheets}},lightMetadataStage:async()=>({}),toDraft:({jobId})=>{assert.equal(jobId,blackFinal===true?'journey-author-expose':'journey-author');drafts++;return {id:'fake-draft'};}});
 const premise={formats:['journey'],thing:'drill',move:'down',story_question:'How deep can it go?',ending_answer:'The drill gets too hot.',turn:'Then it stops',who:'The drillers',want:'Reach the mantle',landmarks:['one','two','three'],counter:{what:'depth',unit:'km'},last_number:12};
 try{const job=starter.start({topic:'Drill',duration:30,route:'authored',formats:['journey']},{factCheck:true,runId:'batch',premise});await starter.idle();assert.equal(starter.get(job.id).status,'done',JSON.stringify(starter.get(job.id).error));assert.equal(finals,blackFinal?2:1);assert.equal(drafts,1);assert.equal(starter.get(job.id).exposure_repair?.failed,blackFinal==='fail'?'build_failed':undefined);if(blackFinal===true){const state=JSON.parse(fs.readFileSync(path.join(r.stage,'.start',job.id,'author/session.json')));assert.equal(state.counters.calls,4);assert.equal(state.counters.billableTotal,80);}}finally{await starter.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});
test('adjusted missing-cache context cap blocks before preview',async()=>{const r=rig({}, {usage:{input_tokens:899999,output_tokens:0}});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_context_full'});assert.equal(r.counts().previews,0);});
test('oversized prompt refuses without CLI call',async()=>{const r=rig({writePrompt:'x'.repeat(200001)});await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_context_full'});assert.equal(r.counts().calls,0);});
test('missing usage charged full reserve and persisted before next action',async()=>{const r=rig();const ask=r.deps.askAuthor;r.deps.askAuthor=async(...args)=>{const reply=await ask(...args);delete reply.rawUsage;return reply;};const out=await runAuthorLoop(r.input,r.deps);const state=JSON.parse(fs.readFileSync(path.join(r.stage,'author/session.json'),'utf8'));assert.ok(out.calls.every(c=>c.usage.estimated&&c.usage.billable===c.reserve));assert.equal(state.counters.billableTotal,out.calls.reduce((s,c)=>s+c.reserve,0));});
test('spending over cap on passing look refuses accepted output',async()=>{const r=rig({caps:{billableTotal:70000}});const ask=r.deps.askAuthor;let calls=0;r.deps.askAuthor=async(...args)=>{const reply=await ask(...args);if(++calls===2)reply.rawUsage.input_tokens=80000;return reply;};await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_tokens'});assert.equal(r.counts().previews,1);assert.ok(!fs.existsSync(path.join(r.stage,'author/accepted.build.py')));});
test('altered delivery argv refuses before preview',async()=>{const r=rig();const ask=r.deps.askAuthor;r.deps.askAuthor=async(...args)=>{const reply=await ask(...args);reply.receipt.argvSha256='changed';return reply;};await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_receipt'});assert.equal(r.counts().previews,0);});
test('author state junction outside stage refused without an outside write',async()=>{const r=rig();const outside=fs.mkdtempSync(path.join(root,'outside-state-'));fs.symlinkSync(outside,path.join(r.stage,'author'),'junction');await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_state_outside_code'});assert.deepEqual(fs.readdirSync(outside),[]);});

// codex - gpt-6.1-sol - 2026-11-17 23:21 +02:00: actual reply / nonce / identity regressions.
for(const tamper of ['reply','nonce','rehash nonce'])test(`resume refuses ${tamper} evidence tamper`,async()=>{
 const r=rig(),out=await runAuthorLoop(r.input,r.deps),file=path.join(r.stage,'author/a0/r0/look.json'),j=JSON.parse(fs.readFileSync(file,'utf8'));
 if(tamper==='reply')j.reply.shots[0].sees='Different scene';else j.sheetCodes=j.reply.sheet_codes=['ZZZZZ'];
 if(tamper==='rehash nonce'){
  const replyFile=path.join(r.stage,'author/a0/r0/reply-1.txt'),body=JSON.parse(fs.readFileSync(replyFile,'utf8'));body.look.sheet_codes=['ZZZZZ'];
  const text=JSON.stringify(body);fs.writeFileSync(replyFile,text);j.call.replySha256=hash(text);
 }
 fs.writeFileSync(file,JSON.stringify(j));assert.throws(()=>verifyAuthorReceipt(out,r.input),{code:'author_hash'});
 let restarted=false;await assert.rejects(runAuthorLoop(r.input,{...r.deps,askAuthor:async()=>{restarted=true;throw Object.assign(Error(),{code:'stopped'});}}),{code:'stopped'});assert.equal(restarted,true);assert.ok(fs.existsSync(path.join(r.stage,'author/a1/write')));
});
for(const field of ['script','brief','words'])test(`accepted identity refuses changed ${field}`,async()=>{
 const r=rig();r.input.wordsPath=path.join(r.stage,'words.json');fs.writeFileSync(r.input.wordsPath,'[]');
 const out=await runAuthorLoop(r.input,r.deps);
 if(field==='words')fs.writeFileSync(r.input.wordsPath,'[1]');else r.input[field]+='changed';
 assert.throws(()=>verifyAuthorReceipt(out,r.input),{code:'author_hash'});
});
import {authorCaps} from '../episode/codebuilt/authorLoop.js';

// codex · gpt-6.1-sol · 2026-11-18 11:47 +02:00: C-7, real adapter must forward measurement mode.
test('adapter permits code-only measurement bootstrap but production still needs measured caps',async()=>{
 const {runAuthorFor}=await import('../episode/codebuilt/authorLoop.js');
 const stage=fs.mkdtempSync(path.join(root,'adapter-measure-'));
 const wordsPath=path.join(stage,'words.json');fs.writeFileSync(wordsPath,'[]');
 const cfg=path.join(stage,'config');fs.mkdirSync(cfg);
 const previous=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';
 const args={rec:{},stage,voice:{wordsPath},scripted:{script:'script'},injected:{repoRoot:path.resolve(import.meta.dirname,'../../..'),configDir:cfg,sheetMaker:{},capsFile:path.join(stage,'absent-caps.json')},pl:{planCodebuiltDirection:async()=>{throw Object.assign(Error('adapter reached'),{code:'measurement_adapter_reached'});}}};
 try {
  await assert.rejects(runAuthorFor(args),{code:'author_caps_unmeasured'});
  args.injected.measurementMode=true;
  await assert.rejects(runAuthorFor(args),{code:'measurement_adapter_reached'});
  args.injected.measurementMode='true';
  await assert.rejects(runAuthorFor(args),{code:'author_caps_unmeasured'});
 }finally{if(previous===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=previous;}
});
test('measured caps above A3 billable/context ceilings refused',()=>{
 const f=path.join(fs.mkdtempSync(path.join(root,'caps-')),'caps.json');
 const value={measuredAt:'2026-11-17',cliVersion:'test',model:'sonnet',runs:[{previews:3},{previews:3},{previews:3}],caps:{billableTotal:1472004,contextPeak:900000},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}};
 fs.writeFileSync(f,JSON.stringify(value));assert.ok(authorCaps({capsFile:f}));
 for(const field of ['billableTotal','contextPeak']){const v=structuredClone(value);v.caps[field]++;fs.writeFileSync(f,JSON.stringify(v));assert.throws(()=>authorCaps({capsFile:f}),{code:'author_caps_unmeasured'});}
});

// codex | gpt-6.1-sol | 2026-11-19 19:33 +02:00: F8 regression, including remaining run time.
for(const [model,elapsed,expected] of [['opus',0,1800000],['sonnet',0,1200000],['opus',2500000,1100000]])test(`write timeout ${model} after ${elapsed}ms`,async()=>{
 const r=rig({model});
 r.deps.askAuthor=async(p,i,o)=>{assert.equal(o.timeoutMs,expected);throw Object.assign(Error('stop'),{code:'stopped'});};
 // First clock read starts the run; subsequent reads represent work already spent.
 let reads=0;r.deps.now=()=>reads++===0?0:elapsed;
 await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'stopped'});
});

// codex | gpt-6.1-sol | 2026-11-19 19:33 +02:00: F6 cannot buy a fresh token budget.
// claude-pro | claude-fable-5-2 | 2026-11-20 (owner 13:04): it does get its own 30 minute clock (job mwo3d0mg-da7091 died author_time on the shared one).
test('final exposure repair shares token caps and has its own 30 minute clock',async()=>{
 {const r=rig();await runAuthorLoop(r.input,r.deps);const before=r.counts().calls;
  await assert.rejects(runAuthorLoop({...r.input,finalExposureReturn:true,caps:{billableTotal:30,contextPeak:900000}},r.deps),{code:'author_tokens'});
  assert.equal(r.counts().calls,before);}
 {const r=rig();await runAuthorLoop(r.input,r.deps);const before=r.counts().calls;
  // The first run's hour is long over; the repair still runs.
  r.deps.now=()=>3600001;const out=await runAuthorLoop({...r.input,finalExposureReturn:true},r.deps);
  assert.equal(out.accepted,true);assert.ok(r.counts().calls>before);}
 {const r=rig();await runAuthorLoop(r.input,r.deps);const before=r.counts().calls;
  // First clock read starts the repair; the next one is past its 30 minutes.
  let reads=0;r.deps.now=()=>reads++===0?0:1800001;
  await assert.rejects(runAuthorLoop({...r.input,finalExposureReturn:true},r.deps),{code:'author_time'});
  assert.equal(r.counts().calls,before);}
});

// codex · gpt-6.1-sol · 2026-11-19 20:02 +02:00: send flat surfaces back once within existing preview rounds.
test('surface report requires first-round fix, is recorded once and adds no surface-only loop', async () => {
 const prompts=[];
 const r=rig({kitContract:'AUTHOR SURFACE REQUIREMENTS'}, {reply:n=>{
  if(n===2)return look(); // A premature pass must be refused.
  if(n===3){const b=JSON.parse(look('fix'));b.look.targets=['shot_0'];b.look.edits=[{op:'replace_def',name:'shot_0',source:'def shot_0(t):\n    pass'}];return JSON.stringify(b);}
  return look();
 }});
 const ask=r.deps.askAuthor;r.deps.askAuthor=async(p,...args)=>{prompts.push(p);return ask(p,...args);};
 const out=await runAuthorLoop(r.input,r.deps);
 assert.equal(out.receipt.round,1);
 assert.equal(r.counts().previews,2);
 assert.match(prompts[1],/SURFACE CHECK/);
 assert.match(prompts[2],/SURFACE CHECK/);
 assert.doesNotMatch(prompts[3],/SURFACE CHECK/);
 assert.ok(fs.existsSync(path.join(r.stage,'author/a0/r0/surfaces.json')));
 assert.ok(!fs.existsSync(path.join(r.stage,'author/a0/r1/surfaces.json')));
});

// claude-pro · claude-fable-5-2 · 2026-11-20 (plan 2026-11-20-speed-and-faults, lanes A and B; run-mwow3a91-f47cff).
function adapterRig(direction) {
 const r=rig();
 const config=path.join(root,'card-config');fs.mkdirSync(config,{recursive:true});
 const capsFile=path.join(r.stage,'measured.json');fs.writeFileSync(capsFile,JSON.stringify({measuredAt:'2026-11-17',cliVersion:'2.1.322',model:'sonnet',runs:[{previews:3},{previews:3},{previews:3}],caps:{billableTotal:1472004,contextPeak:900000},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}}));
 const wordsPath=path.join(r.stage,'words.json');fs.writeFileSync(wordsPath,JSON.stringify({dur:28,words:[]}));
 const good={direction:{narrations:['spoken'],places:[{id:'p1',base:'custom',what:'world'}],shots:[{place:'p1',shows:'subject',action:'moves',camera:'orbit'}]},shotStarts:[0]};
 const input={rec:{id:'card',topic:'Journey',duration:30,route:'authored',formats:['journey']},stage:r.stage,signal:new AbortController().signal,scripted:{script:'narration',brief:'brief'},voice:{wordsPath},pathPack:{rules:{routes:{overlay:{render:{RENDER_BUDGET_S_PER_FRAME:1.5}}}}},jobsDir:r.stage,runtime:{runner:{}},
  pl:{planCodebuiltDirection:async()=>direction(good),frameCountFor:()=>900,authorBuildPrompt:()=> 'Write code',validateBuildScript:()=>[],pythonSyntaxCheck:()=>null,pythonQaStructureCheck:()=>[]},
  injected:{...r.deps,capsFile,repoRoot:path.resolve(import.meta.dirname,'../../..'),configDir:config,probe:async()=>({passed:true}),sheetMaker:{makeSheets:r.deps.makeSheets}}};
 return {r,input};
}
const withAuthorMode=async fn=>{const prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';try{return await fn();}finally{if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}};

test('the card is held for each preview render only, never during an author text call',()=>withAuthorMode(async()=>{
 const {r,input}=adapterRig(good=>good);let holding=false,holds=0,textWhileHolding=0;
 const ask=input.injected.askAuthor;input.injected.askAuthor=async(...a)=>{if(holding)textWhileHolding++;return ask(...a);};
 const out=await runAuthorFor({...input,gpu:async action=>{holds++;holding=true;try{return await action();}finally{holding=false;}}});
 assert.equal(out.accepted,true);assert.equal(holds,r.counts().previews);assert.ok(holds>=1);assert.equal(textWhileHolding,0);
}));

test('time spent waiting for the card does not count on the author clock',async()=>{
 for(const reported of [true,false]){
  const r=rig();let t=0;r.deps.now=()=>t;const render=r.deps.runPreview;
  // 50 minutes behind another video's final render, then 20 minutes of this author's own preview.
  r.deps.runPreview=async req=>{t+=50*60000;if(reported)req.onCardWait(50*60000);t+=20*60000;return render(req);};
  if(reported){const out=await runAuthorLoop(r.input,r.deps);assert.equal(out.accepted,true);assert.match(fs.readFileSync(path.join(r.stage,'author/a0/journal.jsonl'),'utf8'),/"kind":"card_wait"/);}
  else await assert.rejects(runAuthorLoop(r.input,r.deps),{code:'author_time'});
 }
});

test('a failed direction call is tried once more; two failures save the cause',()=>withAuthorMode(async()=>{
 {let n=0;const {input}=adapterRig(good=>{if(++n===1)throw Object.assign(Error('socket hang up'),{code:'ECONNRESET'});return good;});
  const out=await runAuthorFor(input);assert.equal(out.accepted,true);assert.equal(n,2);}
 {let n=0;const {r,input}=adapterRig(()=>{n++;throw Object.assign(Error('CLI exited 1 at C:\\Users\\someone\\claude.exe'),{code:'CLI_FAILED'});});
  await assert.rejects(runAuthorFor(input),e=>e.code==='CLI_FAILED'&&/^CLI_FAILED: CLI exited 1 at <path>$/.test(e.causeText));
  assert.equal(n,2);assert.equal(r.counts().calls,0);
  assert.match(JSON.parse(fs.readFileSync(path.join(r.stage,'author/direction-error.json'),'utf8')).cause,/^CLI_FAILED/);}
 {let n=0;const {input}=adapterRig(()=>{n++;throw Object.assign(Error('usage limit reached'),{quota:true});});
  await assert.rejects(runAuthorFor(input),{quota:true});assert.equal(n,1,'a usage limit is not retried');}
}));
