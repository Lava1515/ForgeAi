// codex · gpt-6.1-sol · 2026-11-17 18:03 +02:00: route-specific resume regression probes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodebuiltStarter, START_VERSION } from '../episode/codebuilt/start.js';
import { normaliseScript } from '../episode/voice.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function wavFixture() {
  const rate = 16000; const frames = rate * 30; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = Math.floor(rate * 0.3); i < Math.floor(rate * 29.8); i += 1) bytes.writeInt16LE(4000, 44 + i * 2);
  return bytes;
}

for (const attack of ['readonly', 'overlay', 'overlay-final']) test(`O1a explicit route resume lifecycle: ${attack}`, async () => {
  const scratch = 'C:/code/ForgeAi/output/agent-jobs/o1a-tests';
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'codebuilt-resume-regression-'));
  const id = 'resume-regression';
  const state = path.join(root, '.start', id);
  const loop = path.join(state, 'loop', 'r1');
  fs.mkdirSync(loop, { recursive: true });
  try {
    const script = 'The careful narration validates every measured word boundary before saved scene code continues after a paused job resumes safely today';
    const brief = '# Cached brief';
    const overlay = attack.startsWith('overlay');
    const pathPack = { id: 'codebuilt', skills: [],  };
    const newBuild = "from blender_worker.codebuilt import anchors\ndef shot(t):\n anchors.mark('new_point',(0,0,0))\n";
    const overlaySpec = {version:1,labels:[{anchor:'new_point',title:'NEW',from:0,to:1}]};
    const wav = wavFixture();
    fs.writeFileSync(path.join(state, 'script.txt'), script);
    fs.writeFileSync(path.join(state, 'brief.md'), brief);
    fs.writeFileSync(path.join(state, 'pathpack.json'), JSON.stringify(pathPack));
    fs.writeFileSync(path.join(state, 'vo.wav'), wav);
    const tokens = normaliseScript(script).words;
    const weights = tokens.map((word, i) => word.length * (i % 3 === 0 ? 1 : i % 3 === 1 ? 1.31 : 0.78));
    const total = 28.54; const sum = weights.reduce((a, b) => a + b, 0); let cursor = 0.3;
    const timed = tokens.map((word, i) => { const s = cursor; const e = s + total * weights[i] / sum; cursor = e + 0.04; return { w: word, s: Number(s.toFixed(3)), e: Number(e.toFixed(3)) }; });
    timed[timed.length - 1].e = 29.6;
    fs.writeFileSync(path.join(state, 'words.json'), JSON.stringify({ dur: 30, words: timed }));
    fs.writeFileSync(path.join(state, 'voice.json'), JSON.stringify({ script_sha256: hash(normaliseScript(script).text), audio_sha256: hash(wav), word_timing_source: 'aligned', video_seconds: 30 }));
    const cachedBuild = 'cached loop-produced build source';
    fs.writeFileSync(path.join(loop, 'build.py'), cachedBuild);
    // A previous container can forge files in its own job folder, never in .start.
    const forged = path.join(root, id, 'loop', 'r0');
    fs.mkdirSync(forged, { recursive: true });
    fs.writeFileSync(path.join(root, id, 'accepted.build.py'), 'forged container build');
    fs.writeFileSync(path.join(forged, 'build.py'), 'forged history');
    fs.writeFileSync(path.join(forged, 'look.json'), JSON.stringify({ status: 'complete', reply: { findings: ['forged finding'] }, buildSha256: hash('forged history') }));
    fs.writeFileSync(path.join(state, 'cost_calls.json'), JSON.stringify({ calls: [{ step: 'previous', provider: 'claude', model: 'sonnet', wall_s: 1, input_tokens: 12, output_tokens: 3, retries: 0 }] }));
    fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({
      version: START_VERSION, id, topic: 'Cached regression', duration: 30, voice: 'aiden', ...(overlay ? {route:'overlay'} : {}), status: 'failed', step: 'looking',
      steps: [{ step: 'looking', at: '2026-11-13T00:00:00.000Z' }], createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z',
      draftId: null, error: { code: 'look_failed', message: 'failed' },
    }));

    let scriptCalls = 0; let voiceCalls = 0; let plannerCalls = 0; let loopBuild = null; let finalRequest = null; let finals=0; let loops=0;
    const starter = createCodebuiltStarter({
      jobsDir: root, episodesRoot: path.join(root, 'episodes'), draftsDir: path.join(root, 'drafts'),
      planner: {
        planCodebuiltScript: async () => { scriptCalls += 1; throw new Error('script should be reused'); },
        planCodebuiltBuild: async (input) => { assert.equal(input.route, overlay ? 'overlay' : 'classic'); plannerCalls += 1; if (overlay) return {buildScript:newBuild,overlaySpec,shotStarts:[0],nframes:955,calls:[]}; throw new Error('planner should be skipped'); },
      },
      voiceStage: async () => { voiceCalls += 1; throw new Error('voice should be reused'); },
      validateReusableBuild: (code, options) => { if (overlay) assert.equal(options.route, 'overlay'); return []; },
      composeRunner: async () => ({ runner: { run: async (req) => {
        finals++; if(attack==='overlay-final' && finals===1) throw new Error('final failed');
        finalRequest = req; assert.equal(req.route, overlay ? 'overlay' : 'classic');
        const receipt = path.join(root, id, 'visual_loop.json');
        fs.writeFileSync(receipt, JSON.stringify({ model: 'FORGED' }));
        fs.chmodSync(receipt, 0o444);
        return {};
      } } }),
      visualLoop: {
        runPreview: async (request) => { assert.equal(request.route, overlay ? 'overlay' : 'classic'); return {}; },
        probe: async () => ({ passed: true }),
        validate: () => [],
        runLoop: async (input, deps) => {
          loops++;
          await deps.runPreview({jobId:input.jobId+(overlay?'-a1':'')+'-pv3',buildScript:input.buildScript});
          assert.equal(input.route, overlay ? 'overlay' : 'classic'); loopBuild = input.buildScript;
          if (overlay) assert.equal(input.startRound,2); // Preserve prior round folders; contract 2.6 replans without an overlay pair.
          assert.deepEqual(input.resumeHistory, []);
          return { accepted: true, buildScript: input.buildScript, sha256: hash(input.buildScript), receipt: { model: 'HOST' }, calls: [] };
        },
      },
      toDraft: () => ({ id: 'draft-resume-regression', metadata: {} }),
      lightMetadataStage: async () => ({}),
    });

    const queued = starter.resume(id);
    assert.equal(queued.id, id);
    assert.equal(queued.resumes.at(-1).fromStep, overlay ? 'planning' : 'visual_loop');
    assert.deepEqual(queued.resumes.at(-1).reused, overlay ? ['script', 'voice'] : ['script', 'voice', 'buildScript']);
    await starter.idle();

    if(attack==='overlay-final') {
      assert.equal(starter.get(id).error.code,'build_failed');
      starter.resume(id); await starter.idle();
      assert.equal(finals,2);assert.equal(loops,1,'accepted pair skips another preview/look');
    }
    const finished = starter.get(id);
    assert.equal(finished.route, overlay ? 'overlay' : 'classic');
    const restarted = createCodebuiltStarter({jobsDir:root});
    assert.equal(restarted.get(id).route, finished.route);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state,'status.json'))).route, finished.route);
    assert.equal(finished.status, 'done');
    if (attack === 'readonly') assert.equal(JSON.parse(fs.readFileSync(path.join(root, id, 'visual_loop.json'), 'utf8')).model, 'HOST');
    assert.equal(scriptCalls, 0);
    assert.equal(voiceCalls, 0);
    assert.equal(plannerCalls, overlay ? 1 : 0);
    assert.equal(loopBuild, overlay ? newBuild : cachedBuild);
    if (overlay) {
      assert.equal(finalRequest.buildScript,newBuild);
      assert.deepEqual(finalRequest.overlaySpec,{...overlaySpec,labels:overlaySpec.labels.map(label=>({...label,side:'auto'})),measures:[],bars:[],big:[]});
    }
    const calls = JSON.parse(fs.readFileSync(path.join(state, 'cost_calls.json'), 'utf8')).calls;
    assert.equal(calls[0].step, 'previous');
  } finally {
    if (!fs.lstatSync(root).isSymbolicLink()) fs.rmSync(root, { recursive: true, force: true });
  }
});


function rig(root, hooks = {}) {
  let seq = 0;
  const events = [];
  const starter = createCodebuiltStarter({
    jobsDir: root, episodesRoot: path.join(root, 'episodes'), newId: () => `q1-${++seq}`,
    planner: { planCodebuiltBuild: async (input) => {
      events.push(['plan', input.topic, input.duration]);
      await hooks.plan?.(input);
      return { ...(input.route !== 'classic' ? {overlaySpec:{version:1,tag:{text:'BRIDGE',from:0,to:1}}} : {}), buildScript: 'safe fixture', nframes: 900, shotStarts: [0] };
    } },
    scriptStage: async (input) => {
      events.push(['script', input.topic, input.duration, input.autoDuration]);
      await hooks.script?.(input);
      return { script: `Narration for ${input.topic}`, brief: 'brief', pathPack: { id: 'codebuilt', skills: [] }, ...(hooks.duration ? { duration: hooks.duration } : {}) };
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
    visualLoop: {
      probe: async () => ({}),
      runLoop: async (input) => {
        events.push(['visual', input.jobId]);
        await hooks.visual?.(input);
        return { accepted: true, buildScript: input.buildScript, sha256: crypto.createHash('sha256').update(input.buildScript).digest('hex'), receipt: {} };
      },
    },
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
    script: input=>{scripts.push(input);assert.equal(input.route,route);},
    factCheck:async()=> ++checks===1?{verified:false,facts:{claims:[{text:'Bridge fact',verdict:'uncertain'}]}}:{verified:true},
    voiceSeconds:()=>++voices===1?20:30,
    plan:input=>{builds++;assert.equal(input.route,route);},
    visual:input=>assert.equal(input.route,route),
    render:input=>{renders++;assert.equal(input.route,route);},
  });
  try {
    const job=starter.start({topic:'Bridge',duration:30,route},{factCheck:true,runId:'route-fresh',choices:{type:'factual'}});
    await starter.idle();
    assert.equal(starter.get(job.id).status,'done',JSON.stringify(starter.get(job.id).error));
    assert.equal(scripts.length,3);assert.ok(scripts[1].corrections.length);assert.ok(scripts[2].pace);
    assert.equal(builds,1);assert.equal(renders,1);assert.equal(voices,2);
  } finally {await starter.idle();if(prior===undefined)delete process.env.FORGEAI_AUTHOR_MODE;else process.env.FORGEAI_AUTHOR_MODE=prior;}
});
