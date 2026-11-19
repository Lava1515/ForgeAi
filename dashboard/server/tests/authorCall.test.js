// codex - gpt-6.1-sol - 2026-11-17 22:59 +02:00: A1 transport, caps and authored route regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { authorArgv, askAuthor, normalizeAuthorUsage } from '../episode/codebuilt/authorCall.js';
import { lookArgv, askClaudeLook } from '../episode/codebuilt/lookCall.js';
const root = 'C:/code/ForgeAi/output/agent-jobs/a1-fix1';
const config = path.join(root,'fake-config'); fs.mkdirSync(config,{recursive:true});
const spawnFor = (events, inspect=()=>{}) => (bin,args,opts) => {
 inspect(args,opts); const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
 p.stdin = {end(){ queueMicrotask(()=> {p.stdout.write(events.map(x=>JSON.stringify(x)).join('\n')); p.emit('close',0);});}}; return p;
};
const init = {type:'system',subtype:'init',tools:[],skills:[],mcp_servers:[],model:'sonnet'};
const result = {type:'result',result:'ok',usage:{input_tokens:100,output_tokens:20}};
// codex · gpt-6.1-sol · 2026-11-19 08:07 +02:00: update the existing allowlist assertion for the second allowed author.
test('fixed argv allows only Sonnet and Opus',()=> {for(const model of ['sonnet','opus']) assert.deepEqual(authorArgv(model),[...lookArgv(model),'--safe-mode']); for(const s of ['fable','sonnet --tools Bash','']) assert.throws(()=>authorArgv(s));});
test('partial raw cache counters charged conservatively; zero is known',()=> {
 assert.equal(normalizeAuthorUsage({input_tokens:100,output_tokens:20},{promptChars:3000,images:0}).billable,2120);
 assert.equal(normalizeAuthorUsage({...result.usage,cache_read_input_tokens:0,cache_creation_input_tokens:0},{promptChars:3000,images:0}).billable,120);
 assert.equal(normalizeAuthorUsage(null,{promptChars:3000,images:0}).billable,41000);
});
test('look default refuses text only',async()=>{await assert.rejects(askClaudeLook('hello',[],{model:'sonnet'}));});
test('author uses empty cwd, stripped keys, raw usage and confined config',async()=>{
 process.env.ANTHROPIC_API_KEY='fake-test-key';
 try {const r=await askAuthor('hello',[],{repoRoot:'C:/code/ForgeAi',configDir:config,workRoot:root,spawnFn:spawnFor([init,result],(args,opts)=>{assert.ok(args.includes('--safe-mode')); assert.deepEqual(fs.readdirSync(opts.cwd),[]); assert.equal(opts.env.ANTHROPIC_API_KEY,undefined); assert.equal(opts.env.CLAUDE_CONFIG_DIR,fs.realpathSync(config));})}); assert.deepEqual(r.rawUsage,result.usage);}finally{delete process.env.ANTHROPIC_API_KEY;}
 await assert.rejects(askAuthor('hello',[],{repoRoot:root,configDir:'C:/Users',workRoot:root}),{code:'author_state_outside_code'});
});
for (const field of ['tools','skills','mcp_servers']) test(`reject offered ${field}`,async()=> {await assert.rejects(askAuthor('hello',[],{repoRoot:'C:/code/ForgeAi',configDir:config,workRoot:root,spawnFn:spawnFor([{...init,[field]:['bad']},result])}),{code:'tools_offered'});});
for (const type of ['tool_use','tool_result','server_tool_use','mcp_tool_use','mcp_tool_result','web_search_tool_result','code_execution_tool_result']) test(`reject nested ${type}`,async()=>{await assert.rejects(askAuthor('hello',[],{repoRoot:'C:/code/ForgeAi',configDir:config,workRoot:root,spawnFn:spawnFor([init,{type:'assistant',message:{content:[{type}]}},result])}),{code:'author_tool_event'});});
test('raw partial counters: one absent, output absent and unknown cache context',()=>{
 assert.equal(normalizeAuthorUsage({input_tokens:100,output_tokens:20,cache_read_input_tokens:0},{promptChars:3000,images:0}).billable,1120);
 assert.equal(normalizeAuthorUsage({input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0},{promptChars:3000,images:0}).billable,40100);
 assert.equal(normalizeAuthorUsage({input_tokens:899999,output_tokens:0},{promptChars:6,images:0}).context,900003);
});
import {probeAuthorSupport} from '../episode/codebuilt/authorCall.js';
test('author probe makes its own image and nonce calls and caches only by CLI version',async()=>{
 const dir=fs.mkdtempSync(path.join(root,'probe-'));let calls=0;
 const options={stageDir:dir,nonce:'test',cliVersion:async()=> 'a1-fake-version',makeCanary:async({outFile})=>{fs.writeFileSync(outFile,'pixels');return {file:outFile,code:'ABCDE',quadrants:{top_left:'red',top_right:'green',bottom_left:'blue',bottom_right:'yellow'}};},askFn:async(prompt,images)=>{calls++;return {text:images.length?JSON.stringify({code:'ABCDE',quadrants:{top_left:'red',top_right:'green',bottom_left:'blue',bottom_right:'yellow'}}):prompt.split(': ').at(-1),receipt:{argvSha256:(await import('../episode/codebuilt/authorCall.js')).hash(JSON.stringify(authorArgv())),imageSha256:images.map(i=>(awaitHash(i.bytes)))}};}};
 assert.equal((await probeAuthorSupport(options)).passed,true);await probeAuthorSupport(options);assert.equal(calls,2);
});
import crypto from 'node:crypto';
const awaitHash=data=>crypto.createHash('sha256').update(data).digest('hex');

// codex - gpt-6.1-sol - 2026-11-17 23:21 +02:00: A2 regressions, fake processes only.
test('safe mode reaches actual spawn and receipt; classic argv stays unchanged',async()=>{
 let actual;
 const r=await askAuthor('hello',[],{repoRoot:root,configDir:config,workRoot:path.join(root,'work'),safeMode:false,spawnFn:spawnFor([init,result],args=>{actual=args;})});
 assert.deepEqual(actual,authorArgv().map(a=>a===''?'""':a));assert.equal(r.receipt.argvSha256,awaitHash(JSON.stringify(authorArgv())));
 const classic=await askClaudeLook('hello',[{bytes:Buffer.from('pixels'),mediaType:'image/png'}],{model:'sonnet',claudeHome:fs.mkdtempSync(path.join(root,'classic-')),spawnFn:spawnFor([init,result],args=>{actual=args;})});
 assert.deepEqual(actual,lookArgv('sonnet').map(a=>a===''?'""':a));assert.equal(classic.receipt.argvSha256,awaitHash(JSON.stringify(lookArgv('sonnet'))));
});
test('workRoot rejects outside and junction ancestors before creating missing directories',async()=>{
 const repo=fs.mkdtempSync(path.join(root,'repo-')),cfg=path.join(repo,'config');fs.mkdirSync(cfg);
 const outside=fs.mkdtempSync(path.join(root,'outside-'));let spawned=false;
 const ask=workRoot=>askAuthor('hello',[],{repoRoot:repo,configDir:cfg,workRoot,spawnFn:spawnFor([init,result],()=>{spawned=true;})});
 await assert.rejects(ask(path.join(outside,'new','deep')),{code:'author_state_outside_code'});
 const junction=path.join(repo,'escape');fs.symlinkSync(outside,junction,'junction');
 try{await assert.rejects(ask(path.join(junction,'fresh','deep')),{code:'author_state_outside_code'});assert.deepEqual(fs.readdirSync(outside),[]);assert.equal(spawned,false);}finally{fs.rmdirSync(junction);}
 await ask(path.join(repo,'new','deep'));assert.equal(spawned,true);
});
test('incremental scan sees split UTF8 and unterminated tool variants even on failed exit',async()=>{
 const spawnFn=()=>{const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.stdin={end(){queueMicrotask(()=>{
 const b=Buffer.from(JSON.stringify(init)+'\n'+JSON.stringify({type:'assistant',message:{content:[{type:'mcp_tool_result',content:'é'}]}}));
 for(const byte of b)p.stdout.write(Buffer.from([byte]));p.emit('close',1);
 });}};return p;};
 await assert.rejects(askAuthor('hello',[],{repoRoot:root,configDir:config,workRoot:path.join(root,'work'),spawnFn}),{code:'author_tool_event'});
});
