// claude-pro · claude-sonnet-5-5 · fix 2 of fable-check-2: a post layout refusal is a named end, and the job finishes from the post step.
//
// The runner, the host producer and the Python post kit are the real ones. Only the isolated fence is a stub that writes the planner's frame count of small PNG
// frames and anchors.json; it counts how often it runs, which is how "no second render" is proven.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCodebuiltStarter, START_VERSION } from './start.js';
import { overlayPair, validateOverlaySpec } from './overlaySpec.js';
import { frameCountFor } from './planner.js';
import { normaliseScript } from '../voice.js';
import { createBuildJobRunner } from '../engines/codebuilt/runner.js';
import { createHostOutputProducer, layoutRefusal } from '../engines/codebuilt/producer.js';
import { framesDigest, jobPaths } from '../engines/codebuilt/jobFolder.js';
import { readJobState } from '../engines/codebuilt/jobState.js';
import { hostExecFile } from './hostEffects.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const REPO = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const ID = 'post-resume';
const BUILD = 'accepted loop-produced build source';
const BLOCKED_RAW = { version: 1, counter: { value: 'n', format: 'int', from: 0, to: 0.4 }, measures: [{ a: 'l', b: 'r', text: '23 cm', from: 0, to: 0.4 }] };
const CORRECTED_RAW = { version: 1, counter: { value: 'n', format: 'int', from: 0, to: 0.4 }, measures: [{ a: 'l', b: 'r', text: '23 cm', from: 0.5, to: 0.9 }] };
// The starter and the runner always carry the normalised spec (empty lists added); compare with that form.
const BLOCKED = validateOverlaySpec(BLOCKED_RAW, { videoSeconds: 2 });
const CORRECTED = validateOverlaySpec(CORRECTED_RAW, { videoSeconds: 2 });
// A short voice keeps every encode in this file to a couple of seconds; frames match the length the planner arithmetic gives for it.
const VOICE_S = 2;
const NFRAMES = frameCountFor({ dur: VOICE_S });
const PNG_PY = 'import sys,numpy as np\nfrom PIL import Image\nfor i in range(int(sys.argv[2])): Image.fromarray(np.full((384,216,3),20+i%200,np.uint8)).save(sys.argv[1]+"/%04d.png"%i)';
let kit = true;
try { execFileSync('python', ['-c', 'import soundfile, numpy, PIL'], { stdio: 'ignore' }); execFileSync('python', ['-c', 'import sys; sys.path.append(sys.argv[1]); from narrative_factory.codebuilt.post import media; media.resolve_ffmpeg()', REPO], { stdio: 'ignore' }); } catch { kit = false; }
const needsKit = { skip: kit ? false : 'python post kit or ffmpeg is not available' };

function wavFixture() {
  const rate = 16000; const frames = rate * VOICE_S; const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = Math.floor(rate * 0.3); i < Math.floor(rate * (VOICE_S - 0.2)); i += 1) bytes.writeInt16LE(4000, 44 + i * 2);
  return bytes;
}

/** A failed overlay job whose accepted pair, voice and receipts are saved; the fence is a counting stub. */
function makeJob({ route = 'overlay' } = {}) {
  const root = path.join(REPO, 'output/agent-jobs/check2-post', `test-${route}-${crypto.randomBytes(4).toString('hex')}`);
  const state = path.join(root, '.start', ID);
  const dir = path.join(state, route === 'authored' ? 'author' : 'loop');
  fs.mkdirSync(dir, { recursive: true });
  const script = 'The careful narration validates every measured word boundary';
  const brief = '# Cached brief';
  const pathPack = { id: 'codebuilt', skills: [] };
  const wav = wavFixture();
  fs.writeFileSync(path.join(state, 'script.txt'), script); fs.writeFileSync(path.join(state, 'brief.md'), brief);
  fs.writeFileSync(path.join(state, 'pathpack.json'), JSON.stringify(pathPack)); fs.writeFileSync(path.join(state, 'vo.wav'), wav);
  const tokens = normaliseScript(script).words;
  const weights = tokens.map((word, i) => word.length * (i % 3 === 0 ? 1 : i % 3 === 1 ? 1.31 : 0.78));
  const sum = weights.reduce((a, b) => a + b, 0); let cursor = 0.3; const span = (VOICE_S - 0.4) - 0.3 - 0.04 * (tokens.length - 1);
  const timed = tokens.map((word, i) => { const s = cursor; const e = s + span * weights[i] / sum; cursor = e + 0.04; return { w: word, s: Number(s.toFixed(3)), e: Number(e.toFixed(3)) }; });
  timed[timed.length - 1].e = VOICE_S - 0.4;
  const words = { dur: VOICE_S, words: timed };
  fs.writeFileSync(path.join(state, 'words.json'), JSON.stringify(words));
  fs.writeFileSync(path.join(state, 'voice.json'), JSON.stringify({ script_sha256: hash(normaliseScript(script).text), audio_sha256: hash(wav), word_timing_source: 'aligned', video_seconds: VOICE_S }));
  const nframes = frameCountFor(words);
  fs.writeFileSync(path.join(state, 'planner-plan.json'), JSON.stringify({ nframes, shotStarts: [0], places: ['room'] }));
  fs.writeFileSync(path.join(dir, 'accepted.build.py'), BUILD);
  fs.writeFileSync(path.join(dir, 'accepted.overlay.json'), JSON.stringify(overlayPair(BUILD, BLOCKED, { videoSeconds: nframes / 30 })));
  const receipt = { version: 1, accepted: true, note: 'saved look receipt' };
  if (route === 'authored') fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt));
  else fs.writeFileSync(path.join(dir, 'accepted-receipt.json'), JSON.stringify({ sha256: hash(BUILD), receipt }));
  fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({ version: START_VERSION, id: ID, topic: 'Resume post', duration: VOICE_S, voice: 'aiden', route, status: 'failed', step: 'looking', steps: [] }));

  const counts = { renders: 0 };
  const runner = createBuildJobRunner({
    root, inputRoots: [state], produceOutputs: createHostOutputProducer({ execFileFn: hostExecFile, repoRoot: REPO }),
    runIsolatedJob: async ({ jobDir }) => {
      counts.renders += 1;
      const frames = path.join(jobDir, 'frames'); fs.mkdirSync(frames, { recursive: true });
      execFileSync('python', ['-c', PNG_PY, frames, String(NFRAMES)]);
      fs.mkdirSync(path.join(jobDir, 'work'), { recursive: true });
      fs.writeFileSync(path.join(jobDir, 'work', 'anchors.json'), JSON.stringify({ version: 1, width: 216, height: 384, frames: Object.fromEntries(Array.from({ length: NFRAMES }, (_, i) => [String(i), { p: { l: [0.3, 0.12, 1], r: [0.7, 0.12, 1] }, v: { n: 1 } }])) }));
      return { status: 'ok', ok: true };
    },
  });
  const drafts = [];
  const starter = () => createCodebuiltStarter({
    jobsDir: root, episodesRoot: path.join(root, 'episodes'), planner: { KIT_CONTRACT: 'kit', validateBuildScript: () => [] }, validateReusableBuild: () => [],
    composeRunner: async () => ({ runner }), visualLoop: false, lightMetadataStage: async () => ({}),
    toDraft: (args) => { drafts.push(args); return { id: `draft-${args.jobId}`, metadata: { social: { duration_seconds: 1 } } }; },
  });
  const paths = jobPaths(root, ID);
  const job = path.join(root, ID);
  const request = { jobId: ID, kind: 'generated-code', timeoutMs: 60000, script, brief, voWav: path.join(state, 'vo.wav'), words: path.join(state, 'words.json'), pathPack, buildScript: BUILD, overlaySpec: BLOCKED, route };
  const setRecord = (extra) => fs.writeFileSync(path.join(state, 'status.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(state, 'status.json'), 'utf8')), ...extra }));
  /** The refusal as the starter would have produced it, without going through the starter. */
  async function refuse() {
    await assert.rejects(runner.run(request), (error) => error.code === 'OVERLAY_LAYOUT_BLOCKED');
    setRecord({ status: 'failed', step: 'building', error: { code: 'overlay_layout_blocked', message: 'x' } });
  }
  return { root, state, dir, job, paths, runner, counts, drafts, starter, request, refuse, setRecord,
    overlayOnDisk: () => JSON.parse(fs.readFileSync(path.join(job, 'inputs', 'overlay.json'), 'utf8')),
    runnerState: () => readJobState(paths.state),
    cleanup: () => { try { fs.rmSync(root, { recursive: true }); } catch { /* scratch only */ } } };
}

test('producer reduces the post kit refusal to fixed fields and ignores anything else', () => {
  const line = JSON.stringify({ status: 'error', code: 'overlay_layout_blocked', blocking: Array.from({ length: NFRAMES }, (_, i) => ({ code: 'overlap!', elements: ['big[1]', 'bars[0]', 'a<b>', 'x', 'y'], first_frame: i, last_frame: 9, frames: 'many', extra: 'path C:/other' })), blocking_total: 30 });
  const reduced = layoutRefusal(`noise\n${line}\n`);
  assert.equal(reduced.blocking.length, 20); assert.equal(reduced.blocking_total, 30);
  assert.deepEqual(reduced.blocking[0], { code: 'overlap', elements: ['big[1]', 'bars[0]', 'ab', 'x'], first_frame: 0, last_frame: 9, frames: null });
  assert.equal(layoutRefusal('{"status":"error","error":"ffmpeg failed"}'), null);
  assert.equal(layoutRefusal('not json'), null);
  assert.equal(layoutRefusal(JSON.stringify({ code: 'overlay_layout_blocked', blocking: 'no' })), null);
});

test('named end: the job ends on overlay_layout_blocked with the blocking list, out/report.json says failed, the frames stay', needsKit, async () => {
  const j = makeJob();
  try {
    const starter = j.starter();
    starter.resume(ID); await starter.idle();
    const status = starter.get(ID);
    assert.equal(status.status, 'failed');
    assert.equal(status.error.code, 'overlay_layout_blocked', 'not the bare build_failed');
    assert.ok(status.error.blocking.length > 0 && status.error.blocking[0].elements.length >= 2 && Number.isInteger(status.error.blocking[0].first_frame));
    assert.equal(JSON.parse(fs.readFileSync(path.join(j.state, 'status.json'), 'utf8')).error.blocking.length, status.error.blocking.length, 'saved with the job error');
    const report = JSON.parse(fs.readFileSync(path.join(j.job, 'out', 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.error.code, 'overlay_layout_blocked'); assert.ok(report.error.blocking.length);
    assert.ok(!fs.existsSync(path.join(j.job, 'out', 'video.mp4')), 'refused before the encode');
    const recorded = j.runnerState();
    assert.equal(recorded.status, 'failed'); assert.equal(recorded.failure.code, 'OVERLAY_LAYOUT_BLOCKED');
    assert.deepEqual(recorded.refusal.frames, framesDigest(j.paths)); assert.equal(recorded.refusal.frames.count, NFRAMES);
    assert.equal(j.counts.renders, 1);
    assert.equal(starter.get(ID).resumeNeeds, 'corrected_overlay'); assert.equal(starter.get(ID).resumeFrom, 'post'); assert.ok(starter.get(ID).reuses.includes('frames'));
  } finally { j.cleanup(); }
});

test('post-only resume: corrected overlay and the kept frames finish the job with zero second render', needsKit, async () => {
  const j = makeJob();
  try {
    await j.refuse();
    const framesBefore = framesDigest(j.paths);
    const starter = j.starter();
    starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    const status = starter.get(ID);
    assert.equal(status.status, 'done', JSON.stringify([status.error, j.runnerState().postOnlyFailure]));
    assert.equal(status.draftId, `draft-${ID}`); assert.equal(j.drafts.length, 1);
    assert.equal(j.counts.renders, 1, 'the fence ran once: no second render');
    assert.deepEqual(framesDigest(j.paths), framesBefore, 'the frames are the frames of the first run');
    assert.equal(JSON.parse(fs.readFileSync(path.join(j.job, 'out', 'report.json'), 'utf8')).status, 'ok');
    for (const name of ['video.mp4', 'subtitles.srt', 'contact_sheet.png']) assert.ok(fs.statSync(path.join(j.job, 'out', name)).size > 0, name);
    assert.deepEqual(j.overlayOnDisk(), CORRECTED, 'the job carries the corrected overlay');
    const recorded = j.runnerState();
    assert.equal(recorded.status, 'complete'); assert.equal(recorded.postOnly, true); assert.equal(recorded.inputs['overlay.json'], hash(`${JSON.stringify(CORRECTED, null, 2)}\n`));
    assert.equal(status.post_correction.rendered_again, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(j.root, ID, 'visual_loop.json'), 'utf8')).note, 'saved look receipt', 'the accepted look receipt is carried');
  } finally { j.cleanup(); }
});

test('post-only resume works for an authored job (pair and receipt read from author/)', needsKit, async () => {
  const j = makeJob({ route: 'authored' });
  const previous = process.env.FORGEAI_AUTHOR_MODE; process.env.FORGEAI_AUTHOR_MODE = '1';
  try {
    await j.refuse();
    const starter = j.starter();
    assert.equal(starter.get(ID).resumeNeeds, 'corrected_overlay');
    starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    assert.equal(starter.get(ID).status, 'done', JSON.stringify(starter.get(ID).error));
    assert.equal(j.counts.renders, 1);
  } finally { if (previous === undefined) delete process.env.FORGEAI_AUTHOR_MODE; else process.env.FORGEAI_AUTHOR_MODE = previous; j.cleanup(); }
});

test('a refused job needs a correction, and a bad correction is refused before anything runs', needsKit, async () => {
  const j = makeJob();
  try {
    await j.refuse();
    const starter = j.starter();
    const refused = (fn, code) => assert.throws(fn, (error) => error.code === code, code);
    refused(() => starter.resume(ID), 'overlay_correction_required');
    refused(() => starter.resume(ID, { correctedOverlay: BLOCKED }), 'overlay_correction_invalid');           // equal to the refused one
    refused(() => starter.resume(ID, { correctedOverlay: { version: 1, wat: [] } }), 'overlay_correction_invalid'); // not a valid spec
    refused(() => starter.resume(ID, { correctedOverlay: { version: 1, tag: { text: 'LATE', from: 0, to: 999 } } }), 'overlay_correction_invalid'); // past the frames
    refused(() => starter.resume(ID, { correctedOverlay: '/etc/passwd' }), 'overlay_correction_invalid');       // a path is never accepted
    assert.equal(starter.get(ID).status, 'failed'); assert.equal(j.counts.renders, 1);
    assert.deepEqual(j.overlayOnDisk(), BLOCKED, 'nothing was replaced');
  } finally { j.cleanup(); }
});

test('mismatch refusals: changed frame, changed job overlay, changed accepted build, wrong job kind', needsKit, async () => {
  // 1. a frame changed after the refusal: the runner refuses before it replaces the overlay or runs the post kit
  let j = makeJob();
  try {
    await j.refuse();
    const frame = path.join(j.job, 'frames', '0007.png'); fs.writeFileSync(frame, Buffer.concat([fs.readFileSync(frame), Buffer.from([0])]));
    const starter = j.starter(); starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    assert.equal(starter.get(ID).status, 'failed'); assert.equal(starter.get(ID).error.code, 'build_failed');
    assert.deepEqual(j.overlayOnDisk(), BLOCKED); assert.equal(j.counts.renders, 1);
    assert.ok(!fs.existsSync(path.join(j.job, 'out', 'video.mp4')));
  } finally { j.cleanup(); }
  // 2. a frame removed
  j = makeJob();
  try {
    await j.refuse(); fs.unlinkSync(path.join(j.job, 'frames', '0003.png'));
    const starter = j.starter(); starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    assert.equal(starter.get(ID).error.code, 'build_failed'); assert.equal(j.counts.renders, 1);
  } finally { j.cleanup(); }
  // 3. the job's own overlay input was changed
  j = makeJob();
  try {
    await j.refuse();
    const target = path.join(j.job, 'inputs', 'overlay.json'); fs.chmodSync(target, 0o666); fs.writeFileSync(target, JSON.stringify({ version: 1 }));
    const starter = j.starter();
    // The starter's light check reads only host records; the runner compares the job's own input with the hash it recorded and refuses.
    starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    assert.equal(starter.get(ID).error.code, 'build_failed'); assert.equal(j.counts.renders, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 1 }, 'the tampered file was not replaced');
    assert.ok(!fs.existsSync(path.join(j.job, 'out', 'video.mp4')));
  } finally { j.cleanup(); }
  // 4. the accepted build in the stage was changed: the pair no longer matches what the job ran
  j = makeJob();
  try {
    await j.refuse();
    fs.writeFileSync(path.join(j.dir, 'accepted.build.py'), `${BUILD}\n# edited`);
    const starter = j.starter();
    assert.throws(() => starter.resume(ID, { correctedOverlay: CORRECTED }), (error) => error.code === 'overlay_correction_invalid');
    assert.equal(j.counts.renders, 1);
  } finally { j.cleanup(); }
  // 5. a correction for a job that never had a layout refusal
  j = makeJob();
  try {
    const starter = j.starter();
    assert.throws(() => starter.resume(ID, { correctedOverlay: CORRECTED }), (error) => error.code === 'overlay_correction_invalid');
    assert.equal(j.counts.renders, 0);
  } finally { j.cleanup(); }
  // 6. the runner itself refuses any job that is not a recorded refusal, and a state that was swapped
  j = makeJob();
  try {
    await assert.rejects(j.runner.runPostOnly({ jobId: ID, buildScript: BUILD, overlaySpec: CORRECTED }), (error) => error.code === 'RESUME_MISMATCH');
    await j.refuse();
    await assert.rejects(j.runner.runPostOnly({ jobId: ID, buildScript: `${BUILD} changed`, overlaySpec: CORRECTED }), (error) => error.code === 'RESUME_MISMATCH');
    await assert.rejects(j.runner.runPostOnly({ jobId: `${ID}-pv1`, buildScript: BUILD, overlaySpec: CORRECTED }), (error) => error.code === 'BAD_JOB');
  } finally { j.cleanup(); }
});

test('a post-only attempt that fails for another reason restores the overlay and the job stays resumable; a new refusal can be corrected again', needsKit, async () => {
  const j = makeJob();
  try {
    await j.refuse();
    const starter = j.starter();
    // The corrected overlay names an anchor the build never marked: the post kit fails, the refused overlay is put back.
    starter.resume(ID, { correctedOverlay: { version: 1, tag: { text: 'OK', from: 0, to: 0.4 }, labels: [{ anchor: 'ghost', title: 'GHOST', from: 0, to: 0.4 }] } }); await starter.idle();
    assert.equal(starter.get(ID).status, 'failed'); assert.equal(starter.get(ID).error.code, 'build_failed');
    assert.deepEqual(j.overlayOnDisk(), BLOCKED, 'the previous overlay is back');
    assert.equal(j.runnerState().failure.code, 'OVERLAY_LAYOUT_BLOCKED'); assert.equal(j.runnerState().postOnlyFailure.code, 'PRODUCER_FAILED');
    assert.equal(starter.get(ID).resumeNeeds, 'corrected_overlay', 'still a post-only resume');
    // A correction that is still overlapping is refused again with its own list; that overlay is the one to correct next.
    const still = { version: 1, counter: { value: 'n', format: 'int', from: 0, to: 0.4 }, measures: [{ a: 'l', b: 'r', text: '24 cm', from: 0, to: 0.4 }] };
    starter.resume(ID, { correctedOverlay: still }); await starter.idle();
    assert.equal(starter.get(ID).error.code, 'overlay_layout_blocked'); assert.ok(starter.get(ID).error.blocking.length);
    assert.deepEqual(j.overlayOnDisk().measures[0].text, '24 cm');
    assert.equal(starter.get(ID).resumeNeeds, 'corrected_overlay');
    assert.throws(() => starter.resume(ID, { correctedOverlay: still }), (error) => error.code === 'overlay_correction_invalid', 'equal to the overlay in the job');
    starter.resume(ID, { correctedOverlay: CORRECTED }); await starter.idle();
    assert.equal(starter.get(ID).status, 'done', JSON.stringify(starter.get(ID).error));
    assert.equal(j.counts.renders, 1, 'three post attempts, one render');
  } finally { j.cleanup(); }
});

test('classic jobs are unchanged: a failed classic job keeps its plain resume and refuses a correction', needsKit, async () => {
  const j = makeJob({ route: 'classic' });
  try {
    j.setRecord({ route: 'classic' });
    const starter = j.starter();
    const status = starter.get(ID);
    assert.equal(status.resumeNeeds, undefined); assert.notEqual(status.resumeFrom, 'post');
    assert.throws(() => starter.resume(ID, { correctedOverlay: CORRECTED }), (error) => error.code === 'overlay_correction_invalid');
  } finally { j.cleanup(); }
});

test('the resume route passes correctedOverlay through and still refuses other body keys', async () => {
  const { resumeCodebuiltHandler } = await import('../../routes/codebuilt.js');
  const { setCodebuiltStarter } = await import('./start.js');
  const calls = [];
  setCodebuiltStarter({ resume: (id, options) => { calls.push([id, options]); return { id }; } });
  const run = async (body) => {
    const out = {};
    const res = { status(code) { out.status = code; return this; }, json(value) { out.json = value; return this; } };
    await resumeCodebuiltHandler({ params: { jobId: 'abc' }, body }, res);
    return out;
  };
  try {
    assert.equal((await run(undefined)).status, 202); assert.deepEqual(calls.at(-1), ['abc', {}]);
    assert.equal((await run({})).status, 202); assert.deepEqual(calls.at(-1), ['abc', {}]);
    assert.equal((await run({ correctedOverlay: CORRECTED })).status, 202); assert.deepEqual(calls.at(-1), ['abc', { correctedOverlay: CORRECTED }]);
    const before = calls.length;
    assert.equal((await run({ correctedOverlay: CORRECTED, path: 'C:/x' })).status, 400); assert.equal(calls.length, before, 'an unknown key never reaches the starter');
  } finally { setCodebuiltStarter(null); }
});
