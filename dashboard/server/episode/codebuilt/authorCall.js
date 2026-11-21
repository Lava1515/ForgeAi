// codex · gpt-6.1-sol · 2026-11-17 22:46 +02:00
// codex · gpt-6.1-sol · 2026-11-17 23:21 +02:00: A2-proven safe mode, confined cwd, incremental event gate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askClaudeLook, lookArgv, PROBE_PROMPT, readCliVersion } from './lookCall.js';
import { killTree } from './lookCall.js';
import { binPath, claudeEnv, usageFrom, LIMIT_TEXT } from '../../routes/claudeCli.js';
import { sessionArgv, SESSION_TOOLS, sessionPath } from './authorSession.js';
export const AUTHOR_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const hash = data => crypto.createHash('sha256').update(data).digest('hex');
export const authorError = code => Object.assign(new Error(code), {code});
export function authorArgv(model = 'sonnet') {
 // codex · gpt-6.1-sol · 2026-11-19 08:07 +02:00: per-run authors share the same confined transport.
 if(!['sonnet','opus'].includes(model)) throw authorError('author_model_unavailable');
 return [...lookArgv(model),'--safe-mode'];
}
export function normalizeAuthorUsage(raw, {promptChars, images, IMAGE_RESERVE=4000, OUTPUT_RESERVE=40000}) {
 const E=Math.ceil(promptChars/3)+images*IMAGE_RESERVE, reserve=E+OUTPUT_RESERVE;
 const valid=n=>typeof n==='number' && Number.isFinite(n) && n>=0;
 const keys=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'];
 const usable=raw && keys.some(k=>valid(raw[k]));
 if(!usable) return {raw:raw??null,input_tokens:E,output_tokens:OUTPUT_RESERVE,billable:reserve,context:E,reserve,estimated:true};
 const [i,c,r,o]=keys.map(k=>valid(raw[k])?raw[k]:null);
 const I=(i??E)+(c===null?E:0)+(r===null?E:0);
 return {raw,input_tokens:I,cache_creation_input_tokens:c??0,cache_read_input_tokens:r??0,output_tokens:o??OUTPUT_RESERVE,billable:I+(c??0)+(o??OUTPUT_RESERVE),context:I+(c??0)+(r??0),reserve,estimated:[i,c,r,o].includes(null)};
}
export function checkAuthorConfig({repoRoot=AUTHOR_REPO,configDir=process.env.CLAUDE_CONFIG_DIR}={}) {
 try {const repo=fs.realpathSync(repoRoot), config=fs.realpathSync(configDir); const rel=path.relative(repo,config);
 if(!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(config).isDirectory()) throw Error(); return config;
 }catch{throw authorError('author_state_outside_code');}
}
const hasTool=value=>value && typeof value==='object' && (/tool_(use|result)$/.test(value.type) || Object.values(value).some(hasTool));
// Resolve every existing ancestor before creating a child: mkdir recursive could write through a junction.
function confinedWorkRoot(target,repoRoot) {
 try {
  const repo=fs.realpathSync(repoRoot), absolute=path.resolve(target);
  const inside=p=>{const rel=path.relative(repo,p);return rel && rel!=='..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);};
  if(!inside(absolute))throw Error();
  const missing=[];let cursor=absolute;
  while(!fs.existsSync(cursor)){missing.push(path.basename(cursor));cursor=path.dirname(cursor);}
  cursor=fs.realpathSync(cursor);
  if(cursor!==repo && !inside(cursor))throw Error();
  if(!fs.statSync(cursor).isDirectory())throw Error();
  for(const name of missing.reverse()){
   cursor=path.join(cursor,name);fs.mkdirSync(cursor);
   cursor=fs.realpathSync(cursor);if(!inside(cursor)||!fs.statSync(cursor).isDirectory())throw Error();
  }
  if(!inside(cursor))throw Error();return cursor;
 }catch{throw authorError('author_state_outside_code');}
}
export async function askAuthor(prompt,images,options={}) {
 const model=options.model??'sonnet'; authorArgv(model);
 const config=checkAuthorConfig(options);
 if(process.env.NODE_TEST_CONTEXT && !options.spawnFn) throw authorError('author_transport_unavailable');
 const workRoot=confinedWorkRoot(options.workRoot??path.join(config,'author-work'),options.repoRoot??AUTHOR_REPO);
 const home=fs.mkdtempSync(path.join(workRoot,'call-')); let pending=[], size=0, tool=false, overflow=false, init=null, result=null;
 const scan=line=>{try{const e=JSON.parse(line);if(hasTool(e))tool=true;if(!init&&e.type==='system'&&e.subtype==='init')init=e;if(e.type==='result')result=e;}catch{ /* partial or non-JSON */ }};
 const flush=()=>{if(pending.length){scan(pending.join(''));pending=[];}};
 const spawnFn=(bin,args,opts)=>{
  const child=(options.spawnFn??spawn)(bin,args,{...opts,env:{...opts.env,CLAUDE_CONFIG_DIR:config}});
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data',data=>{
   size+=data.length;if(size>20*1024*1024){overflow=true;return;}
   let start=0,end;while((end=data.indexOf('\n',start))!==-1){pending.push(data.slice(start,end));scan(pending.join(''));pending=[];start=end+1;}
   if(start<data.length)pending.push(data.slice(start));
  });
  child.on('close',flush);
  return child;
 };
 let answer;
 try{answer=await askClaudeLook(prompt,images,{...options,model,allowNoImages:true,safeMode:true,claudeHome:home,spawnFn});}
 catch(error){flush();if(tool) throw authorError('author_tool_event'); throw error;}
 if(tool) throw authorError('author_tool_event');
 if(overflow)throw authorError('author_context_full');
 if(!init || !['tools','mcp_servers','skills'].every(k=>Array.isArray(init[k])&&init[k].length===0)) throw authorError('tools_offered');
 return {...answer,rawUsage:result?.usage??null};
}
const probes=new Map();
// codex · gpt-6.1-sol · 2026-11-19 15:11 +02:00: restrict the CLI before its first model turn, then resume this exact session.
export async function askAuthorSession(prompt,images,{session,model='sonnet',timeoutMs=600000,maxBillableTokens=Infinity,maxContextTokens=Infinity,signal,spawnFn=spawn,platform=process.platform,...options}={}) {
 const config=checkAuthorConfig(options), argv=sessionArgv(model,session.id,session.started);
 sessionPath(session,'build.py');
 if(process.env.NODE_TEST_CONTEXT && spawnFn===spawn)throw authorError('author_transport_unavailable');
 if(signal?.aborted)throw authorError('aborted');
 if(typeof prompt!=='string'||prompt.length>200000||images.length>4)throw authorError('author_context_full');
 const message=JSON.stringify({type:'user',message:{role:'user',content:[...images.map(i=>({type:'image',source:{type:'base64',media_type:i.mediaType,data:i.bytes.toString('base64')}})),{type:'text',text:prompt}]}});
 return new Promise((resolve,reject)=>{
  let child,buffer='',size=0,result=null,init=null,done=false,timer,contextPeak=0;
  const messageUsage=new Map();
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const stop=code=>{killTree(child);finish(authorError(code));};
  const abort=()=>stop('aborted');
  const scan=line=>{
   let e;try{e=JSON.parse(line);}catch{return;}
   if(e.type==='system'&&e.subtype==='init'){
    init=e;
    if(e.session_id!==session.id || JSON.stringify([...(e.tools??[])].sort())!==JSON.stringify([...SESSION_TOOLS].sort()) || !['mcp_servers','skills'].every(k=>Array.isArray(e[k])&&e[k].length===0))stop('tools_offered');
   }
   // A session call can take multiple tool turns. Enforce the existing run caps between those turns too.
   if(e.type==='assistant'&&e.message?.usage){
    const usage=normalizeAuthorUsage(e.message.usage,{promptChars:0,images:0,IMAGE_RESERVE:0,OUTPUT_RESERVE:0});
    contextPeak=Math.max(contextPeak,usage.context);
    if(usage.context>maxContextTokens)return stop('author_context_full');
    messageUsage.set(e.message.id??messageUsage.size,usage.billable);
    if([...messageUsage.values()].reduce((a,b)=>a+b,0)>maxBillableTokens)return stop('author_tokens');
   }
   // Defense in depth. --restricted and dontAsk enforce the file policy before a tool runs.
   for(const block of e.message?.content??[])if(block.type==='tool_use'){
    try{if(!init||!SESSION_TOOLS.includes(block.name))throw Error();
     const name=path.relative(session.cwd,path.resolve(session.cwd,block.input?.file_path??''));
     sessionPath(session,name);
     if(block.name!=='Read'&&!['build.py','overlay.json','render.request.json'].includes(name))throw Error();
    }catch{stop('author_tool_event');}
   }
   if(e.type==='result')result=e;
  };
  try{
   // Fixed/validated argv only through the Windows .cmd shim: prompts and author paths never enter a shell.
   const args=platform==='win32'?argv.map(a=>{if(!/^[A-Za-z0-9._:=/\\,()-]+$/.test(a))throw authorError('author_receipt');return /[,()]/.test(a)?`"${a}"`:a;}):argv;
   const bin=binPath();
   child=spawnFn(platform==='win32'&&/\s/.test(bin)?`"${bin}"`:bin,args,{env:{...claudeEnv(),CLAUDE_CONFIG_DIR:config},cwd:session.cwd,shell:platform==='win32',windowsHide:true,detached:platform!=='win32'});
  }catch{finish(authorError('author_transport_unavailable'));return;}
  timer=setTimeout(()=>stop('author_time'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data',data=>{size+=data.length;if(size>20*1024*1024)return stop('author_context_full');buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){scan(buffer.slice(0,end));buffer=buffer.slice(end+1);if(done)break;}});
  child.stderr?.on('data',()=>{});
  child.on('error',()=>finish(authorError('author_transport_unavailable')));
  child.on('close',code=>{
   if(done)return;if(buffer)scan(buffer);if(done)return;
   if(!init) return finish(authorError('tools_offered'));
   if(code!==0||!result||result.is_error||result.session_id!==session.id){
    const error=authorError('author_transport_unavailable');
    if(LIMIT_TEXT.test(String(result?.result)))error.quota=true;
    return finish(error);
   }
   session.started=true;
   finish(null,{text:String(result.result??''),rawUsage:result.usage??usageFrom(result),contextPeak:contextPeak||undefined,model,
    receipt:{argvSha256:hash(JSON.stringify(argv)),promptSha256:hash(prompt),imageCount:images.length,imageSha256:images.map(i=>hash(i.bytes)),toolsOffered:3,noSessionPersistence:false,transport:'author-session',sessionId:session.id}});
  });
  child.stdin?.end(message+'\n');
 });
}
export async function probeAuthorSupport(options={}) {
 const model=options.model??'sonnet'; authorArgv(model);
 const version=await (options.cliVersion??readCliVersion)();
 const key=`${version}|${hash(JSON.stringify(authorArgv(model)))}`; fs.mkdirSync(options.stageDir,{recursive:true});
 let result=probes.get(key);
 if(!result){
  const askFn=options.askFn??askAuthor;
  const canary=await options.makeCanary({nonce:options.nonce,outFile:path.join(options.stageDir,'probe-canary.png'),signal:options.signal});
  const pixels=fs.readFileSync(canary.file);
  const image=await askFn(PROBE_PROMPT,[{bytes:pixels,mediaType:'image/png'}],{model,timeoutMs:120000,signal:options.signal});
  const match=/\{[\s\S]*\}/.exec(image.text);let got;try{got=JSON.parse(match?.[0]);}catch{}
  if(got?.code!==canary.code || !['top_left','top_right','bottom_left','bottom_right'].every(k=>got.quadrants?.[k]===canary.quadrants[k]) || image.receipt?.argvSha256!==hash(JSON.stringify(authorArgv(model))) || image.receipt.imageSha256?.[0]!==hash(pixels))throw authorError('author_transport_unavailable');
  const vision={passed:true,expected:{code:canary.code,quadrants:canary.quadrants},got,receipt:image.receipt,usage:image.rawUsage??image.usage};
  const nonce=crypto.randomBytes(12).toString('hex');
  const text=await askFn(`Reply with exactly this text: ${nonce}`,[],{model,timeoutMs:120000,signal:options.signal});
  if(text.text.trim()!==nonce || text.receipt.argvSha256!==hash(JSON.stringify(authorArgv(model)))) throw authorError('author_transport_unavailable');
  result={passed:true,cliVersion:version,argvSha256:text.receipt.argvSha256,vision,textReceipt:text.receipt};
  probes.set(key,result);
 }
 fs.writeFileSync(path.join(options.stageDir,'probe.json'),JSON.stringify(result,null,2)+'\n'); return result;
}
