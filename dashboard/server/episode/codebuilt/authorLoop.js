// codex · gpt-6.1-sol · 2026-11-17 22:46 +02:00
import fs from 'node:fs';
import path from 'node:path';
import { authorArgv, hash, authorError, normalizeAuthorUsage, AUTHOR_REPO } from './authorCall.js';
import { overlayPair, validateOverlayPair } from './overlaySpec.js';
import { AUTHOR_HEADER, SESSION_HEADER, sessionLookPrompt, writePair, parseAuthorLook, authorState } from './authorPrompts.js';
import { createAuthorSession, sessionArgv, sessionPath, readSessionPair, consumePreviewRequest, smallSessionFrames } from './authorSession.js';
import { exposureAdvice } from './exposureCheck.js';
import { buildLookPrompt, sanitizeKitReport } from './visualLoopPrompts.js';
import { pickAuthoredPreviewFrames, overlayWindows } from './previewFrames.js';
import { createLayoutGate, layoutRefusal, layoutBound } from './layoutGate.js';
import { newSheetCode, readKitReport } from './visualLoop.js';
function regular(file) {
 const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>20*1024*1024)throw authorError('author_state_outside_code');
}
const readBytes=(file,encoding)=>{regular(file);return fs.readFileSync(file,encoding);};
function write(file,bytes){if(fs.existsSync(file))regular(file);fs.writeFileSync(file,bytes);}
const json=(file,value)=>write(file,JSON.stringify(value,null,2)+'\n');
const read=file=>{regular(file);return JSON.parse(readBytes(file,'utf8'));};
// claude-pro · claude-sonnet-5-5 · 2026-11-18 (C2-AUTH-1): labels, measures, a counter and bars read the exported anchor positions of EVERY frame.
// The preview job poses all frames without rendering (renderloop.export_all_frame_anchors) and leaves anchors-all.json (same anchors.json contract)
// plus anchors-all.done.json ({version:1,frames,max_frame,anchors,pose_s}) in its work folder; the round keeps a copy of both.
const needsPose=spec=>!!spec&&((spec.labels?.length??0)>0||(spec.measures?.length??0)>0||!!spec.counter||(spec.bars?.length??0)>0);
function poseRecord(dir,nframes){
 try{const r=read(path.join(dir,'anchors-all.done.json'));
  if(r.version===1&&r.frames===nframes&&r.max_frame===nframes-1&&typeof r.anchors==='boolean')return r;}catch{ /* no complete export */ }
 return null;
}
function ensureAuthorRoot(stage){
 const root=path.join(stage,'author');fs.mkdirSync(root,{recursive:true});
 if(fs.lstatSync(root).isSymbolicLink() || path.dirname(fs.realpathSync(root))!==fs.realpathSync(stage))throw authorError('author_state_outside_code');
 return root;
} 
export function authorCaps(input={}) {
 // codex · gpt-6.1-sol · 2026-11-19 08:07 +02:00: Sonnet's measured file is the unchanged ceiling for both authors.
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
const authorIdentity=input=>hash(JSON.stringify({script:input.script,words:input.wordsPath?hash(readBytes(input.wordsPath)):null,brief:input.brief,writePrompt:input.writePrompt,shots:input.shots,shotStarts:input.shotStarts,nframes:input.nframes,...(input.finalExposureReturn?{finalExposureReturn:true}:{})}));
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
 if(!!receipt.sessionId!==(input.sessionEnabled===true))throw Error();
 const expectedArgv=receipt.sessionId?sessionArgv(input.model??'sonnet',receipt.sessionId,true):authorArgv(input.model??'sonnet');
 if(JSON.stringify(spec)!==JSON.stringify(out.overlaySpec) || out.accepted!==true || code!==out.buildScript || hash(code)!==out.sha256 || hash(JSON.stringify(spec))!==receipt.overlaySha256 || receipt.sha256!==out.sha256 || JSON.stringify(receipt)!==JSON.stringify(out.receipt) || receipt.argvSha256!==hash(JSON.stringify(expectedArgv))) throw Error();
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
// claude-pro · claude-sonnet-5-5 · 2026-11-18 17:55 +02:00: the all-frame layout check is part of the receipt; an older accepted pair has no record and is refused.
 const layoutRecord=look.layout,specBytes=readBytes(path.join(roundDir,'overlay-spec.json'));
 if(JSON.stringify(JSON.parse(specBytes.toString('utf8')))!==JSON.stringify(spec) || !layoutBound(layoutRecord,{overlaySha256:hash(specBytes),wordsSha256:input.wordsPath?hash(readBytes(input.wordsPath)):null,nframes:input.nframes}) || receipt.layoutSha256!==hash(JSON.stringify(layoutRecord)))throw Error();
 // Cycle 2 (C1): coverage is recomputed from the spec and the previewed frames, so an edited look.json cannot hide an uncovered window.
 if(!Array.isArray(preview.frames)||preview.frames.length>24||overlayWindows(spec).some(w=>!preview.frames.some(f=>Number.isInteger(f)&&f/30>=w.from&&f/30<w.to)))throw Error();
 // C2-AUTH-1: when the spec has anchored elements the record must come from the all-frame export, bound by hash; otherwise (fixed text only) the preview file as before.
 if(needsPose(spec)){
  const pose=poseRecord(roundDir,input.nframes);
  if(!pose||layoutRecord.previewFrames!==input.nframes||(layoutRecord.inputs.anchorsSha256??null)!==(pose.anchors?hash(readBytes(path.join(roundDir,'anchors-all.json'))):null))throw Error();
 }else{
  const anchorsFile=path.join(roundDir,'anchors-preview.json');
  if((layoutRecord.inputs.anchorsSha256??null)!==(fs.existsSync(anchorsFile)?hash(readBytes(anchorsFile)):null))throw Error();
 }
 if(preview.sha256!==out.sha256 || preview.overlaySha256!==receipt.overlaySha256 || look.sha256!==out.sha256 || look.overlaySha256!==receipt.overlaySha256 || look.verdict!=='pass' || !look.sheets.length) throw Error();
 for(const sheet of look.sheets){if(!/^sheet-[0-9]+\.jpg$/.test(sheet.file) || hash(readBytes(path.join(roundDir,'sheets',sheet.file)))!==sheet.sha256) throw Error();}
 return true;
 }catch{throw authorError('author_hash');}
}
export async function runAuthorLoop(input,deps={}) {
 const model=input.model??'sonnet';authorArgv(model);
 if(!path.isAbsolute(input.stageDir)|| (input.previewAttempt!==undefined&&(!Number.isInteger(input.previewAttempt)||input.previewAttempt<0)))throw authorError('bad_input');
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,50}$/.test(input.jobId)||typeof input.validate!=='function') throw authorError('bad_input');
 const measured=authorCaps(input), root=ensureAuthorRoot(input.stageDir);
 // Reuse only a completely evidenced accepted pair. Never replay part of an attempt.
 try {const code=readBytes(path.join(root,'accepted.build.py'),'utf8'),pair=read(path.join(root,'accepted.overlay.json')),receipt=read(path.join(root,'receipt.json'));const out={accepted:true,buildScript:code,overlaySpec:pair.spec,sha256:hash(code),receipt,calls:[]};verifyAuthorReceipt(out,input);return out;}catch{ /* new turn W */ }
  if(typeof deps.layoutCheck!=='function')throw authorError('author_layout_unavailable');
 const attempts=fs.readdirSync(root).filter(n=>/^a\d+$/.test(n)).map(n=>Number(n.slice(1)));
 const attempt=Math.max(attempts.length?Math.max(...attempts)+1:0,input.previewAttempt??0),stage=path.join(root,`a${attempt}`);fs.mkdirSync(stage);
 // codex · gpt-6.1-sol · 2026-11-19 15:11 +02:00: same host gates and caps; only the author transport and edit protocol change.
 const session=input.sessionEnabled===true?createAuthorSession({stageDir:input.stageDir,attemptDir:stage}):null;
 // codex | gpt-6.1-sol | 2026-11-19 19:33 +02:00: the final repair shares the first attempt's caps and clock.
 const priorState=input.finalExposureReturn===true?read(path.join(root,'session.json')):null,prior=priorState?.counters;
 const now=deps.now??Date.now,started=priorState?.startedAt??now()-(prior?.minutes??0)*60000,argvSha256=hash(JSON.stringify(session?sessionArgv(model,session.id,true):authorArgv(model))),calls=[],history=[];
 let spent=prior?.billableTotal??0,contextPeak=prior?.contextPeak??0,outputTotal=prior?.outputTotal??0,repairs=0,round=0,previews=0,code='',spec=null,feedback='',editRefusals=0,resynced=false;
 const journal=entry=>{const file=path.join(stage,'journal.jsonl');if(fs.existsSync(file))regular(file);fs.appendFileSync(file,JSON.stringify(entry)+'\n');};
 const state=status=>{const value={version:1,jobId:input.jobId,model,startedAt:started,cliVersion:input.probe?.cliVersion??null,argvSha256,switch:{env:true,job:'authored'},caps:measured.caps,counters:{calls:(prior?.calls??0)+calls.length,rounds:previews,minutes:(now()-started)/60000,billableTotal:spent,contextPeak,outputTotal},attempt,status};json(path.join(stage,'session.json'),value);json(path.join(root,'session.json'),value);};
 const guard=()=>{if(input.signal?.aborted)throw authorError('aborted');if(now()-started>3600000)throw authorError('author_time');if(spent>measured.caps.billableTotal)throw authorError('author_tokens');if(contextPeak>measured.caps.contextPeak)throw authorError('author_context_full');};
 const timed=async(kind,fn)=>{guard();const t=now();try{return await fn();}finally{journal({kind,round,wallS:(now()-t)/1000});}};
 const ask=async(prompt,images,kind,dir)=>{
  guard(); if((prior?.calls??0)+calls.length>=12)throw authorError('author_calls');if(prompt.length>200000 || images.length>4)throw authorError('author_context_full');
  const reserve=normalizeAuthorUsage(null,{promptChars:prompt.length,images:images.length,...measured.reserves}).reserve;
  if(spent+reserve>measured.caps.billableTotal)throw authorError('author_tokens');
  const n=calls.length,t=now();write(path.join(dir,`prompt-${n}.txt`),prompt);
  let answer;
  const expectedArgv=session?sessionArgv(model,session.id,session.started):authorArgv(model);
  // F8: Opus a0 write mwncecq0-53c79e timed out at 1200.190s; 30 minutes leaves room under the same one-hour guard.
  try {answer=await deps.askAuthor(prompt,images,{model,...(session?{session,maxBillableTokens:measured.caps.billableTotal-spent,maxContextTokens:measured.caps.contextPeak}:{}),signal:input.signal,timeoutMs:Math.max(1,Math.min(kind==='write'?(model==='opus'?1800000:1200000):600000,3600000-(now()-started)))});}
  catch(error){const usage=normalizeAuthorUsage(null,{promptChars:prompt.length,images:images.length,...measured.reserves});const entry={n,round,kind,status:'error',usage,reserve,spentBefore:spent,wallS:(now()-t)/1000};calls.push(entry);spent+=usage.billable;contextPeak=Math.max(contextPeak,usage.context);journal(entry);state('failed');deps.onCall?.(entry);throw error;}
  write(path.join(dir,`reply-${n}.txt`),answer.text);
  const usage=normalizeAuthorUsage(answer.rawUsage??answer.usage,{promptChars:prompt.length,images:images.length,...measured.reserves});
  // Session result usage sums many tool turns; context is the largest individual turn, billable usage stays summed.
  if(session&&Number.isFinite(answer.contextPeak)&&answer.contextPeak>0)usage.context=answer.contextPeak;
  const entry={n,round,kind,step:'author',provider:'claude',model,promptSha256:hash(prompt),replySha256:hash(answer.text),imageSha256:images.map(i=>hash(i.bytes)),usage,wallS:(now()-t)/1000,receipt:answer.receipt,spentBefore:spent,reserve,promptChars:prompt.length,replyChars:answer.text.length,image_tokens_seen:images.length?Math.max(0,usage.context-Math.ceil(prompt.length/3))/images.length:null};
  calls.push(entry);spent+=usage.billable;contextPeak=Math.max(contextPeak,usage.context);outputTotal+=usage.output_tokens;journal(entry);deps.onCall?.(entry);state('running');guard();
  const rc=answer.receipt;
  if(!rc || rc.argvSha256!==hash(JSON.stringify(expectedArgv)) || rc.promptSha256!==hash(prompt) || JSON.stringify(rc.imageSha256)!==JSON.stringify(entry.imageSha256) || rc.imageCount!==images.length || rc.toolsOffered!==(session?3:0) || rc.noSessionPersistence!==!session || rc.transport!==(session?'author-session':'stdin-image-blocks') || (session&&rc.sessionId!==session.id))throw authorError('author_receipt');
  return answer.text;
 };
 const refused=error=>{if(repairs>=3)throw authorError('author_reply');repairs++;feedback=String(error.message).replace(/(?:[A-Za-z]:[\\/]|\/)[^\s]*/g,'<path>').slice(0,1000);journal({kind:'refused',round,reason:feedback});};
 state('running');
 try {
  if(input.probe?.passed!==true)throw authorError('author_transport_unavailable');
  const writeDir=path.join(stage,'write');fs.mkdirSync(writeDir);
  while(!code){const prompt=session?(session.started?`Repair the scene/overlay files and preview request: ${feedback}`:`${input.writePrompt}\n${input.repairPrompt??''}\n${SESSION_HEADER}`):`${AUTHOR_HEADER}\n${input.writePrompt}\n${input.repairPrompt??''}\n${feedback}`;
   const text=await ask(prompt,[],'write',writeDir);try{const pair=session?readSessionPair(session):writePair(text,input.nframes/30);pairCheck(pair.buildScript,pair.overlaySpec,input);code=pair.buildScript;spec=pair.overlaySpec;feedback='';}catch(error){refused(error);}}
  const shots=input.shots.map((s,i)=>({...s,id:`shot-${i}`}));
  for(round=0;round<5;round++){
   guard();const pair=pairCheck(code,spec,input);spec=pair.spec;
   // Fix 3: the frames follow the CURRENT overlay spec, so every big, tag, bars and counter window holds a frame the author sees.
   let {frames,uncovered}=(deps.pickFrames??pickAuthoredPreviewFrames)({nframes:input.nframes,shotStarts:input.shotStarts,fps:30,overlaySpec:spec});
   if(session){consumePreviewRequest(session);frames=smallSessionFrames({...input,overlaySpec:spec},frames);}
   const dir=path.join(stage,`r${round}`);fs.mkdirSync(dir);write(path.join(dir,'build.py'),code);json(path.join(dir,'overlay.json'),pair);
   const sha256=hash(code),overlaySha256=hash(JSON.stringify(spec)),previewId=`${input.jobId}-a${attempt}-pv${round+1}`;
   previews++;deps.onPhase?.('previewing');let preview=null,crash=null;
   try{preview=await timed('preview',()=>deps.runPreview({jobId:previewId,buildScript:code,overlaySpec:spec,spec:{frames,scale:50},signal:input.signal}));}
   catch(error){if(!['FENCE_FAILED','AGENT_EARLY_STOP','MISSING_OUTPUT','TIMEOUT'].includes(error.code)||error.detail?.backstop)throw error;crash=String(error.diagnostic??error.code).slice(0,2000);}
   guard();let sheets=[],kit=null,timing=null,layout=null;
   if(preview){
    kit=sanitizeKitReport((deps.readKitReport??readKitReport)(preview.dir),shots.length);
    const work=path.join(path.dirname(preview.dir),'work'),anchors=path.join(work,'anchors-preview.json');
    if(fs.existsSync(anchors)){regular(anchors);fs.copyFileSync(anchors,path.join(dir,'anchors-preview.json'));}
    const raw=path.join(dir,'overlay-spec.json');json(raw,spec);
    const words=path.join(dir,'words.json');if(input.wordsPath){regular(input.wordsPath);fs.copyFileSync(input.wordsPath,words);}
    deps.onPhase?.('looking');
    sheets=await timed('sheet',()=>deps.makeSheets({framesDir:preview.dir,outDir:path.join(dir,'sheets'),code:(deps.newCode??newSheetCode)(),signal:input.signal,overlaySpec:raw,nframes:input.nframes,fps:30,jobRoot:dir,...(input.wordsPath?{words,lead:0.35}:{}),...(fs.existsSync(path.join(dir,'anchors-preview.json'))?{anchors:path.join(dir,'anchors-preview.json')}:{})}));
    // Fix 1: the post step's own layout algorithm on EVERY frame, on the exact spec just previewed. Fail closed when it cannot run.
    // C2-AUTH-1: labels and measures are laid out on EVERY frame from the exported positions of the whole video; a spec with such elements and no complete export fails closed.
    const anchorsCopy=path.join(dir,'anchors-preview.json'),shown=sheets.flatMap(s=>s.tiles.map(t=>t.frame)).filter(Number.isInteger);
    let layoutAnchors=fs.existsSync(anchorsCopy)?anchorsCopy:undefined,layoutFrames=shown;
    if(needsPose(spec)){
     const doneSrc=path.join(work,'anchors-all.done.json'),allSrc=path.join(work,'anchors-all.json'),allCopy=path.join(dir,'anchors-all.json');
     if(fs.existsSync(doneSrc)){regular(doneSrc);fs.copyFileSync(doneSrc,path.join(dir,'anchors-all.done.json'));}
     const pose=poseRecord(dir,input.nframes);
     if(pose?.anchors){if(fs.existsSync(allSrc)){regular(allSrc);fs.copyFileSync(allSrc,allCopy);}}
     if(!pose||(pose.anchors&&!fs.existsSync(allCopy)))throw Object.assign(authorError('author_layout_unavailable'),{detail:{reason:'anchor_export_missing'}});
     layoutAnchors=pose.anchors?allCopy:undefined;layoutFrames='all';
    }
    layout={...await timed('layout',()=>deps.layoutCheck({overlaySpec:raw,nframes:input.nframes,fps:30,jobRoot:dir,frames:layoutFrames,lead:0.35,signal:input.signal,...(input.wordsPath?{words}:{}),...(layoutAnchors?{anchors:layoutAnchors}:{})})),uncovered};
    guard();journal({kind:'layout',round,ok:layout.ok,blocking:layout.blocking.length,labelHidden:layout.labelHidden.length,uncovered});
    try{const t=read(path.join(work,'render-timing.json'));if(!Number.isFinite(t.render_s)||!(t.rendered>0))throw Error();timing=t.render_s/t.rendered*4;journal({kind:'render_timing',round,secondsPerFrame:timing});}catch{journal({kind:'render_timing_unavailable',round});}
   }
   const sheetRecords=sheets.map((s,i)=>{const file=`sheet-${i}.jpg`,bytes=readBytes(s.path);write(path.join(dir,'sheets',file),bytes);return {file,sha256:hash(bytes)};});
   const images=sheetRecords.map(s=>({bytes:readBytes(path.join(dir,'sheets',s.file)),mediaType:'image/jpeg'}));
   if(session){
    for(const [i,s] of sheetRecords.entries())write(sessionPath(session,`sheet-${i}.jpg`),readBytes(path.join(dir,'sheets',s.file)));
    json(sessionPath(session,'findings.json'),{round,crash,layout,kit,exposure:sheets.map(s=>s.tiles),exposureAdvice:exposureAdvice(sheets,input.exposureFindings)});
   }
   json(path.join(dir,'preview.json'),{sha256,overlaySha256,jobId:previewId,frames,rendered:preview?.frames??[],sheets:sheetRecords});
   let reply;
   for(;;){
    let replay=history.slice();
    const flatNums=sheets.flatMap(s=>s.tiles.filter(t=>t.flag==='flat'||t.flag==='plain').map(t=>`T${t.n} (${t.flag})`));
    // Fix 5: the budget is told in both directions. Under half of it with flat or plain surfaces measured is a finding.
    const unused=Number.isFinite(timing)&&Number.isFinite(input.renderBudget)&&input.renderBudget>0&&timing<input.renderBudget/2&&flatNums.length>0;
    if(unused)journal({kind:'budget_unused',round,secondsPerFrame:timing,budget:input.renderBudget});
    const budgetText=unused?`budget_unused: ${timing.toFixed(2)} s/frame is under half of the ${input.renderBudget} s/frame budget while ${flatNums.join(', ')} measure as flat or plain. The budget is meant to be spent: enrich the single largest hero surface (bands, bump, a colour ramp, more geometry, light) until a preview costs near the budget. The ceiling is unchanged.`:'';
    const layoutText=layout?layoutRefusal(layout):'';
    const makePrompt=()=>AUTHOR_HEADER+'\n'+authorState({buildScript:code,overlaySpec:spec,sha256,history:replay,round,minutesLeft:Math.max(0,60-(now()-started)/60000)})+'\n'+buildLookPrompt({brief:input.brief,script:input.script,shots,buildScript:code,kitContract:input.kitContract,sheets,shotStarts:input.shotStarts,round,finalRound:round===4,qaText:crash,previous:replay,kit,layoutFindings:sheets.flatMap(s=>s.layout_findings??[])})+exposureAdvice(sheets,input.exposureFindings)+`\nWrap that exact look object in {look,notes,overlay?}. ${timing>input.renderBudget?`render_too_slow: ${timing} s/frame`:''}${budgetText?`\n${budgetText}`:''}${layoutText?`\n${layoutText}`:''}\n${feedback}`;
    const sessionPrompt=()=>sessionLookPrompt({shots,sheets,shotStarts:input.shotStarts,round,finalRound:round===4,qaText:crash,kit,layoutFindings:sheets.flatMap(s=>s.layout_findings??[])})+exposureAdvice(sheets,input.exposureFindings)+`\n${budgetText}\n${layoutText}\n${timing>input.renderBudget?`render_too_slow: ${timing} s/frame`:''}\n${feedback}`;
    let prompt=session?sessionPrompt():makePrompt();while(prompt.length>200000&&replay.length){replay.shift();prompt=session?sessionPrompt():makePrompt();}
    const text=await ask(prompt,images,editRefusals>=2&&!resynced?'resync':'look',dir);if(editRefusals>=2)resynced=true;
    try{reply=parseAuthorLook(text,{buildScript:code,overlaySpec:spec,validate:(c,s)=>{pairCheck(c,s,input);return [];},videoSeconds:input.nframes/30,shots,sheetCodes:[...new Set(sheets.map(s=>s.code))],finalRound:!!session||round===4,flatTiles:sheets.flatMap(s=>s.tiles.filter(t=>t.flag==='flat').map(t=>t.n)),kitFailures:kit?.findings.map(f=>f.check)??[]});
     if(session){
      const next=readSessionPair(session);next.overlaySpec=pairCheck(next.buildScript,next.overlaySpec,input).spec;
      if(reply.look.verdict==='pass'){
       if(next.buildScript!==code||JSON.stringify(next.overlaySpec)!==JSON.stringify(spec)||fs.existsSync(sessionPath(session,'render.request.json')))throw authorError('author_hash');
      }else{reply.buildScript=next.buildScript;reply.overlaySpec=next.overlaySpec;}
     }
     // Fix 6: a pass is not accepted while the host's all-frame layout says otherwise (blocking overlap, safe zone, caption, a label hidden on every previewed frame of its window).
     if(reply.look.verdict==='pass'&&layout){const why=layoutRefusal(layout);if(why)throw Error(why);}
     break;}
    catch(error){editRefusals++;refused(error);}
   }
   feedback='';editRefusals=0;
   journal({kind:'validation',round,sha256,overlaySha256,verdict:reply.look.verdict});
   history.push({round,notes:reply.notes,findings:reply.look.findings,targets:reply.look.targets,verdict:reply.look.verdict,kitChecks:kit?.findings.map(f=>f.check)??[]});
   json(path.join(dir,'look.json'),{sha256,overlaySha256,verdict:reply.look.verdict,sheets:sheetRecords,sheetCodes:[...new Set(sheets.map(s=>s.code))],kitFailures:kit?.findings.map(f=>f.check)??[],flatTiles:sheets.flatMap(s=>s.tiles.filter(t=>t.flag==='flat').map(t=>t.n)),layout,call:calls.at(-1),reply:reply.look});write(path.join(dir,'notes.txt'),reply.notes);
   if(reply.look.verdict==='pass'){
    guard();if(readBytes(path.join(dir,'build.py'),'utf8')!==code || JSON.stringify(read(path.join(dir,'overlay.json')))!==JSON.stringify(pair))throw authorError('author_hash');
    write(path.join(root,'accepted.build.py'),code);json(path.join(root,'accepted.overlay.json'),pair);
    const receipt={version:1,identity:authorIdentity(input),accepted:true,sha256,overlaySha256,argvSha256,attempt,round,rounds:history,calls:calls.length,layoutSha256:hash(JSON.stringify(layout)),...(session?{sessionId:session.id}:{})};json(path.join(root,'receipt.json'),receipt);
    const out={accepted:true,buildScript:readBytes(path.join(root,'accepted.build.py'),'utf8'),overlaySpec:spec,sha256,receipt,calls};verifyAuthorReceipt(out,input);state('accepted');return out;
   }
   code=reply.buildScript;spec=reply.overlaySpec;
  }
  throw authorError('author_rounds');
 }catch(error){state(error.code??'author_failed');json(path.join(stage,'error.json'),{code:error.code??'author_failed'});throw error;}
}
// Integration adapter: direction is separate; all preview/sheet/transport effects remain injectable.
export async function runAuthorFor({rec,stage,signal,scripted,voice,pathPack,pl,runtime,jobsDir,hostExecFile,injected={},addCall,onPhase}) {
 const {askAuthor,askAuthorSession,probeAuthorSupport,checkAuthorConfig}=await import('./authorCall.js');
 const {createPreviewSheetMaker}=await import('./previewSheet.js');
 const {createPreviewRunFn}=await import('../engines/codebuilt/composePreview.js');
 const {directionMarkdown}=await import('./direction.js');
 // codex · gpt-6.1-sol · 2026-11-19 08:07 +02:00: reuse the run's buildModel; Auto keeps Sonnet, unsupported authors fail closed.
 const model=(!rec.buildModel||rec.buildModel==='Auto')?'sonnet':rec.buildModel.toLowerCase();authorArgv(model);
 const measurementMode=injected.measurementMode===true; // code-only: createCodebuiltStarter's authorLoop option, never a request field
 authorCaps({capsFile:injected.capsFile,measurementMode,caps:injected.caps});checkAuthorConfig(injected);
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
 const plan={nframes,shotStarts,places,direction,directionMarkdown:directionMarkdown(direction,shotStarts,nframes/30),lookShots:direction.shots.map(s=>({subject:s.shows??s.action??'subject',narration:direction.narrations?.[direction.shots.indexOf(s)]??'recorded narration'})),kitContract:pl.AUTHOR_KIT_CONTRACT??pl.KIT_CONTRACT};
 const validate=(code,spec)=>{
  const why=pl.validateBuildScript(code,{route:'authored',nframes,shotStarts,places,type:rec.choices?.type,overlay:true,overlaySpec:spec});
  if(!why.length){const bad=pl.pythonSyntaxCheck(code);if(bad)why.push(bad);}
  if(!why.length){const bad=pl.pythonQaStructureCheck(code,{expect:{shotStarts,nframes}});if(Array.isArray(bad))why.push(...bad);}
  return why;
 };
 const input={finalExposureReturn:rec.exposure_return===true,exposureFindings:rec.exposure_check?.findings??[],jobId:rec.id,model,stageDir:stage,capsFile:injected.capsFile,measurementMode,caps:injected.caps,previewAttempt:rec.resumes?.length??0,signal,probe,nframes,shotStarts,shots:plan.lookShots,brief:scripted.brief+'\n'+plan.directionMarkdown,script:scripted.script,kitContract:pl.AUTHOR_KIT_CONTRACT??pl.KIT_CONTRACT,wordsPath:voice.wordsPath,renderBudget:pathPack.rules.routes.overlay.render.RENDER_BUDGET_S_PER_FRAME,validate,writePrompt:pl.authorBuildPrompt({topic:rec.topic,duration:rec.duration,script:scripted.script,brief:scripted.brief,words,pathPack,formats:rec.formats,choices:rec.choices,direction,shotStarts,nframes})};
 if(input.finalExposureReturn){
  const previousCode=readBytes(path.join(stage,'author','accepted.build.py'),'utf8'),previousOverlay=read(path.join(stage,'author','accepted.overlay.json')).spec;
  input.repairPrompt=`\nFINAL EXPOSURE REPAIR (the only return for this video): rebuild the accepted scene to fix these final-sheet findings, then request a preview. Keep narration and direction unchanged.\n${input.exposureFindings.join('\n')}\nACCEPTED SCENE:\n${previousCode}\nACCEPTED OVERLAY:\n${JSON.stringify(previousOverlay)}`;
 }
 input.sessionEnabled=process.env.FORGEAI_AUTHOR_SESSION==='1';
 try {const receipt=read(path.join(stage,'author','receipt.json')),code=readBytes(path.join(stage,'author','accepted.build.py'),'utf8'),pair=read(path.join(stage,'author','accepted.overlay.json'));verifyAuthorReceipt({accepted:true,buildScript:code,overlaySpec:pair.spec,sha256:hash(code),receipt},input);probe={passed:true};}catch{}
 if(!probe)probe=injected.probe ? await injected.probe({rec,stage,signal,model}) : await probeAuthorSupport({model,stageDir:path.join(stage,'author'),nonce:cryptoNonce(),makeCanary:sheetMaker.makeCanary,askFn:ask,signal});
 input.probe=probe;
 const base=injected.runPreview??(request=>createPreviewRunFn({runner:{run:args=>runtime.runner.run({...args,route:'authored',overlaySpec:request.overlaySpec})},inputs:{script:scripted.script,voWav:voice.voPath,words:voice.wordsPath,pathPack,brief:scripted.brief},jobRoot:jobsDir})(request));
 const layoutCheck=injected.layoutCheck??createLayoutGate({execFileFn:hostExecFile}).check;
 const sessionAsk=injected.askAuthorSession??((p,i,o)=>askAuthorSession(p,i,{...injected,...o}));
 const outcome=await runAuthorLoop(input,{...injected,layoutCheck,askAuthor:input.sessionEnabled?sessionAsk:ask,runPreview:request=>base({...request,route:'authored'}),makeSheets:args=>sheetMaker.makeSheets(args),onCall:addCall,onPhase});
 // codex - gpt-6.1-sol - 2026-11-18 11:57 +02:00: D2 is a forecast gate, including accepted final retries.
 const verifyReceipt=()=>{
  verifyAuthorReceipt(outcome,input);
  const ceiling=pathPack.rules.routes.overlay.render.maxFinalMinutes;
  if(ceiling!==undefined){
   let timing;
   try {
    const journal=readBytes(path.join(stage,'author',`a${outcome.receipt.attempt}`,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    timing=journal.findLast(entry=>entry.round===outcome.receipt.round && ['render_timing','render_timing_unavailable'].includes(entry.kind))?.secondsPerFrame;
   }catch{ /* Without the accepted preview's timing, D2 cannot establish an estimate. */ }
   if(!Number.isFinite(timing)||timing<=0)throw Object.assign(authorError('author_render_over_ceiling'),{detail:{reason:'render_timing_unavailable'}});
   if(!Number.isFinite(ceiling)||ceiling<=0||!Number.isInteger(nframes)||nframes<=0||timing*nframes>ceiling*60)throw authorError('author_render_over_ceiling');
  }
  return true;
 };
 verifyReceipt();
 return {...plan,...outcome,verifyReceipt};
}
function cryptoNonce(){return hash(`${Date.now()}-${newSheetCode()}`).slice(0,32);}
