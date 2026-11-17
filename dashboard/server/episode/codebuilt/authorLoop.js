// codex · gpt-6.1-sol · 2026-11-17 22:46 +02:00
import fs from 'node:fs';
import path from 'node:path';
import { authorArgv, hash, authorError, normalizeAuthorUsage, AUTHOR_REPO } from './authorCall.js';
import { overlayPair, validateOverlayPair } from './overlaySpec.js';
import { AUTHOR_HEADER, writePair, parseAuthorLook, authorState } from './authorPrompts.js';
import { buildLookPrompt, sanitizeKitReport } from './visualLoopPrompts.js';
import { pickPreviewFrames } from './previewFrames.js';
import { newSheetCode, readKitReport } from './visualLoop.js';
function regular(file) {
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>20*1024*1024)throw authorError('author_state_outside_code');
}
const readBytes=(file,encoding)=>{regular(file);return fs.readFileSync(file,encoding);};
function write(file,bytes){if(fs.existsSync(file))regular(file);fs.writeFileSync(file,bytes);}
const json=(file,value)=>write(file,JSON.stringify(value,null,2)+'\n');
const read=file=>{regular(file);return JSON.parse(readBytes(file,'utf8'));};
function ensureAuthorRoot(stage){
 const root=path.join(stage,'author');fs.mkdirSync(root,{recursive:true});
 if(fs.lstatSync(root).isSymbolicLink() || path.dirname(fs.realpathSync(root))!==fs.realpathSync(stage))throw authorError('author_state_outside_code');
 return root;
} 
export function authorCaps(input={}) {
 if(input.measurementMode===true && input.caps && Object.values(input.caps).some(v=>!Number.isFinite(v)||v<=0))throw authorError('author_caps_unmeasured');
 if(input.measurementMode===true) return {caps:{billableTotal:Math.min(input.caps?.billableTotal??1472004,1472004),contextPeak:Math.min(input.caps?.contextPeak??900000,900000)},reserves:{IMAGE_RESERVE:4000,OUTPUT_RESERVE:40000}};
 try {
  const value=read(input.capsFile??path.join(AUTHOR_REPO,'paths/author-caps.json'));
  if(!value.measuredAt || !value.cliVersion || value.model!=='sonnet' || !Array.isArray(value.runs) || value.runs.filter(r=>r.previews>=3).length<3 || !['billableTotal','contextPeak'].every(k=>Number.isFinite(value.caps?.[k])&&value.caps[k]>0) || !['IMAGE_RESERVE','OUTPUT_RESERVE'].every(k=>Number.isFinite(value.reserves?.[k])&&value.reserves[k]>0)) throw Error();
  if(value.caps.billableTotal>1472004 || value.caps.contextPeak>900000)throw Error();
  return value;
 }catch{throw authorError('author_caps_unmeasured');}
}
// codex · gpt-6.1-sol · 2026-11-17 23:21 +02:00: bind accepted evidence to current narration, words and direction inputs.
const authorIdentity=input=>hash(JSON.stringify({script:input.script,words:input.wordsPath?hash(readBytes(input.wordsPath)):null,brief:input.brief,writePrompt:input.writePrompt,shots:input.shots,shotStarts:input.shotStarts,nframes:input.nframes}));
function pairCheck(code,spec,input) {
 const pair=overlayPair(code,spec,{videoSeconds:input.nframes/30});
 const reasons=input.validate(code,pair.spec); if(reasons.length) throw Error(reasons.join('; ')); return pair;
}
export function verifyAuthorReceipt(out,input) {
 try {
 const dir=ensureAuthorRoot(input.stageDir);
 const code=readBytes(path.join(dir,'accepted.build.py'),'utf8'),pair=read(path.join(dir,'accepted.overlay.json')),receipt=read(path.join(dir,'receipt.json'));
 if(!Number.isInteger(receipt.attempt)||receipt.attempt<0||!Number.isInteger(receipt.round)||receipt.round<0||receipt.round>4)throw Error();
 if(receipt.identity!==authorIdentity(input))throw Error();
 const spec=validateOverlayPair(pair,code,{videoSeconds:input.nframes/30});pairCheck(code,spec,input);
 if(JSON.stringify(spec)!==JSON.stringify(out.overlaySpec) || out.accepted!==true || code!==out.buildScript || hash(code)!==out.sha256 || hash(JSON.stringify(spec))!==receipt.overlaySha256 || receipt.sha256!==out.sha256 || JSON.stringify(receipt)!==JSON.stringify(out.receipt) || receipt.argvSha256!==hash(JSON.stringify(authorArgv()))) throw Error();
 const roundDir=path.join(dir,`a${receipt.attempt}`,`r${receipt.round}`);
 const preview=read(path.join(roundDir,'preview.json')),look=read(path.join(roundDir,'look.json'));
 if(readBytes(path.join(roundDir,'build.py'),'utf8')!==code || JSON.stringify(validateOverlayPair(read(path.join(roundDir,'overlay.json')),code,{videoSeconds:input.nframes/30}))!==JSON.stringify(spec))throw Error();
 const call=look.call,delivery=call?.receipt;
 if(!Number.isInteger(call?.n)||call.n<0||call.n>=12)throw Error();
 const prompt=readBytes(path.join(roundDir,`prompt-${call.n}.txt`),'utf8'),replyText=readBytes(path.join(roundDir,`reply-${call.n}.txt`),'utf8');
 if(!delivery || delivery.argvSha256!==receipt.argvSha256 || call.promptSha256!==hash(prompt) || call.replySha256!==hash(replyText) || delivery.promptSha256!==call.promptSha256 || JSON.stringify(delivery.imageSha256)!==JSON.stringify(look.sheets.map(s=>s.sha256)))throw Error();
 const options={shots:input.shots.map((s,i)=>({...s,id:`shot-${i}`})),sheetCodes:look.sheetCodes,kitFailures:look.kitFailures,flatTiles:look.flatTiles};
 const actual=parseAuthorLook(replyText,{...options,buildScript:code,overlaySpec:spec,videoSeconds:input.nframes/30,validate:(c,s)=>{pairCheck(c,s,input);return [];}});
 if(JSON.stringify(actual.look)!==JSON.stringify(look.reply) || actual.look.verdict!=='pass')throw Error();
 // Check the exact sheet protocol schema and headers delivered in the hashed prompt.
 const schemas=[...prompt.matchAll(/\{"sheet_codes": (\[[^\n]*?\]), "verdict": "pass" \| "fix"/g)];
 if(schemas.length!==1 || JSON.stringify(JSON.parse(schemas[0][1]))!==JSON.stringify(look.sheetCodes))throw Error();
 if(look.sheets.length!==delivery.imageCount || look.sheets.some((_,i)=>!look.sheetCodes.some(c=>prompt.includes(`Sheet ${i+1} (code in its header: ${c}):`))))throw Error();
 if(preview.sha256!==out.sha256 || preview.overlaySha256!==receipt.overlaySha256 || look.sha256!==out.sha256 || look.overlaySha256!==receipt.overlaySha256 || look.verdict!=='pass' || !look.sheets.length) throw Error();
 for(const sheet of look.sheets){if(!/^sheet-[0-9]+\.jpg$/.test(sheet.file) || hash(readBytes(path.join(roundDir,'sheets',sheet.file)))!==sheet.sha256) throw Error();}
 return true;
 }catch{throw authorError('author_hash');}
}
export async function runAuthorLoop(input,deps={}) {
 if(!path.isAbsolute(input.stageDir)|| (input.previewAttempt!==undefined&&(!Number.isInteger(input.previewAttempt)||input.previewAttempt<0)))throw authorError('bad_input');
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,50}$/.test(input.jobId)||typeof input.validate!=='function') throw authorError('bad_input');
 const measured=authorCaps(input), root=ensureAuthorRoot(input.stageDir);
 // Reuse only a completely evidenced accepted pair. Never replay part of an attempt.
 try {const code=readBytes(path.join(root,'accepted.build.py'),'utf8'),pair=read(path.join(root,'accepted.overlay.json')),receipt=read(path.join(root,'receipt.json'));const out={accepted:true,buildScript:code,overlaySpec:pair.spec,sha256:hash(code),receipt,calls:[]};verifyAuthorReceipt(out,input);return out;}catch{ /* new turn W */ }
 const attempts=fs.readdirSync(root).filter(n=>/^a\d+$/.test(n)).map(n=>Number(n.slice(1)));
 const attempt=Math.max(attempts.length?Math.max(...attempts)+1:0,input.previewAttempt??0),stage=path.join(root,`a${attempt}`);fs.mkdirSync(stage);
 const now=deps.now??Date.now,started=now(),argvSha256=hash(JSON.stringify(authorArgv())),calls=[],history=[];
 let spent=0,contextPeak=0,outputTotal=0,repairs=0,round=0,previews=0,code='',spec=null,feedback='',editRefusals=0,resynced=false;
 const journal=entry=>{const file=path.join(stage,'journal.jsonl');if(fs.existsSync(file))regular(file);fs.appendFileSync(file,JSON.stringify(entry)+'\n');};
 const state=status=>{const value={version:1,jobId:input.jobId,model:'sonnet',cliVersion:input.probe?.cliVersion??null,argvSha256,switch:{env:true,job:'authored'},caps:measured.caps,counters:{calls:calls.length,rounds:previews,minutes:(now()-started)/60000,billableTotal:spent,contextPeak,outputTotal},attempt,status};json(path.join(stage,'session.json'),value);json(path.join(root,'session.json'),value);};
 const guard=()=>{if(input.signal?.aborted)throw authorError('aborted');if(now()-started>3600000)throw authorError('author_time');if(spent>measured.caps.billableTotal)throw authorError('author_tokens');if(contextPeak>measured.caps.contextPeak)throw authorError('author_context_full');};
 const timed=async(kind,fn)=>{guard();const t=now();try{return await fn();}finally{journal({kind,round,wallS:(now()-t)/1000});}};
 const ask=async(prompt,images,kind,dir)=>{
  guard(); if(calls.length>=12)throw authorError('author_calls');if(prompt.length>200000 || images.length>4)throw authorError('author_context_full');
  const reserve=normalizeAuthorUsage(null,{promptChars:prompt.length,images:images.length,...measured.reserves}).reserve;
  if(spent+reserve>measured.caps.billableTotal)throw authorError('author_tokens');
  const n=calls.length,t=now();write(path.join(dir,`prompt-${n}.txt`),prompt);
  let answer;
  try {answer=await deps.askAuthor(prompt,images,{model:'sonnet',signal:input.signal,timeoutMs:Math.max(1,Math.min(kind==='write'?1200000:600000,3600000-(now()-started)))});}
  catch(error){const usage=normalizeAuthorUsage(null,{promptChars:prompt.length,images:images.length,...measured.reserves});const entry={n,round,kind,status:'error',usage,reserve,spentBefore:spent,wallS:(now()-t)/1000};calls.push(entry);spent+=usage.billable;contextPeak=Math.max(contextPeak,usage.context);journal(entry);state('failed');deps.onCall?.(entry);throw error;}
  write(path.join(dir,`reply-${n}.txt`),answer.text);
  const usage=normalizeAuthorUsage(answer.rawUsage??answer.usage,{promptChars:prompt.length,images:images.length,...measured.reserves});
  const entry={n,round,kind,step:'author',provider:'claude',model:'sonnet',promptSha256:hash(prompt),replySha256:hash(answer.text),imageSha256:images.map(i=>hash(i.bytes)),usage,wallS:(now()-t)/1000,receipt:answer.receipt,spentBefore:spent,reserve,promptChars:prompt.length,replyChars:answer.text.length,image_tokens_seen:images.length?Math.max(0,usage.context-Math.ceil(prompt.length/3))/images.length:null};
  calls.push(entry);spent+=usage.billable;contextPeak=Math.max(contextPeak,usage.context);outputTotal+=usage.output_tokens;journal(entry);deps.onCall?.(entry);state('running');guard();
  const rc=answer.receipt;
  if(!rc || rc.argvSha256!==argvSha256 || rc.promptSha256!==hash(prompt) || JSON.stringify(rc.imageSha256)!==JSON.stringify(entry.imageSha256) || rc.imageCount!==images.length || rc.toolsOffered!==0 || rc.noSessionPersistence!==true || rc.transport!=='stdin-image-blocks')throw authorError('author_receipt');
  return answer.text;
 };
 const refused=error=>{if(repairs>=3)throw authorError('author_reply');repairs++;feedback=String(error.message).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g,'<path>').slice(0,1000);journal({kind:'refused',round,reason:feedback});};
 state('running');
 try {
  if(input.probe?.passed!==true)throw authorError('author_transport_unavailable');
  const writeDir=path.join(stage,'write');fs.mkdirSync(writeDir);
  while(!code){const text=await ask(`${AUTHOR_HEADER}\n${input.writePrompt}\n${feedback}`,[],'write',writeDir);try{const pair=writePair(text,input.nframes/30);pairCheck(pair.buildScript,pair.overlaySpec,input);code=pair.buildScript;spec=pair.overlaySpec;feedback='';}catch(error){refused(error);}}
  const frames=pickPreviewFrames({nframes:input.nframes,shotStarts:input.shotStarts,fps:30});
  const shots=input.shots.map((s,i)=>({...s,id:`shot-${i}`}));
  for(round=0;round<5;round++){
   guard();const pair=pairCheck(code,spec,input);spec=pair.spec;
   const dir=path.join(stage,`r${round}`);fs.mkdirSync(dir);write(path.join(dir,'build.py'),code);json(path.join(dir,'overlay.json'),pair);
   const sha256=hash(code),overlaySha256=hash(JSON.stringify(spec)),previewId=`${input.jobId}-a${attempt}-pv${round+1}`;
   previews++;deps.onPhase?.('previewing');let preview=null,crash=null;
   try{preview=await timed('preview',()=>deps.runPreview({jobId:previewId,buildScript:code,overlaySpec:spec,spec:{frames,scale:50},signal:input.signal}));}
   catch(error){if(!['FENCE_FAILED','AGENT_EARLY_STOP','MISSING_OUTPUT','TIMEOUT'].includes(error.code)||error.detail?.backstop)throw error;crash=String(error.diagnostic??error.code).slice(0,2000);}
   guard();let sheets=[],kit=null,timing=null;
   if(preview){
    kit=sanitizeKitReport((deps.readKitReport??readKitReport)(preview.dir),shots.length);
    const work=path.join(path.dirname(preview.dir),'work'),anchors=path.join(work,'anchors-preview.json');
    if(fs.existsSync(anchors)){regular(anchors);fs.copyFileSync(anchors,path.join(dir,'anchors-preview.json'));}
    const raw=path.join(dir,'overlay-spec.json');json(raw,spec);
    const words=path.join(dir,'words.json');if(input.wordsPath){regular(input.wordsPath);fs.copyFileSync(input.wordsPath,words);}
    deps.onPhase?.('looking');
    sheets=await timed('sheet',()=>deps.makeSheets({framesDir:preview.dir,outDir:path.join(dir,'sheets'),code:(deps.newCode??newSheetCode)(),signal:input.signal,overlaySpec:raw,nframes:input.nframes,fps:30,jobRoot:dir,...(input.wordsPath?{words,lead:0.35}:{}),...(fs.existsSync(path.join(dir,'anchors-preview.json'))?{anchors:path.join(dir,'anchors-preview.json')}:{})}));
    try{const t=read(path.join(work,'render-timing.json'));if(!Number.isFinite(t.render_s)||!(t.rendered>0))throw Error();timing=t.render_s/t.rendered*4;journal({kind:'render_timing',round,secondsPerFrame:timing});}catch{journal({kind:'render_timing_unavailable',round});}
   }
   const sheetRecords=sheets.map((s,i)=>{const file=`sheet-${i}.jpg`,bytes=readBytes(s.path);write(path.join(dir,'sheets',file),bytes);return {file,sha256:hash(bytes)};});
   const images=sheetRecords.map(s=>({bytes:readBytes(path.join(dir,'sheets',s.file)),mediaType:'image/jpeg'}));
   json(path.join(dir,'preview.json'),{sha256,overlaySha256,jobId:previewId,frames,rendered:preview?.frames??[],sheets:sheetRecords});
   let reply;
   for(;;){
    let replay=history.slice();
    const makePrompt=()=>AUTHOR_HEADER+'\n'+authorState({buildScript:code,overlaySpec:spec,sha256,history:replay,round,minutesLeft:Math.max(0,60-(now()-started)/60000)})+'\n'+buildLookPrompt({brief:input.brief,script:input.script,shots,buildScript:code,kitContract:input.kitContract,sheets,shotStarts:input.shotStarts,round,finalRound:round===4,qaText:crash,previous:replay,kit,layoutFindings:sheets.flatMap(s=>s.layout_findings??[])})+`\nWrap that exact look object in {look,notes,overlay?}. ${timing>input.renderBudget?`render_too_slow: ${timing} s/frame`:''}\n${feedback}`;
    let prompt=makePrompt();while(prompt.length>200000&&replay.length){replay.shift();prompt=makePrompt();}
    const text=await ask(prompt,images,editRefusals>=2&&!resynced?'resync':'look',dir);if(editRefusals>=2)resynced=true;
    try{reply=parseAuthorLook(text,{buildScript:code,overlaySpec:spec,validate:(c,s)=>{pairCheck(c,s,input);return [];},videoSeconds:input.nframes/30,shots,sheetCodes:[...new Set(sheets.map(s=>s.code))],finalRound:round===4,flatTiles:sheets.flatMap(s=>s.tiles.filter(t=>t.flag==='flat').map(t=>t.n)),kitFailures:kit?.findings.map(f=>f.check)??[]});break;}
    catch(error){editRefusals++;refused(error);}
   }
   feedback='';editRefusals=0;
   journal({kind:'validation',round,sha256,overlaySha256,verdict:reply.look.verdict});
   history.push({round,notes:reply.notes,findings:reply.look.findings,targets:reply.look.targets,verdict:reply.look.verdict,kitChecks:kit?.findings.map(f=>f.check)??[]});
   json(path.join(dir,'look.json'),{sha256,overlaySha256,verdict:reply.look.verdict,sheets:sheetRecords,sheetCodes:[...new Set(sheets.map(s=>s.code))],kitFailures:kit?.findings.map(f=>f.check)??[],flatTiles:sheets.flatMap(s=>s.tiles.filter(t=>t.flag==='flat').map(t=>t.n)),call:calls.at(-1),reply:reply.look});write(path.join(dir,'notes.txt'),reply.notes);
   if(reply.look.verdict==='pass'){
    guard();if(readBytes(path.join(dir,'build.py'),'utf8')!==code || JSON.stringify(read(path.join(dir,'overlay.json')))!==JSON.stringify(pair))throw authorError('author_hash');
    write(path.join(root,'accepted.build.py'),code);json(path.join(root,'accepted.overlay.json'),pair);
    const receipt={version:1,identity:authorIdentity(input),accepted:true,sha256,overlaySha256,argvSha256,attempt,round,rounds:history,calls:calls.length};json(path.join(root,'receipt.json'),receipt);
    const out={accepted:true,buildScript:readBytes(path.join(root,'accepted.build.py'),'utf8'),overlaySpec:spec,sha256,receipt,calls};verifyAuthorReceipt(out,input);state('accepted');return out;
   }
   code=reply.buildScript;spec=reply.overlaySpec;
  }
  throw authorError('author_rounds');
 }catch(error){state(error.code??'author_failed');json(path.join(stage,'error.json'),{code:error.code??'author_failed'});throw error;}
}
// Integration adapter: direction is separate; all preview/sheet/transport effects remain injectable.
export async function runAuthorFor({rec,stage,signal,scripted,voice,pathPack,pl,runtime,jobsDir,hostExecFile,injected={},addCall,onPhase}) {
 const {askAuthor,probeAuthorSupport,checkAuthorConfig}=await import('./authorCall.js');
 const {createPreviewSheetMaker}=await import('./previewSheet.js');
 const {createPreviewRunFn}=await import('../engines/codebuilt/composePreview.js');
 const {directionMarkdown}=await import('./direction.js');
 if(process.env.FORGEAI_AUTHOR_MODE!=='1')throw authorError('author_mode_disabled');
 authorCaps({capsFile:injected.capsFile});checkAuthorConfig(injected);
 const sheetMaker=injected.sheetMaker??createPreviewSheetMaker({execFileFn:hostExecFile});
 const ask=injected.askAuthor??((p,i,o)=>askAuthor(p,i,{...o,workRoot:path.join(stage,'author','calls')}));
 ensureAuthorRoot(stage);
 let probe=null;
 const words=JSON.parse(readBytes(voice.wordsPath,'utf8'));
 let directed;
 const directionFile=path.join(stage,'author','direction.json'), identity=hash(scripted.script+JSON.stringify(words));
 try{const saved=read(directionFile);if(saved.identity===identity)directed=saved.directed;}catch{}
 if(!directed) directed=await pl.planCodebuiltDirection({route:'authored',topic:rec.topic,duration:rec.duration,script:scripted.script,brief:scripted.brief,beats:scripted.shots,words,pathPack,formats:rec.formats,choices:rec.choices,premise:rec.premise,signal},{onCall:addCall});
 json(directionFile,{identity,directed});
 const direction=directed.direction,shotStarts=directed.shotStarts,nframes=pl.frameCountFor(words),places=direction.places.map(p=>p.id);
 const plan={nframes,shotStarts,places,direction,directionMarkdown:directionMarkdown(direction,shotStarts,nframes/30),lookShots:direction.shots.map(s=>({subject:s.shows??s.action??'subject',narration:direction.narrations?.[direction.shots.indexOf(s)]??'recorded narration'})),kitContract:pl.KIT_CONTRACT};
 const validate=(code,spec)=>{
  const why=pl.validateBuildScript(code,{route:'authored',nframes,shotStarts,places,type:rec.choices?.type,overlay:true,overlaySpec:spec});
  if(!why.length){const bad=pl.pythonSyntaxCheck(code);if(bad)why.push(bad);}
  if(!why.length){const bad=pl.pythonQaStructureCheck(code,{expect:{shotStarts,nframes}});if(Array.isArray(bad))why.push(...bad);}
  return why;
 };
 const input={jobId:rec.id,stageDir:stage,capsFile:injected.capsFile,previewAttempt:rec.resumes?.length??0,signal,probe,nframes,shotStarts,shots:plan.lookShots,brief:scripted.brief+'\n'+plan.directionMarkdown,script:scripted.script,kitContract:pl.KIT_CONTRACT,wordsPath:voice.wordsPath,renderBudget:pathPack.rules.routes.overlay.render.RENDER_BUDGET_S_PER_FRAME,validate,writePrompt:pl.authorBuildPrompt({topic:rec.topic,duration:rec.duration,script:scripted.script,brief:scripted.brief,words,pathPack,formats:rec.formats,choices:rec.choices,direction,shotStarts,nframes})};
 try {const receipt=read(path.join(stage,'author','receipt.json')),code=readBytes(path.join(stage,'author','accepted.build.py'),'utf8'),pair=read(path.join(stage,'author','accepted.overlay.json'));verifyAuthorReceipt({accepted:true,buildScript:code,overlaySpec:pair.spec,sha256:hash(code),receipt},input);probe={passed:true};}catch{}
 if(!probe)probe=injected.probe ? await injected.probe({rec,stage,signal}) : await probeAuthorSupport({stageDir:path.join(stage,'author'),nonce:cryptoNonce(),makeCanary:sheetMaker.makeCanary,askFn:ask,signal});
 input.probe=probe;
 const base=injected.runPreview??(request=>createPreviewRunFn({runner:{run:args=>runtime.runner.run({...args,route:'authored',overlaySpec:request.overlaySpec})},inputs:{script:scripted.script,voWav:voice.voPath,words:voice.wordsPath,pathPack,brief:scripted.brief},jobRoot:jobsDir})(request));
 const outcome=await runAuthorLoop(input,{...injected,askAuthor:ask,runPreview:request=>base({...request,route:'authored'}),makeSheets:args=>sheetMaker.makeSheets(args),onCall:addCall,onPhase});
 return {...plan,...outcome,verifyReceipt:()=>verifyAuthorReceipt(outcome,input)};
}
function cryptoNonce(){return hash(`${Date.now()}-${newSheetCode()}`).slice(0,32);}
