// claude-pro · claude-sonnet-5-5 · 2026-11-18 17:55 +02:00
// Fable check 2, fixes 1, 3, 5 and 6: all-frame layout gate, authored preview picks, budget feedback, receipt binding.
// The replay tests read the saved evidence of two real jobs (read-only, CPU only, no render, no model).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { runAuthorLoop, verifyAuthorReceipt } from '../episode/codebuilt/authorLoop.js';
import { hash, authorArgv } from '../episode/codebuilt/authorCall.js';
import { createLayoutGate, layoutRefusal, layoutBound } from '../episode/codebuilt/layoutGate.js';
import { pickPreviewFrames, pickAuthoredPreviewFrames, overlayWindows, coverWindows } from '../episode/codebuilt/previewFrames.js';
import { REPO_ROOT } from '../episode/engines/codebuilt/launch.js';

const TMP = path.join(REPO_ROOT, 'output', 'agent-jobs', 'check2-author', 'tests-tmp');
fs.mkdirSync(TMP, { recursive: true });
const START = 'C:/code/ForgeAi/output/agent-jobs/.start';
const evidence = (job) => path.join(START, job, 'author');
const have = (job) => fs.existsSync(path.join(evidence(job), 'accepted.overlay.json')) && fs.existsSync(path.join(evidence(job), 'receipt.json'));

// ---- the real gate on the saved accepted pairs
async function replay(job, nframes) {
  const dir = evidence(job), receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  const round = path.join(dir, `a${receipt.attempt}`, `r${receipt.round}`);
  const pair = JSON.parse(fs.readFileSync(path.join(dir, 'accepted.overlay.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(TMP, 'replay-'));
  const specFile = path.join(work, 'overlay-spec.json');
  fs.writeFileSync(specFile, JSON.stringify(pair.spec, null, 2) + '\n');
  const preview = JSON.parse(fs.readFileSync(path.join(round, 'preview.json'), 'utf8')).frames;
  const gate = createLayoutGate({ execFileFn: execFile });
  // The script only reads inside its job root, so the evidence is copied beside the spec (read-only source, scratch copy).
  for (const name of ['anchors-preview.json', 'words.json']) fs.copyFileSync(path.join(round, name), path.join(work, name));
  const layout = await gate.check({ overlaySpec: specFile, anchors: path.join(work, 'anchors-preview.json'), words: path.join(work, 'words.json'), nframes, fps: 30, jobRoot: work, frames: preview });
  return { ...layout, uncovered: overlayWindows(pair.spec).filter((w) => !preview.some((f) => f / 30 >= w.from && f / 30 < w.to)).map((w) => w.id) };
}
test('Hypersaline accepted pair (mwm4wpiw-99a2cf) is refused: overlap big[1] bars[0] on frames 1011-1066', { skip: !have('mwm4wpiw-99a2cf') }, async () => {
  const layout = await replay('mwm4wpiw-99a2cf', 1469);
  assert.equal(layout.ok, false);
  assert.equal(layout.framesChecked, 1469);
  const hit = layout.blocking.find((b) => b.code === 'overlap' && b.elements.join() === 'big[1],bars[0]');
  assert.ok(hit, JSON.stringify(layout.blocking));
  assert.equal(hit.first_frame, 1011);
  assert.equal(hit.last_frame, 1066);
  assert.ok(layout.blocking.some((b) => b.elements.join() === 'big[1],bars[1]'));
  const why = layoutRefusal(layout);
  assert.match(why, /overlap big\[1\] \+ bars\[0\]: frames 1011-1066/);
  assert.match(why, /all 1469 frames/);
});
// C2-AUTH-1: the final render of each job posed EVERY frame and saved its anchors (agent-jobs/<job>/work/anchors.json). That file is the
// all-frame ground truth the preview export must reproduce; the replay below checks the accepted pair on it, on all frames, no render.
const FINAL = (job) => path.join('C:/code/ForgeAi/output/agent-jobs', job, 'work', 'anchors.json');
const haveFinal = (job) => have(job) && fs.existsSync(FINAL(job));
async function replayAll(job, nframes) {
  const dir = evidence(job), receipt = JSON.parse(fs.readFileSync(path.join(dir, 'receipt.json'), 'utf8'));
  const round = path.join(dir, `a${receipt.attempt}`, `r${receipt.round}`);
  const pair = JSON.parse(fs.readFileSync(path.join(dir, 'accepted.overlay.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(TMP, 'replay-all-'));
  const specFile = path.join(work, 'overlay-spec.json');
  fs.writeFileSync(specFile, JSON.stringify(pair.spec, null, 2) + '\n');
  fs.copyFileSync(path.join(round, 'words.json'), path.join(work, 'words.json'));
  fs.copyFileSync(FINAL(job), path.join(work, 'anchors-all.json'));
  const layout = await createLayoutGate({ execFileFn: execFile }).check({ overlaySpec: specFile, anchors: path.join(work, 'anchors-all.json'), words: path.join(work, 'words.json'), nframes, fps: 30, jobRoot: work, frames: 'all' });
  return { ...layout, uncovered: [] };
}
const OVERLAP_CODES = ['overlap', 'outside_safe_zone', 'caption_overlap'];
test('Hypersaline accepted pair on its all-frame anchors is still refused for overlap big[1] bars[0] frames 1011-1066', { skip: !haveFinal('mwm4wpiw-99a2cf') }, async () => {
  const layout = await replayAll('mwm4wpiw-99a2cf', 1469);
  assert.equal(layout.previewFrames, 1469, 'label_hidden was measured on every frame');
  const hit = layout.blocking.find((b) => b.code === 'overlap' && b.elements.join() === 'big[1],bars[0]');
  assert.ok(hit, JSON.stringify(layout.blocking));
  assert.equal(hit.first_frame, 1011);
  assert.equal(hit.last_frame, 1066);
  assert.match(layoutRefusal(layout), /overlap big\[1\] \+ bars\[0\]: frames 1011-1066/);
});
// Reported separately (supervisor, taken not asked): the Danube pair PASSES the overlap check; its Black Sea label (labels[9], 40.00-41.05 s) has its
// pin off screen on all 32 frames of its window, which the owner's visibility rule refuses. Neither result is bent to match the other.
test('Danube accepted pair on its all-frame anchors: no text overlap, no safe-zone or caption clash on any of 1518 frames', { skip: !haveFinal('mwm4a61f-438a7a') }, async () => {
  const layout = await replayAll('mwm4a61f-438a7a', 1518);
  assert.equal(layout.framesChecked, 1518);
  assert.deepEqual(layout.blocking.filter((b) => OVERLAP_CODES.includes(b.code)), []);
});
test('Danube accepted pair on its all-frame anchors: labels[9] (Black Sea) is hidden on its whole window and the pair is refused', { skip: !haveFinal('mwm4a61f-438a7a') }, async () => {
  const layout = await replayAll('mwm4a61f-438a7a', 1518);
  const hidden = layout.labelHidden.find((h) => h.element === 'labels[9]');
  assert.deepEqual(hidden, { element: 'labels[9]', share: 1, frames: 32 });
  const why = layoutRefusal(layout);
  assert.match(why, /labels\[9\]/);
  assert.notEqual(why, '');
});
// The sampled preview anchors that the cycle-2 gate saw on this pair: they hold a few frames only, so they could not show this.
test('Danube accepted pair on its sampled preview anchors (the old evidence) shows nothing wrong: sampled hiding is only an advisory', { skip: !have('mwm4a61f-438a7a') }, async () => {
  const layout = await replay('mwm4a61f-438a7a', 1518);
  assert.equal(layout.ok, true, JSON.stringify(layout.blocking));
  assert.deepEqual(layout.blocking, []);
  assert.equal(layoutRefusal(layout), '');
});

// ---- pure helpers
test('layoutRefusal: blocking, label hidden on every previewed frame, malformed; clean is empty', () => {
  const base = { version: 1, ok: true, framesChecked: 900, fps: 30, blocking: [], labelHidden: [], uncovered: [] };
  assert.equal(layoutRefusal(base), '');
  assert.match(layoutRefusal({ ...base, ok: false, blocking: [{ code: 'caption_overlap', elements: ['labels[2]'], first_frame: 30, last_frame: 60 }] }), /caption_overlap labels\[2\]: frames 30-60 \(1\.0-2\.0 s\)/);
  // C2-AUTH-1: only a share measured on every frame of the video refuses; a share on sampled preview frames is an advisory.
  assert.equal(layoutRefusal({ ...base, previewFrames: 12, labelHidden: [{ element: 'labels[3]', share: 1, frames: 2 }] }), '', 'sampled label_hidden never refuses');
  assert.match(layoutRefusal({ ...base, previewFrames: 900, labelHidden: [{ element: 'labels[3]', share: 1, frames: 2 }] }), /label_hidden labels\[3\]: hidden on all 2 frames of its window/);
  assert.equal(layoutRefusal({ ...base, previewFrames: 900, labelHidden: [{ element: 'labels[3]', share: 0.5, frames: 2 }] }), '');
  const pinned = layoutRefusal({ ...base, ok: false, previewFrames: 900, blocking: [{ code: 'label_pin_hidden', elements: ['labels[3]'], first_frame: 1200, last_frame: 1231 }], labelHidden: [{ element: 'labels[3]', share: 1, frames: 32 }] });
  assert.match(pinned, /label_pin_hidden labels\[3\]: frames 1200-1231/);
  assert.doesNotMatch(pinned, /label_hidden labels/, 'the canonical pin block is not repeated');
  assert.equal(layoutRefusal({ ...base, labelHidden: [{ element: 'labels[3]', share: 0.5, frames: 2 }] }), '');
  assert.match(layoutRefusal(null), /missing or malformed/);
  assert.match(layoutRefusal({ version: 1, ok: false, framesChecked: 9, blocking: [], labelHidden: [], uncovered: [] }), /not ok/);
  assert.match(layoutRefusal({ ...base, uncovered: ['big[3]', 'bars[1]'] }), /preview_uncovered big\[3\], bars\[1\]: no preview frame inside their windows/);
  assert.match(layoutRefusal({ version: 1, ok: true, framesChecked: 9, blocking: [], labelHidden: [] }), /missing or malformed/, 'a record with no uncovered list is not trusted');
});
test('layoutBound needs the exact spec hash, frame count and words hash', () => {
  const l = { version: 1, ok: true, framesChecked: 900, fps: 30, blocking: [], labelHidden: [], uncovered: [], inputs: { overlaySha256: 'a', wordsSha256: 'w' } };
  assert.equal(layoutBound(l, { overlaySha256: 'a', wordsSha256: 'w', nframes: 900 }), true);
  assert.equal(layoutBound(l, { overlaySha256: 'b', wordsSha256: 'w', nframes: 900 }), false);
  assert.equal(layoutBound(l, { overlaySha256: 'a', wordsSha256: 'x', nframes: 900 }), false);
  assert.equal(layoutBound(l, { overlaySha256: 'a', wordsSha256: 'w', nframes: 901 }), false);
  assert.equal(layoutBound({ ...l, uncovered: ['big[0]'] }, { overlaySha256: 'a', wordsSha256: 'w', nframes: 900 }), false, 'uncovered windows block receipt reuse');
  assert.equal(layoutBound(undefined, { overlaySha256: 'a', nframes: 900 }), false);
});
test('gate wrapper fails closed: a script error or a malformed report is author_layout_unavailable', async () => {
  const f = path.join(TMP, 'spec.json'); fs.writeFileSync(f, '{"version":1}');
  const run = (out, error = null) => createLayoutGate({ execFileFn: (cmd, args, opts, cb) => { setImmediate(() => cb(error, out)); return { on() {} }; } }).check({ overlaySpec: f, nframes: 900, jobRoot: TMP, frames: [6] });
  await assert.rejects(run('{"status":"error","error":"MediaError: boom"}'), { code: 'author_layout_unavailable' });
  await assert.rejects(run('garbage', Error('exit 1')), { code: 'author_layout_unavailable' });
  await assert.rejects(run('{"status":"ok","version":1,"frames_checked":5,"ok":true,"blocking":[],"label_hidden":[]}'), { code: 'author_layout_unavailable' });
});

// ---- fix 3: authored preview picks
const window = (frames, from, to, fps = 30) => frames.some((f) => f / fps >= from && f / fps < to);
test('authored picks hold a frame inside every big, tag, bars and counter window', () => {
  const spec = { version: 1, tag: { text: 'T', from: 1.1, to: 1.9 }, counter: { value: 'd', format: 'int', from: 2, to: 44 },
    big: [{ text: 'A', from: 5, to: 6.5 }, { text: 'B', from: 33.67, to: 35.55 }, { text: 'C', from: 36.2, to: 36.9 }], bars: [{ value: 'v', min: 0, max: 1, from: 30, to: 35.55 }, { value: 'w', min: 0, max: 1, from: 30, to: 35.55 }], labels: [], measures: [] };
  const input = { nframes: 1469, shotStarts: [0, 10, 20, 30, 40], fps: 30, overlaySpec: spec };
  const { frames, uncovered } = pickAuthoredPreviewFrames(input);
  assert.deepEqual(uncovered, []);
  assert.ok(frames.length <= 24 && frames.every((f) => f % 2 === 0 && f < 1469));
  for (const w of overlayWindows(spec)) assert.ok(window(frames, w.from, w.to), `no frame inside ${w.id}`);
});
test('authored picks recalc per edited spec; classic picks stay byte-equal', () => {
  const base = { nframes: 900, shotStarts: [0, 10, 20], fps: 30 };
  const classic = pickPreviewFrames(base);
  assert.deepEqual(pickAuthoredPreviewFrames({ ...base, overlaySpec: { version: 1 } }).frames, classic, 'no windows: same frames as the classic picker');
  assert.deepEqual(pickAuthoredPreviewFrames({ ...base, overlaySpec: undefined }).frames, classic);
  const moved = (from, to) => ({ version: 1, big: [{ text: 'A', from, to }] });
  const a = pickAuthoredPreviewFrames({ ...base, overlaySpec: moved(11.3, 11.9) }).frames, b = pickAuthoredPreviewFrames({ ...base, overlaySpec: moved(25.3, 25.9) }).frames;
  assert.ok(window(a, 11.3, 11.9) && window(b, 25.3, 25.9));
  assert.notDeepEqual(a, b);
  assert.deepEqual(pickPreviewFrames(base), classic);
});
test('a window that cannot get a frame under the 24 cap is reported, not thrown', () => {
  const big = Array.from({ length: 3 }, (_, i) => ({ text: 'X', from: 1 + i * 0.7, to: 1.6 + i * 0.7 }));
  const { frames, uncovered } = pickAuthoredPreviewFrames({ nframes: 900, shotStarts: Array.from({ length: 11 }, (_, i) => i * 2.5), fps: 30, overlaySpec: { version: 1, big } });
  assert.ok(frames.length <= 24);
  assert.ok(Array.isArray(uncovered));
});

// Cycle 2 C1: the cap is real and every window left without a frame is reported.
const hits = (frames, w, fps = 30) => frames.some((f) => f / fps >= w.from && f / fps < w.to);
test('more than 24 distinct non-overlapping windows: at most 24 frames, every missed window reported', () => {
  const big = Array.from({ length: 40 }, (_, i) => ({ text: 'W' + i, from: i * 0.7, to: i * 0.7 + 0.6 }));
  const input = { nframes: 900, shotStarts: [0, 10, 20], fps: 30, overlaySpec: { version: 1, big } };
  const { frames, uncovered } = pickAuthoredPreviewFrames(input);
  assert.ok(frames.length <= 24, `${frames.length} frames`);
  const wins = overlayWindows(input.overlaySpec);
  assert.deepEqual(uncovered, wins.filter((w) => !hits(frames, w)).map((w) => w.id), 'uncovered is exactly the windows with no frame');
  assert.ok(uncovered.length >= 40 - 24, `${uncovered.length} uncovered`);
});
test('an oversized base selection is cut to 24 and all uncovered windows are reported', () => {
  const base = Array.from({ length: 40 }, (_, i) => i * 20);
  const windows = Array.from({ length: 5 }, (_, i) => ({ id: `big[${i}]`, from: 1 + i * 5.01 + 0.003, to: 1 + i * 5.01 + 0.03 }));
  const { frames, uncovered } = coverWindows({ base, windows, nframes: 900, fps: 30 });
  assert.equal(frames.length, 24);
  assert.deepEqual([...frames].sort((a, b) => a - b), frames);
  assert.deepEqual(uncovered, windows.filter((w) => !hits(frames, w)).map((w) => w.id));
  assert.ok(uncovered.length >= 1, 'a full selection cannot take more windows');
  assert.equal(coverWindows({ base, windows: [], nframes: 900 }).frames.length, 24);
});

// ---- loop integration
const code = '# scene\n# camera\n# light\n# material\n# world\n# setup\n# timeline\n# layers\n# reusable mesh\n# framing\ndef shot_0(t):\n    pass\n';
const twoBig = { version: 1, big: [{ text: 'A', from: 1, to: 3 }, { text: 'B', from: 2, to: 4 }] };
const oneBig = { version: 1, big: [{ text: 'A', from: 1, to: 3 }] };
const lookText = (verdict = 'pass', extra = {}) => JSON.stringify({ look: { sheet_codes: ['ABCDE'], verdict, shots: [{ id: 'shot-0', sees: 'The subject fills the frame.', ok: true }], findings: verdict === 'fix' ? [{ severity: 'P1', issue: 'Text windows overlap.' }] : [], targets: [], edits: [], ...extra.look }, notes: 'Noted.', ...(extra.overlay ? { overlay: extra.overlay } : {}) });
const fixText = (overlay) => lookText('fix', { look: { targets: ['shot_0'], edits: [{ op: 'replace_def', name: 'shot_0', source: 'def shot_0(t):\n    x = 1' }] }, overlay });
// A layout stub that applies the real rule to a fake spec: two big windows that share time are a blocking overlap.
const stubLayout = async ({ overlaySpec, words, anchors, nframes, frames }) => {
  const spec = JSON.parse(fs.readFileSync(overlaySpec, 'utf8')), big = spec.big ?? [];
  const blocking = big.length === 2 ? [{ code: 'overlap', elements: ['big[0]', 'big[1]'], first_frame: 60, last_frame: 90, frames: 31 }] : [];
  return { version: 1, ok: !blocking.length, framesChecked: nframes, fps: 30, previewFrames: frames === 'all' ? nframes : 1, anchoredFrames: 0, blocking, labelHidden: [], inputs: { overlaySha256: hash(fs.readFileSync(overlaySpec)), anchorsSha256: anchors ? hash(fs.readFileSync(anchors)) : null, wordsSha256: words ? hash(fs.readFileSync(words)) : null } };
};
function rig({ writeSpec = oneBig, reply = () => lookText(), renderSeconds = null, flag = undefined, layoutCheck = stubLayout, renderBudget = 1.5 } = {}) {
  const stage = fs.mkdtempSync(path.join(TMP, 'loop-')); let calls = 0;
  const input = { jobId: 'test', stageDir: stage, measurementMode: true, probe: { passed: true }, writePrompt: 'Write code', brief: 'brief', script: 'script', kitContract: 'kit', shots: [{ subject: 'subject', narration: 'words' }], shotStarts: [0], nframes: 900, renderBudget, validate: () => [] };
  const deps = { layoutCheck, newCode: () => 'ABCDE',
    runPreview: async () => { const dir = path.join(stage, 'frames'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(stage, 'work'), { recursive: true });
      // C2-AUTH-1: the preview job poses every frame; this stub marks nothing, so the export record says "no anchors file".
      fs.writeFileSync(path.join(stage, 'work', 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: 900, max_frame: 899, anchors: false, pose_s: 0.1 }));
      if (renderSeconds !== null) { fs.writeFileSync(path.join(stage, 'work', 'render-timing.json'), JSON.stringify({ render_s: renderSeconds, rendered: 10 })); } return { dir, frames: [{ name: '1.png', sha256: 'f' }] }; },
    makeSheets: async ({ outDir }) => { fs.mkdirSync(outDir, { recursive: true }); const p = path.join(outDir, 'sheet.jpg'); fs.writeFileSync(p, 'pixels'); return [{ path: p, code: 'ABCDE', sha256: hash('pixels'), tiles: [{ n: 1, frame: 1, ...(flag ? { flag } : {}) }] }]; },
    askAuthor: async (prompt, images) => { calls++; return { text: calls === 1 ? '```python\n' + code + '```\n```json\n' + JSON.stringify(writeSpec) + '\n```' : reply(calls), rawUsage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, receipt: { argvSha256: hash(JSON.stringify(authorArgv())), promptSha256: hash(prompt), imageSha256: images.map((i) => hash(i.bytes)), imageCount: images.length, noSessionPersistence: true, toolsOffered: 0, transport: 'stdin-image-blocks' } }; } };
  return { input, deps, stage, calls: () => calls };
}
const prompt = (stage, round, n) => fs.readFileSync(path.join(stage, 'author', 'a0', `r${round}`, `prompt-${n}.txt`), 'utf8');

test('a pass over a blocking all-frame layout is refused with the elements and frame range; the repaired spec is accepted with its layout in the receipt', async () => {
  const r = rig({ writeSpec: twoBig, reply: (n) => (n === 2 ? lookText() : n === 3 ? fixText(oneBig) : lookText()) });
  const out = await runAuthorLoop(r.input, r.deps);
  assert.equal(out.accepted, true);
  assert.equal(out.overlaySpec.big.length, 1);
  assert.equal(r.calls(), 4, 'write, refused pass, repair, pass');
  const refusedPrompt = prompt(r.stage, 0, 2);
  assert.match(refusedPrompt, /HOST LAYOUT CHECK, measured on all 900 frames/);
  assert.match(refusedPrompt, /overlap big\[0\] \+ big\[1\]: frames 60-90/);
  assert.match(refusedPrompt, /overlap big\[0\] \+ big\[1\]: frames 60-90 \(2\.0-3\.0 s\)/, 'the same blocking text is already in the first look prompt');
  const look = JSON.parse(fs.readFileSync(path.join(r.stage, 'author/a0/r1/look.json'), 'utf8'));
  assert.equal(look.layout.ok, true);
  const receipt = JSON.parse(fs.readFileSync(path.join(r.stage, 'author/receipt.json'), 'utf8'));
  assert.equal(receipt.layoutSha256, hash(JSON.stringify(look.layout)));
  assert.equal(receipt.round, 1);
  assert.equal(verifyAuthorReceipt(out, r.input), true);
});
test('a pass that never gets its layout repaired ends author_reply and writes no accepted pair', async () => {
  const r = rig({ writeSpec: twoBig, reply: () => lookText() });
  await assert.rejects(runAuthorLoop(r.input, r.deps), { code: 'author_reply' });
  assert.ok(!fs.existsSync(path.join(r.stage, 'author/accepted.build.py')));
});
test('a label hidden on every frame of its window blocks the pass', async () => {
  const hidden = async (a) => ({ ...(await stubLayout(a)), labelHidden: [{ element: 'labels[0]', share: 1, frames: 30 }] });
  const r = rig({ layoutCheck: hidden, writeSpec: { version: 1, big: [{ text: 'A', from: 1, to: 3 }], labels: [{ anchor: 'pin', title: 'X', from: 1, to: 2 }] } });
  await assert.rejects(runAuthorLoop(r.input, r.deps), { code: 'author_reply' });
  assert.match(prompt(r.stage, 0, 2), /label_hidden labels\[0\]/);
});
test('without a layout check the loop fails closed before any call; a failing check stops the job', async () => {
  const r = rig({ layoutCheck: undefined }); delete r.deps.layoutCheck;
  await assert.rejects(runAuthorLoop(r.input, r.deps), { code: 'author_layout_unavailable' });
  assert.equal(r.calls(), 0);
  const failing = rig({ layoutCheck: async () => { throw Object.assign(Error('author_layout_unavailable'), { code: 'author_layout_unavailable' }); } });
  await assert.rejects(runAuthorLoop(failing.input, failing.deps), { code: 'author_layout_unavailable' });
  assert.ok(!fs.existsSync(path.join(failing.stage, 'author/accepted.build.py')));
});
test('an accepted receipt from before this gate (no layout record) cannot be reused or verified', async () => {
  const r = rig(), out = await runAuthorLoop(r.input, r.deps);
  assert.equal(verifyAuthorReceipt(out, r.input), true);
  const lookFile = path.join(r.stage, 'author/a0/r0/look.json'), receiptFile = path.join(r.stage, 'author/receipt.json');
  const look = JSON.parse(fs.readFileSync(lookFile, 'utf8')); delete look.layout; fs.writeFileSync(lookFile, JSON.stringify(look));
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); delete receipt.layoutSha256; fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.throws(() => verifyAuthorReceipt({ ...out, receipt }, r.input), { code: 'author_hash' });
  let started = false;
  await assert.rejects(runAuthorLoop(r.input, { ...r.deps, askAuthor: async () => { started = true; throw Object.assign(Error(), { code: 'stopped' }); } }), { code: 'stopped' });
  assert.equal(started, true, 'the old receipt did not bypass the gate: a new write turn started');
});
test('a layout record that was rewritten to say ok, or that names another spec, is refused', async () => {
  for (const tamper of ['spec', 'frames', 'blocking']) {
    const r = rig(), out = await runAuthorLoop(r.input, r.deps), lookFile = path.join(r.stage, 'author/a0/r0/look.json'), receiptFile = path.join(r.stage, 'author/receipt.json');
    const look = JSON.parse(fs.readFileSync(lookFile, 'utf8'));
    if (tamper === 'spec') look.layout.inputs.overlaySha256 = 'x'; else if (tamper === 'frames') look.layout.framesChecked = 1; else { look.layout.ok = false; look.layout.blocking = [{ code: 'overlap', elements: ['big[0]', 'big[1]'], first_frame: 1, last_frame: 2, frames: 2 }]; }
    fs.writeFileSync(lookFile, JSON.stringify(look));
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); receipt.layoutSha256 = hash(JSON.stringify(look.layout)); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    assert.throws(() => verifyAuthorReceipt({ ...out, receipt }, r.input), { code: 'author_hash' }, tamper);
  }
});
// The real validator allows at most 3 big, 2 bars, 1 tag and 1 counter, so >24 windows reach the picker only through the injected picker (deps.pickFrames).
const manyWindows = Array.from({ length: 30 }, (_, i) => ({ id: `big[${i}]`, from: i * 0.9, to: i * 0.9 + 0.6 }));
test('adversarial: more than 24 distinct non-overlapping windows and a model pass is refused, naming uncovered windows; no accepted pair', async () => {
  const r = rig({ reply: () => lookText() });
  const sizes = [];
  r.deps.pickFrames = ({ nframes }) => { const out = coverWindows({ base: [0, 30, 60], windows: manyWindows, nframes, fps: 30 }); sizes.push(out); return out; };
  await assert.rejects(runAuthorLoop(r.input, r.deps), { code: 'author_reply' });
  assert.ok(!fs.existsSync(path.join(r.stage, 'author/accepted.build.py')));
  assert.ok(sizes[0].frames.length <= 24);
  assert.ok(sizes[0].uncovered.length >= 6, 'at least 30 windows minus 24 frames');
  const p = prompt(r.stage, 0, 2);
  assert.match(p, /HOST LAYOUT CHECK/);
  assert.match(p, /preview_uncovered big\[/);
  assert.ok(p.includes(sizes[0].uncovered[sizes[0].uncovered.length - 1]), 'every uncovered window is named, also the last');
});
test('with 12 shots the base already takes 24 frames: narrow real windows that hold no even frame block the pass and are all named', async () => {
  const r = rig({ writeSpec: { version: 1, tag: { text: 'T', from: 1.02, to: 1.05 }, big: [{ text: 'A', from: 4.02, to: 4.05 }, { text: 'B', from: 8.02, to: 8.05 }], bars: [{ label: 'x', value: 'v', min: 0, max: 1, from: 12.02, to: 12.05 }] }, reply: () => lookText() });
  r.input.shots = Array.from({ length: 12 }, () => ({ subject: 'subject', narration: 'words' }));
  r.input.shotStarts = Array.from({ length: 12 }, (_, i) => i * 2.5);
  const out = await runAuthorLoop(r.input, r.deps).catch((e) => e);
  assert.equal(out.code, 'author_reply', out.message);
  const p = prompt(r.stage, 0, 2);
  assert.match(p, /preview_uncovered tag, big\[0\], big\[1\]/);
  const pv = JSON.parse(fs.readFileSync(path.join(r.stage, 'author/a0/r0/preview.json'), 'utf8'));
  assert.ok(pv.frames.length <= 24);
});
test('a receipt that carries uncovered windows is refused, also when look.json is rewritten to hide them', async () => {
  for (const tamper of ['listed', 'hidden']) {
    const r = rig(), out = await runAuthorLoop(r.input, r.deps), lookFile = path.join(r.stage, 'author/a0/r0/look.json'), receiptFile = path.join(r.stage, 'author/receipt.json'), pvFile = path.join(r.stage, 'author/a0/r0/preview.json');
    assert.equal(verifyAuthorReceipt(out, r.input), true);
    const look = JSON.parse(fs.readFileSync(lookFile, 'utf8'));
    if (tamper === 'listed') look.layout.uncovered = ['big[0]'];
    else { const pv = JSON.parse(fs.readFileSync(pvFile, 'utf8')); pv.frames = pv.frames.filter((f) => !(f / 30 >= 1 && f / 30 < 3)); fs.writeFileSync(pvFile, JSON.stringify(pv)); }
    fs.writeFileSync(lookFile, JSON.stringify(look));
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); receipt.layoutSha256 = hash(JSON.stringify(look.layout)); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    assert.throws(() => verifyAuthorReceipt({ ...out, receipt }, r.input), { code: 'author_hash' }, tamper);
  }
});
test('classic prompt text is unchanged when the layout is clean and no budget finding applies', async () => {
  const r = rig({ renderSeconds: 20 }); // 8 s/frame: over budget, render_too_slow only
  await runAuthorLoop(r.input, r.deps);
  const p = prompt(r.stage, 0, 1);
  assert.match(p, /render_too_slow: 8 s\/frame\n/);
  assert.doesNotMatch(p, /budget_unused|HOST LAYOUT CHECK/);
});

// ---- fix 5: the budget is told in both directions
test('budget_unused: under half the budget with measured plain tiles names the hero surface; the ceiling is not touched', async () => {
  const r = rig({ renderSeconds: 1, flag: 'plain' }); // 1 s / 10 frames * 4 = 0.4 s/frame < 0.75
  await runAuthorLoop(r.input, r.deps);
  const p = prompt(r.stage, 0, 1);
  assert.match(p, /budget_unused: 0\.40 s\/frame is under half of the 1\.5 s\/frame budget while T1 \(plain\) measure as flat or plain/);
  assert.match(p, /enrich the single largest hero surface/);
  assert.match(p, /The ceiling is unchanged/);
  assert.doesNotMatch(p, /render_too_slow/);
  assert.ok(fs.readFileSync(path.join(r.stage, 'author/a0/journal.jsonl'), 'utf8').includes('"kind":"budget_unused"'));
});
test('no budget_unused without flat tiles, at half the budget or above, or with no timing', async () => {
  for (const [renderSeconds, flag] of [[1, undefined], [2.5, 'plain'], [null, 'plain']]) {
    const r = rig({ renderSeconds, flag });
    await runAuthorLoop(r.input, r.deps);
    assert.doesNotMatch(prompt(r.stage, 0, 1), /budget_unused/, `${renderSeconds} ${flag}`);
  }
});
test('real Hypersaline spec: the saved 22 preview frames miss the big[1] window, the authored picks cover every window', { skip: !have('mwm4wpiw-99a2cf') }, () => {
  const dir = evidence('mwm4wpiw-99a2cf'), spec = JSON.parse(fs.readFileSync(path.join(dir, 'accepted.overlay.json'), 'utf8')).spec;
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'a0/r4/preview.json'), 'utf8')).frames, shotStarts = JSON.parse(fs.readFileSync(path.join(dir, 'direction.json'), 'utf8')).directed.shotStarts;
  const windows = overlayWindows(spec), big1 = windows.find((w) => w.id === 'big[1]');
  assert.ok(big1 && !window(saved, big1.from, big1.to), 'the saved picks had no frame inside big[1]');
  const { frames, uncovered } = pickAuthoredPreviewFrames({ nframes: 1469, shotStarts, fps: 30, overlaySpec: spec });
  assert.deepEqual(uncovered, []);
  for (const w of windows) assert.ok(window(frames, w.from, w.to), `no frame inside ${w.id}`);
});
