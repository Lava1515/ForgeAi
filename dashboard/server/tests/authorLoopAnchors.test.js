// claude-pro · claude-sonnet-5-5 · 2026-11-18 (C2-AUTH-1): labels and measures are laid out on EVERY frame from exported anchor positions.
// CPU only, no render, no model. The collision fixture is synthetic: its measure box hits a big text only between two preview frames.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { runAuthorLoop, verifyAuthorReceipt } from '../episode/codebuilt/authorLoop.js';
import { hash, authorArgv } from '../episode/codebuilt/authorCall.js';
import { createLayoutGate, layoutRefusal } from '../episode/codebuilt/layoutGate.js';

const TMP = 'C:/code/ForgeAi/output/agent-jobs/evening-C2AUTH1/tests-tmp';
fs.mkdirSync(TMP, { recursive: true });
const NFRAMES = 90;
const PREVIEW = [0, 40, 48, 88];
// A big text sits at the top for the whole clip; a measure between two points normally hangs low (y 0.7) and only on frames 41-47 swings up (y 0.3) into it.
const SPEC = { version: 1, big: [{ text: 'BIG', from: 0, to: 3 }], measures: [{ a: 'p', b: 'q', text: '12 km', from: 0, to: 3 }] };
const frameRow = (y) => ({ p: { p: [0.3, y, 1], q: [0.7, y, 1] }, v: {} });
const anchorsFile = (frames) => ({ version: 1, width: 1080, height: 1920, frames: Object.fromEntries(frames.map((f) => [String(f), frameRow(f >= 41 && f <= 47 ? 0.3 : 0.7)])) });
const all = Array.from({ length: NFRAMES }, (_, i) => i);

function work(anchorFrames) {
  const dir = fs.mkdtempSync(path.join(TMP, 'gate-'));
  fs.writeFileSync(path.join(dir, 'overlay-spec.json'), JSON.stringify(SPEC));
  fs.writeFileSync(path.join(dir, 'anchors.json'), JSON.stringify(anchorsFile(anchorFrames)));
  return { dir, overlaySpec: path.join(dir, 'overlay-spec.json'), anchors: path.join(dir, 'anchors.json') };
}
const gate = createLayoutGate({ execFileFn: execFile });

test('a collision that exists only between two preview frames: sampled anchors miss it, the exported all-frame anchors refuse it', async () => {
  const sampled = work(PREVIEW), full = work(all);
  const before = await gate.check({ overlaySpec: sampled.overlaySpec, anchors: sampled.anchors, nframes: NFRAMES, jobRoot: sampled.dir, frames: PREVIEW });
  assert.equal(before.ok, true, JSON.stringify(before.blocking));
  assert.equal(layoutRefusal({ ...before, uncovered: [] }), '', 'the sampled evidence (the old gate) accepts this video');
  const after = await gate.check({ overlaySpec: full.overlaySpec, anchors: full.anchors, nframes: NFRAMES, jobRoot: full.dir, frames: 'all' });
  assert.equal(after.ok, false);
  assert.equal(after.previewFrames, NFRAMES);
  const hit = after.blocking.find((b) => b.code === 'overlap');
  assert.deepEqual([hit.elements.join(), hit.first_frame, hit.last_frame], ['big[0],measures[0]', 41, 47]);
  assert.match(layoutRefusal({ ...after, uncovered: [] }), /overlap big\[0\] \+ measures\[0\]: frames 41-47/);
});
test('the gate forwards the canonical findings and refuses a bad frames argument', async () => {
  const full = work(all);
  const out = await gate.check({ overlaySpec: full.overlaySpec, anchors: full.anchors, nframes: NFRAMES, jobRoot: full.dir, frames: 'all' });
  assert.ok(Array.isArray(out.findings));
  await assert.rejects(gate.check({ overlaySpec: full.overlaySpec, nframes: NFRAMES, jobRoot: full.dir, frames: 'most' }), { code: 'author_layout_unavailable' });
});

// ---- the loop
const code = '# scene\n# camera\n# light\n# material\n# world\n# setup\n# timeline\n# layers\n# reusable mesh\n# framing\ndef shot_0(t):\n    pass\n';
const labelSpec = { version: 1, big: [{ text: 'A', from: 1, to: 3 }], labels: [{ anchor: 'pin', title: 'Pin', from: 1, to: 3 }] };
const lookText = () => JSON.stringify({ look: { sheet_codes: ['ABCDE'], verdict: 'pass', shots: [{ id: 'shot-0', sees: 'The subject fills the frame.', ok: true }], findings: [], targets: [], edits: [] }, notes: 'Noted.' });
function rig({ spec = labelSpec, pose = 'full', nframes = 900 } = {}) {
  const stage = fs.mkdtempSync(path.join(TMP, 'loop-')); let calls = 0; const seen = [];
  const input = { jobId: 'test', stageDir: stage, measurementMode: true, probe: { passed: true }, writePrompt: 'Write code', brief: 'brief', script: 'script', kitContract: 'kit', shots: [{ subject: 'subject', narration: 'words' }], shotStarts: [0], nframes, renderBudget: 1.5, validate: () => [] };
  const allBytes = JSON.stringify({ version: 1, width: 1080, height: 1920, frames: { 0: { p: { pin: [0.5, 0.5, 1] }, v: {} } } });
  const deps = {
    newCode: () => 'ABCDE',
    layoutCheck: async (args) => { seen.push(args); return { version: 1, ok: true, framesChecked: args.nframes, fps: 30, previewFrames: args.frames === 'all' ? args.nframes : 1, anchoredFrames: 0, blocking: [], labelHidden: [], findings: [], inputs: { overlaySha256: hash(fs.readFileSync(args.overlaySpec)), anchorsSha256: args.anchors ? hash(fs.readFileSync(args.anchors)) : null, wordsSha256: null } }; },
    runPreview: async () => {
      const dir = path.join(stage, 'frames'), work = path.join(stage, 'work'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, 'anchors-preview.json'), '{"version":1,"width":1080,"height":1920,"frames":{}}');
      if (pose === 'full') { fs.writeFileSync(path.join(work, 'anchors-all.json'), allBytes); fs.writeFileSync(path.join(work, 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: nframes, max_frame: nframes - 1, anchors: true, pose_s: 1 })); }
      if (pose === 'partial') { fs.writeFileSync(path.join(work, 'anchors-all.json'), allBytes); fs.writeFileSync(path.join(work, 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: nframes - 2, max_frame: nframes - 3, anchors: true })); }
      if (pose === 'file-missing') fs.writeFileSync(path.join(work, 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: nframes, max_frame: nframes - 1, anchors: true }));
      if (pose === 'none-marked') fs.writeFileSync(path.join(work, 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: nframes, max_frame: nframes - 1, anchors: false }));
      return { dir, frames: [{ name: '1.png', sha256: 'f' }] };
    },
    makeSheets: async ({ outDir }) => { fs.mkdirSync(outDir, { recursive: true }); const p = path.join(outDir, 'sheet.jpg'); fs.writeFileSync(p, 'pixels'); return [{ path: p, code: 'ABCDE', sha256: hash('pixels'), tiles: [{ n: 1, frame: 1 }] }]; },
    askAuthor: async (prompt, images) => { calls++; return { text: calls === 1 ? '```python\n' + code + '```\n```json\n' + JSON.stringify(spec) + '\n```' : lookText(), rawUsage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, receipt: { argvSha256: hash(JSON.stringify(authorArgv())), promptSha256: hash(prompt), imageSha256: images.map((i) => hash(i.bytes)), imageCount: images.length, noSessionPersistence: true, toolsOffered: 0, transport: 'stdin-image-blocks' } }; },
  };
  return { input, deps, stage, seen, allBytes, calls: () => calls };
}
const round = (r) => path.join(r.stage, 'author', 'a0', 'r0');

test('a spec with labels is laid out on every frame from the exported anchors, and the receipt binds that file', async () => {
  const r = rig(), out = await runAuthorLoop(r.input, r.deps);
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].frames, 'all');
  assert.equal(r.seen[0].anchors, path.join(round(r), 'anchors-all.json'));
  assert.equal(fs.readFileSync(r.seen[0].anchors, 'utf8'), r.allBytes);
  const look = JSON.parse(fs.readFileSync(path.join(round(r), 'look.json'), 'utf8'));
  assert.equal(look.layout.inputs.anchorsSha256, hash(r.allBytes));
  assert.equal(look.layout.previewFrames, 900);
  assert.equal(verifyAuthorReceipt(out, r.input), true);
});
test('no marks in the whole video: the record says so, the layout runs without an anchors file and the pair is still bound', async () => {
  const r = rig({ pose: 'none-marked' }), out = await runAuthorLoop(r.input, r.deps);
  assert.equal(r.seen[0].anchors, undefined);
  assert.equal(r.seen[0].frames, 'all');
  assert.equal(verifyAuthorReceipt(out, r.input), true);
});
for (const pose of ['absent', 'partial', 'file-missing']) {
  test(`export ${pose}: the loop fails closed with author_layout_unavailable before any pass can be accepted`, async () => {
    const r = rig({ pose });
    await assert.rejects(runAuthorLoop(r.input, r.deps), (e) => e.code === 'author_layout_unavailable' && e.detail?.reason === 'anchor_export_missing');
    assert.equal(r.seen.length, 0);
    assert.ok(!fs.existsSync(path.join(r.stage, 'author', 'accepted.build.py')));
  });
}
test('a spec with only fixed text needs no export and keeps the sampled path', async () => {
  const r = rig({ spec: { version: 1, big: [{ text: 'A', from: 1, to: 3 }] }, pose: 'absent' }), out = await runAuthorLoop(r.input, r.deps);
  assert.deepEqual(r.seen[0].frames, [1]);
  assert.equal(verifyAuthorReceipt(out, r.input), true);
});
for (const tamper of ['anchors bytes', 'record removed', 'record frames', 'layout from samples']) {
  test(`receipt is refused after tampering: ${tamper}`, async () => {
    const r = rig(), out = await runAuthorLoop(r.input, r.deps), dir = round(r);
    assert.equal(verifyAuthorReceipt(out, r.input), true);
    if (tamper === 'anchors bytes') fs.writeFileSync(path.join(dir, 'anchors-all.json'), r.allBytes.replace('0.5', '0.6'));
    if (tamper === 'record removed') fs.unlinkSync(path.join(dir, 'anchors-all.done.json'));
    if (tamper === 'record frames') fs.writeFileSync(path.join(dir, 'anchors-all.done.json'), JSON.stringify({ version: 1, frames: 10, max_frame: 9, anchors: true }));
    if (tamper === 'layout from samples') {
      const file = path.join(dir, 'look.json'), look = JSON.parse(fs.readFileSync(file, 'utf8')); look.layout.previewFrames = 12; fs.writeFileSync(file, JSON.stringify(look));
      const rf = path.join(r.stage, 'author', 'receipt.json'), receipt = JSON.parse(fs.readFileSync(rf, 'utf8')); receipt.layoutSha256 = hash(JSON.stringify(look.layout)); fs.writeFileSync(rf, JSON.stringify(receipt));
      assert.throws(() => verifyAuthorReceipt({ ...out, receipt }, r.input), { code: 'author_hash' });
      return;
    }
    assert.throws(() => verifyAuthorReceipt(out, r.input), { code: 'author_hash' });
  });
}
