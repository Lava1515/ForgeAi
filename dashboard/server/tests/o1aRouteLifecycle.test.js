import { authorOptions, authorPlanner, renderPack } from './helpers/authored.js';
// codex - gpt-6.1-sol - 2026-11-17 22:59 +02:00: A1 transport, caps and authored route regressions.
// codex · gpt-6.1-sol · 2026-11-17 18:03 +02:00: route-specific resume regression probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';

function rig(root, hooks = {}) {
  let seq = 0;
  const events = [];
  const starter = createCodebuiltStarter({
    jobsDir: root, episodesRoot: path.join(root, 'episodes'), newId: () => `q1-${++seq}`,
    authorLoop: authorOptions(root,{visual:async input=>{events.push(['visual',input.jobId]);await hooks.visual?.(input);}}),
    planner: authorPlanner(async input=>{events.push(['plan',input.topic,input.duration]);await hooks.plan?.(input);}),
    scriptStage: async (input) => {
      events.push(['script', input.topic, input.duration, input.autoDuration]);
      await hooks.script?.(input);
      return { script: `Narration for ${input.topic}`, brief: 'brief', pathPack: renderPack, ...(hooks.duration ? { duration: hooks.duration } : {}) };
    },
    factCheckStage: hooks.factCheck ?? (async () => ({ verified: true })),
    voiceStage: async (input) => {
      events.push(['voice', input.runId]);
      await hooks.voice?.(input);
      const out = { voPath: path.join(input.outDir, 'vo.wav'), wordsPath: path.join(input.outDir, 'words.json'), manifestPath: path.join(input.outDir, 'voice.json') };
      fs.writeFileSync(out.voPath, 'fixture');
      const seconds = hooks.voiceSeconds?.() ?? hooks.duration ?? 30;
      fs.writeFileSync(out.wordsPath, JSON.stringify({ dur: seconds - 2, words: Array.from({ length: 20 }, () => ({ w: 'word' })) }));
      fs.writeFileSync(out.manifestPath, JSON.stringify({ video_seconds: seconds }));
      return out;
    },
    composeRunner: async () => ({ runner: { run: async (input) => {
      events.push(['render', input.jobId]);
      await hooks.render?.(input);
      fs.mkdirSync(path.join(root, input.jobId), { recursive: true });
    } } }),
    lightMetadataStage: async () => ({}),
    toDraft: (input) => { events.push(['draft', input.jobId, input.requestedDuration]); return { id: `draft-${input.jobId}`, metadata: { social: { duration_seconds: input.requestedDuration } } }; },
  });
  return { starter, events };
}

for (const route of ['classic','overlay','authored']) test(`O1a route survives fresh script, fact rewrite and measured length retry: ${route}`, async()=>{
  const prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';
  const parent='C:/code/ForgeAi/output/agent-jobs/o1a-tests';fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'fresh-'));const scripts=[];let checks=0;let voices=0;let builds=0;let renders=0;
  const {starter}=rig(root,{
    script: input=>{scripts.push(input);assert.equal(input.route,'authored');},
    factCheck:async()=> ++checks===1?{verified:false,facts:{claims:[{text:'Bridge fact',verdict:'uncertain'}]}}:{verified:true},
    voiceSeconds:()=>++voices===1?20:30,
    plan:input=>{builds++;assert.equal(input.route,'authored');},
    visual:input=>assert.equal(input.route,'authored'),
    render:input=>{renders++;assert.equal(input.route,'authored');},
  });
  try {
    const job=starter.start({topic:'Bridge',duration:30,route},{factCheck:true,runId:'route-fresh',choices:{type:'factual'}});
    await starter.idle();

    assert.equal(starter.get(job.id).status,'done',JSON.stringify(starter.get(job.id).error));
    assert.equal(scripts.length,3);assert.ok(scripts[1].corrections.length);assert.ok(scripts[2].pace);
    assert.equal(builds,1);assert.equal(renders,1);assert.equal(voices,2);
  } finally {await starter.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});
