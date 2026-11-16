// codex · gpt-6.1-sol, 2026-11-16. Approved normal-fence CPU render proof, based on probe-stealth-jet-teardown.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.env.FORGEAI_ROOT='C:/code/ForgeAi';
const here=path.dirname(fileURLToPath(import.meta.url)), checkout=path.resolve(here,'../..');
const {runIsolatedJob}=await import('../../dashboard/server/episode/codebuilt/runJob.js');
const {selectApprovedLaunch,GENERATED_EXECUTOR_ID,KIT_SRC}=await import('../../dashboard/server/episode/engines/codebuilt/launch.js');
if(path.resolve(KIT_SRC).toLowerCase()!==path.join(checkout,'blender_worker','codebuilt').toLowerCase()) throw Error('wrong kit checkout');
const jobId='x1-realearth-proof', jobDir=`C:/code/ForgeAi/output/agent-jobs/${jobId}`;
const jobs=await (await fetch('http://localhost:3000/api/codebuilt/jobs')).json();
if(!Array.isArray(jobs.jobs)||jobs.jobs.some(j=>!['done','failed','aborted'].includes(j.status))) throw Error('dashboard has active/unknown jobs');
const containers=execFileSync('docker',['ps','--format','{{.ID}} {{.Names}}']).toString();
for (const line of containers.trim().split('\n').filter(Boolean)) {
  const [id,name]=line.trim().split(/\s+/);
  const info=JSON.parse(execFileSync('docker',['inspect',id]).toString())[0];
  // The existing idle narration service has GPU access; it is not a render worker.
  if((info.HostConfig.DeviceRequests?.length && name!=='forgeai-narrative') || /codebuilt|cb6|generated/.test(name)) throw Error('GPU or generated worker already active: '+name);
}
for(const d of ['build','work','frames']) fs.mkdirSync(path.join(jobDir,d),{recursive:true});
if(fs.existsSync(path.join(jobDir,'work','fence.json'))) throw Error('proof already attempted; use a new explicitly reviewed job id');
const files={};
function walk(dir,rel='') {for(const e of fs.readdirSync(dir,{withFileTypes:true})) {if(e.name==='__pycache__') continue; const r=path.posix.join(rel,e.name), p=path.join(dir,e.name); if(e.isDirectory()) walk(p,r); else files[r]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');}}
walk(KIT_SRC);
const manifest={head:execFileSync('git',['rev-parse','HEAD'],{cwd:checkout}).toString().trim(),files};
fs.writeFileSync(path.join(jobDir,'work','kit-manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(jobDir,'work','preflight.json'),JSON.stringify({at:new Date().toISOString(),jobs,containers,kit:KIT_SRC},null,2));
fs.copyFileSync(path.join(here,'probe-x1-surface-render.py'),path.join(jobDir,'build','build.py'));
const launch=selectApprovedLaunch(GENERATED_EXECUTOR_ID);
if(launch.gpu) throw Error('GPU forbidden');
const result=await runIsolatedJob({...launch,runtime:'docker',jobId,jobDir,limits:{memoryMb:4096,cpus:2,pids:256},timeoutMs:600000,gpuWaitMs:1000});
fs.writeFileSync(path.join(jobDir,'work','fence.json'),JSON.stringify(result,null,2));
for(const [rel,sha] of Object.entries(files)) if(crypto.createHash('sha256').update(fs.readFileSync(path.join(KIT_SRC,rel))).digest('hex')!==sha) throw Error('kit changed during probe: '+rel);
console.log(JSON.stringify({status:result.status,started:result.started,exit:result.run?.exitCode,cleanup:result.cleanup,jobDir,head:manifest.head}));
if(!result.started||result.run?.exitCode!==0||!result.cleanup?.verified) process.exitCode=1;
