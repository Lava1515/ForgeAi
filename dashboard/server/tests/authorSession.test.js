// codex · gpt-6.1-sol · 2026-11-19 15:11 +02:00: the session must never become a host command runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createAuthorSession, sessionArgv, sessionPath, consumePreviewRequest } from '../episode/codebuilt/authorSession.js';
import { askAuthorSession, hash } from '../episode/codebuilt/authorCall.js';
import { runAuthorLoop, verifyAuthorReceipt } from '../episode/codebuilt/authorLoop.js';
// B3 bug 2026-11-19: the session asked for scale 25 and the real fence refused it (BAD_JOB); the stub now runs the fence's own check.
import { checkPreviewRequest } from '../episode/engines/codebuilt/jobFolder.js';

test('author session uses only restricted job file tools, resumes, and refuses escapes and command requests', async () => {
 const root = 'C:/code/ForgeAi/output/agent-jobs/b2-session-test';
 fs.mkdirSync(root, { recursive: true });
 const stage = fs.mkdtempSync(path.join(root, 'job-'));
 const session = createAuthorSession({ stageDir: stage, attemptDir: stage });
 const allowed = 'Read,Edit(./build.py),Edit(./overlay.json),Edit(./render.request.json)';
 const args = ['-p','--input-format','stream-json','--output-format','stream-json','--verbose','--model','opus',
  '--tools','Read,Edit,Write','--allowedTools',allowed,'--permission-mode','dontAsk',
  '--disable-slash-commands','--strict-mcp-config','--safe-mode','--restricted','--session-id',session.id];
 assert.deepEqual(sessionArgv('opus', session.id, false), args);
 assert.deepEqual(sessionArgv('opus', session.id, true), [...args.slice(0,-2), '--resume', session.id]);
 assert.throws(() => sessionArgv('other',session.id), { code: 'author_model_unavailable' });
 for (const file of ['../outside.py',path.join(stage,'outside.py'),'C:/Windows/win.ini','\\\\server\\share\\x', 'build.py:stream']) {
  assert.throws(() => sessionPath(session, file), { code: 'author_state_outside_code' });
 }
 const outside = path.join(stage, 'outside.py'); fs.writeFileSync(outside, 'unchanged');
 fs.linkSync(outside, path.join(session.cwd, 'build.py'));
 assert.throws(() => sessionPath(session, 'build.py'), { code: 'author_state_outside_code' });
 fs.unlinkSync(path.join(session.cwd,'build.py'));
 const request = sessionPath(session, 'render.request.json');
 for (const value of [{action:'preview',command:'whoami'},{action:'preview',path:'../x'},{action:'shell'},{action:'preview',frames:[0],scale:100}]) {
  fs.writeFileSync(request,JSON.stringify(value));
  assert.throws(() => consumePreviewRequest(session), { code:'author_reply' });
 }
 fs.writeFileSync(request,'{"action":"preview"}'); consumePreviewRequest(session);
 assert.ok(!fs.existsSync(request));
 let invocations = 0, badEvent=null, useWindows=false;
 const spawnFn = (_bin, argv, opts) => {
  const expected=invocations++ ? [...args.slice(0,-2),'--resume',session.id] : args;
  assert.deepEqual(argv,useWindows?expected.map(a=>/[,()]/.test(a)?`"${a}"`:a):expected);
  assert.equal(opts.cwd,session.cwd);
  assert.equal(opts.shell,useWindows);
  assert.equal(opts.env.ANTHROPIC_API_KEY,undefined);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = {end:() => queueMicrotask(() => {
   child.stdout.emit('data',JSON.stringify({type:'system',subtype:'init',session_id:session.id,tools:['Read','Edit','Write'],mcp_servers:[],skills:[]})+'\n');
   if(badEvent)child.stdout.emit('data',JSON.stringify(badEvent)+'\n');
   child.stdout.emit('data',JSON.stringify({type:'result',session_id:session.id,result:'ready',usage:{input_tokens:10,output_tokens:10}})+'\n');
   child.emit('close',0);
  })}; return child;
 };
 for (let n=0;n<2;n++) await askAuthorSession('Continue',[],{session,model:'opus',repoRoot:'C:/code/ForgeAi',configDir:root,spawnFn,platform:'linux'});
 assert.equal(invocations,2);
 useWindows=true;
 await askAuthorSession('Continue',[],{session,model:'opus',repoRoot:'C:/code/ForgeAi',configDir:root,spawnFn,platform:'win32'});
 useWindows=false;
 for(const [event,code] of [
  [{type:'system',subtype:'init',session_id:session.id,tools:['Read','Edit','Write','Bash'],skills:[],mcp_servers:[]},'tools_offered'],
  [{type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'whoami'}}]}},'author_tool_event'],
  [{type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:outside}}]}},'author_tool_event'],
  [{type:'assistant',message:{content:[{type:'tool_use',name:'Write',input:{file_path:path.join(session.cwd,'findings.json'),content:'fake'}}]}},'author_tool_event'],
  [{type:'assistant',message:{id:'over-cap',usage:{input_tokens:900001,output_tokens:0},content:[]}},'author_context_full'],
  [{type:'assistant',message:{id:'over-cap',usage:{input_tokens:1,output_tokens:100000},content:[]}},'author_tokens'],
 ]){
  badEvent=event;
  await assert.rejects(askAuthorSession('Continue',[],{session,model:'opus',maxBillableTokens:94000,maxContextTokens:90000,repoRoot:'C:/code/ForgeAi',configDir:root,spawnFn,platform:'linux'}),{code});
 }
 badEvent=null;
 badEvent={type:'assistant',message:{id:'normal-tool-turn',usage:{input_tokens:50000,output_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0},content:[]}};
 const measured=await askAuthorSession('Continue',[],{session,model:'opus',repoRoot:'C:/code/ForgeAi',configDir:root,spawnFn,platform:'linux'});
 assert.equal(measured.contextPeak,50000); // result.usage is a sum of tool turns, not the context size
 badEvent=null;
 assert.equal(fs.readFileSync(outside,'utf8'),'unchanged');
 // The same damage-focused test drives the complete host loop, without a model call or GPU job.
 const loopStage=fs.mkdtempSync(path.join(root,'loop-'));
 let calls=0,previews=0,sessionId;
 const code='# original scene\ndef shot_0(t):\n    pass\n';
 const fixed=code.replace('original','fixed');
 const input={jobId:'b2-test',stageDir:loopStage,model:'opus',sessionEnabled:true,measurementMode:true,probe:{passed:true},
  writePrompt:'KIT_SENT_ONCE',kitContract:'KIT_SENT_ONCE',script:'narration',brief:'brief',nframes:900,shotStarts:[0],shots:[{subject:'hero',narration:'narration'}],validate:()=>[]};
 const deps={
  askAuthor:async(prompt,images,{session:s})=>{
   const argv=sessionArgv('opus',s.id,s.started);sessionId??=s.id;assert.equal(s.id,sessionId);
   calls++;assert.equal(prompt.includes('KIT_SENT_ONCE'),calls===1);
   assert.ok(!prompt.includes(code));assert.ok(!prompt.includes(fixed));
   if(calls===1){fs.writeFileSync(sessionPath(s,'build.py'),code);fs.writeFileSync(sessionPath(s,'overlay.json'),'{"version":1}');}
   if(calls===2)fs.writeFileSync(sessionPath(s,'build.py'),fixed);
   if(calls<3)fs.writeFileSync(sessionPath(s,'render.request.json'),'{"action":"preview"}');
   else assert.ok(fs.existsSync(sessionPath(s,'sheet-0.jpg')));
   const text=calls===1?'Preview requested':JSON.stringify({look:{sheet_codes:['ABCDE'],verdict:calls===2?'fix':'pass',shots:[{id:'shot-0',sees:'The hero fills the frame.',ok:true}],findings:calls===2?[{severity:'P1',issue:'Improve the camera.'}]:[],targets:[],edits:[]},notes:calls===2?'Fixed the camera.':'Scene is final.'});
   s.started=true;
   return {text,rawUsage:{input_tokens:10,output_tokens:10,cache_creation_input_tokens:0,cache_read_input_tokens:0},receipt:{argvSha256:hash(JSON.stringify(argv)),promptSha256:hash(prompt),imageSha256:images.map(i=>hash(i.bytes)),imageCount:images.length,noSessionPersistence:false,toolsOffered:3,transport:'author-session',sessionId:s.id}};
  },
  runPreview:async request=>{
   previews++;checkPreviewRequest(request.spec.frames,request.spec.scale);assert.ok(request.spec.frames.length<=12);
   assert.equal(request.buildScript,previews===1?code:fixed);
   const dir=path.join(loopStage,`preview-${previews}`);fs.mkdirSync(dir);return {dir,frames:[]};
  },
  makeSheets:async({outDir})=>{fs.mkdirSync(outDir);const file=path.join(outDir,'sheet.jpg');fs.writeFileSync(file,'pixels');return [{path:file,code:'ABCDE',tiles:[{n:1,frame:6}]}];},
  layoutCheck:async({overlaySpec,nframes})=>({version:1,ok:true,framesChecked:nframes,fps:30,previewFrames:1,anchoredFrames:0,blocking:[],labelHidden:[],inputs:{overlaySha256:hash(fs.readFileSync(overlaySpec)),wordsSha256:null,anchorsSha256:null}}),
 };
 const out=await runAuthorLoop(input,deps);
 assert.equal(out.buildScript,fixed);assert.equal(previews,2);assert.equal(calls,3);
 assert.equal(verifyAuthorReceipt(out,input),true);
 await runAuthorLoop(input,deps);assert.equal(calls,3); // accepted retries do not start another session
});
