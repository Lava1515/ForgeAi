// codex - gpt-6.1-sol - 2026-11-17 22:59 +02:00: A1 transport, caps and authored route regressions.
// codex · gpt-6.1-sol · 2026-11-17 18:03 +02:00
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkStartRequest, createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { checkRunRequest, createCodebuiltRunCoordinator } from '../episode/codebuilt/runCoordinator.js';

function scratch() {
  const parent = 'C:/code/ForgeAi/output/agent-jobs/o1a-tests';
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, 'route-'));
}
const channel = { id:'route-channel', video_types:['factual'], profile:{niche:'engineering',status:'active', formats:[]} };

test('both boundaries normalize old route strings and reject malformed route data', () => {
 for(const check of [r => checkStartRequest({topic:'A bridge', ...r}),checkRunRequest]) {
  for(const route of [undefined,null,'classic','overlay','authored','auto','Old']) assert.equal(check({route}).route,'authored');
  for(const route of [false,0,[],{}]) assert.throws(()=>check({route}),{code:'bad_request'});
 }
});

for (const scenario of ['classic','overlay','authored','format','channel-format']) test(`O1a batch route/topic persistence: ${scenario}`, async()=>{
  const prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';
  const root=scratch(); const picks=[]; const starts=[];
  const ownChannel=structuredClone(channel);
  if(scenario==='channel-format')ownChannel.profile.formats=['journey'];
  const coordinator=createCodebuiltRunCoordinator({runsDir:root, getChannels:()=>[ownChannel], getChannel:()=>ownChannel,
    pickTopic:async input=>{picks.push(input);return {topic:'A bridge',ranked:1,premise:{formats:[]}};},
    starter:{start:(input)=>{starts.push(input);return {id:'fake-job',step:'done'};},get:()=>({status:'done',step:'done',draftId:'fake-draft'})},
  });
  try {
    const route=['classic','overlay','authored'].includes(scenario)?scenario:undefined;
    const job=coordinator.startRun({...(route?{route}:{}),...(scenario==='format'?{formats:['journey']}:{}),type:'factual',duration:30,voice:'aiden'});
    await coordinator.idle();
    const expected='authored';
    assert.equal(starts[0].route,expected);assert.equal(picks[0].picture,expected==='classic'?undefined:true);
    assert.equal(job.route,expected);assert.equal(coordinator.getRun(job.id).route,expected);
    const saved=JSON.parse(fs.readFileSync(path.join(root,job.id,'run.json')));
    assert.equal(saved.route,expected);assert.equal(saved.request.route,expected);assert.equal(saved.videos[0].route,expected);
  } finally {await coordinator.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});


test('O1a journey promotes classic and remains allowed on authored after the topic gate', async()=>{
  const prior=process.env.FORGEAI_AUTHOR_MODE;process.env.FORGEAI_AUTHOR_MODE='1';
  const root=scratch();let seq=0;
  const starter=createCodebuiltStarter({jobsDir:root,newId:()=>`journey-${++seq}`,planner:{},composeRunner:async()=>{throw new Error('stop before calls');}});
  const premise={formats:['journey'],thing:'A drill bit',move:'Down through rock',story_question:'How deep does it go?',ending_answer:'The rock gets too hot.',turn:'Then it stops',who:'The geologists',want:'Reach the mantle',landmarks:['one','two','three'],counter:{what:'depth',unit:'km'},last_number:12};
  try {
    for(const route of ['classic','authored']) {
      const job=starter.start({topic:'A drill',duration:30,formats:['journey'],route},{factCheck:true,runId:'route-journey',choices:{type:'factual'},premise});
      await starter.idle();assert.equal(starter.get(job.id).route,'authored');
    }
    delete process.env.FORGEAI_AUTHOR_MODE;
  } finally {await starter.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});
