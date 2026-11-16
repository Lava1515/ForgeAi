// claude-pro · claude-fable-5-2 · 2026-11-16, fix lane F1.
// The bug that happened (final panel 2026-11-16): the Amazon and Point Nemo proofs were picked for the map channel, but their
// scripts held none of the 15 map keywords, so no step loaded codebuilt-maps and no build called the map kit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCodebuiltStarter } from '../episode/codebuilt/start.js';
import { createAutoTopicProvider } from '../episode/codebuilt/autoTopic.js';
import { guidesFor, loadCodebuiltPathPack } from '../episode/codebuilt/planner.js';
import { topicGuideNamesFor } from '../episode/codebuilt/skills.js';

// Words of the kind the two proof scripts used: river, ocean, island, Pacific. None is a keyword of rules.topicSkills.
const SCRIPT = 'The Amazon river runs four thousand miles to the ocean and not one bridge crosses it. The farthest point of the Pacific from any island is Point Nemo.';
const TOPIC = 'Amazon River Bridge Absence Mystery';
const pack = loadCodebuiltPathPack();

const candidate = (profile) => ({ candidates: [{ topic: TOPIC, title: TOPIC, subject: 'Amazon River', stake: 'People of Brazil cross by ferry.', answer: 'No bridge crosses it.', hook: 'Zero bridges', payoff: 'The ferries appear.', facts: [{ value: 1, source: 's' }], shots: [], tags: [], _p: profile }] });
async function pick(profile) {
  const pickTopic = createAutoTopicProvider({
    askRoleFn: async () => candidate(profile), history: () => ({ videos: [], available: false }), getChannel: () => ({ id: 'ch', profile }),
    score: ({ candidates }) => ({ chosen: { ...candidates[0], total: 1, rules: {} }, ranked: [candidates[0]], rejected: [], history_used: 0 }),
  });
  return pickTopic({ type: 'factual', channelId: 'ch' });
}

/** Runs one batch job through the real starter; the script and build stages ask the real guide loader, as planner.js does, with no format argument. */
async function guidesSeenByJob(t, premise) {
  const parent = 'C:/code/ForgeAi/output/agent-jobs/f1-map-routing';
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = {};
  const starter = createCodebuiltStarter({
    jobsDir: root, episodesRoot: path.join(root, 'episodes'), newId: () => 'f1-1',
    scriptStage: async () => { seen.script = guidesFor(pack, 'script', '', 'factual'); return { script: SCRIPT, brief: 'brief', pathPack: pack }; },
    planner: { planCodebuiltBuild: async (input) => {
      seen.direction = guidesFor(input.pathPack, 'direction', `${TOPIC} ${SCRIPT}`, 'factual');
      seen.build = guidesFor(input.pathPack, 'build', `${TOPIC} ${SCRIPT}`, 'factual');
      return { buildScript: 'safe fixture', nframes: 900, shotStarts: [0] };
    } },
    factCheckStage: async () => ({ verified: true }),
    voiceStage: async (input) => {
      const out = { voPath: path.join(input.outDir, 'vo.wav'), wordsPath: path.join(input.outDir, 'words.json'), manifestPath: path.join(input.outDir, 'voice.json') };
      fs.writeFileSync(out.voPath, 'fixture');
      fs.writeFileSync(out.wordsPath, JSON.stringify({ dur: 28, words: Array.from({ length: 20 }, () => ({ w: 'word' })) }));
      fs.writeFileSync(out.manifestPath, JSON.stringify({ video_seconds: 30 }));
      return out;
    },
    composeRunner: async () => ({ runner: { run: async (input) => { fs.mkdirSync(path.join(root, input.jobId), { recursive: true }); } } }),
    visualLoop: { probe: async () => ({}), runLoop: async (input) => ({ accepted: true, buildScript: input.buildScript, sha256: crypto.createHash('sha256').update(input.buildScript).digest('hex'), receipt: {} }) },
    lightMetadataStage: async () => ({}),
    toDraft: (input) => ({ id: `draft-${input.jobId}`, metadata: { social: { duration_seconds: input.requestedDuration } } }),
  });
  const job = starter.start({ topic: TOPIC, duration: 30 }, { factCheck: true, runId: 'run-f1', contentMode: 'factual', premise });
  await starter.idle();
  assert.equal(starter.get(job.id).status, 'done');
  return { seen, job: starter.get(job.id) };
}

test('a map-profile job whose script has no map keyword still gets the maps skill and the map sets at script, direction and build', async (t) => {
  for (const step of ['script', 'direction', 'build']) assert.deepEqual(topicGuideNamesFor(pack, step, `${TOPIC} ${SCRIPT}`), [], 'the fixture must hit no keyword');
  const picked = await pick({ niche: 'Map explainers: where places are and why it matters', language: 'en' });
  assert.deepEqual(picked.premise.formats, ['map']);
  const { seen } = await guidesSeenByJob(t, picked.premise);
  for (const step of ['script', 'direction', 'build']) assert.match(seen[step], /^### codebuilt-maps$/m, `${step} step did not load codebuilt-maps`);
  for (const step of ['direction', 'build']) {
    assert.match(seen[step], /^- world_map: /m, `${step} step was not offered the world map set`);
    assert.match(seen[step], /^- globe: /m, `${step} step was not offered the globe set`);
  }
});

test('a channel whose profile is not about maps gets neither the maps skill nor the map sets from the format route', async (t) => {
  const picked = await pick({ niche: 'Kitchen science experiments', language: 'en' });
  assert.deepEqual(picked.premise.formats, []);
  const { seen, job } = await guidesSeenByJob(t, picked.premise);
  assert.equal(job.formats, undefined);
  for (const step of ['script', 'direction', 'build']) {
    assert.doesNotMatch(seen[step], /codebuilt-maps/);
    assert.doesNotMatch(seen[step], /Ready sets for this video/);
  }
});
