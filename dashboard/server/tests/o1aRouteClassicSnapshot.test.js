// codex · gpt-6.1-sol · 2026-11-17 18:03 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:4*1024*1024});
async function plannerAt(ref) {
  const relative='dashboard/server/episode/codebuilt/planner.js';
  const url=new URL('../episode/codebuilt/planner.js',import.meta.url);
  let source=ref?git('show',`${ref}:${relative}`):fs.readFileSync(url,'utf8');
  source=source.replace(/from (['"])(\.[^'"]+)\1/g,(_,q,s)=>`from ${q}${new URL(s,url).href}${q}`)
    .replaceAll('import.meta.url',JSON.stringify(url.href));
  source+='\nexport {scriptPrompt,buildPrompt};';
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
test('O1a classic 200-case prompt and validator snapshots equal 717d65f',async()=>{
  const before=await plannerAt('717d65f');const after=await plannerAt();
  const pack=JSON.parse(git('show','717d65f:paths/codebuilt.json'));
  for(let i=0;i<200;i++) {
    const duration=[30,45,60,90][i%4];
    const words={dur:duration-2,words:[{w:'A',s:0.2,e:0.4},{w:'bridge',s:0.5,e:1.2}]};
    const input={topic:`A bridge ${i}`,duration,pack,voice:['aiden','ryan','vivian'][i%3],choices:{type:i%2?'history':'factual',genre:null,theme:null},
      autoDuration:i%5===0,script:'A bridge crosses the river.',brief:'A familiar river.',words,shotStarts:[0,10,20],nframes:Math.trunc((words.dur+1.85)*30)};
    assert.equal(after.scriptPrompt({...input,route:'classic'}),before.scriptPrompt(input),`script ${i}`);
    assert.equal(after.buildPrompt({...input,route:'classic'}),before.buildPrompt(input),`build ${i}`);
    const code=['', 'import os\nopen("x")', 'import bpy\nscene.render.engine="CYCLES"', 'from blender_worker.codebuilt import stage\n'][i%4]+`\n# probe ${i}`;
    assert.deepEqual(after.validateBuildScript(code,{...input,route:'classic'}),before.validateBuildScript(code,input),`validator ${i}`);
  }
  // Post report code and direction rules are untouched, so their output-key and direction contracts retain the baseline implementation.
  for(const file of ['narrative_factory/codebuilt/post/run.py','dashboard/server/episode/codebuilt/direction.js']) {
    assert.equal(git('diff','717d65f','--',file),'',file);
  }
});
