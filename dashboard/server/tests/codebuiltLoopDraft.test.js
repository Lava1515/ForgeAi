// codex · gpt-6.1-sol · 2026-11-14: regression for loop drafts and narrated input integrity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { codebuiltToDraft, verifyCodebuiltDraft } from '../episode/codebuilt/draftAdapter.js';
import { verifyInputs } from '../episode/engines/codebuilt/jobFolder.js';
const scratch = path.resolve('../../output/temp/loop-d2');
fs.mkdirSync(scratch, { recursive: true });
test('loop draft uses host type, silent assets and premise, and refuses missing loop receipts', () => {
  const root = fs.mkdtempSync(path.join(scratch, 'draft-'));
  const jobsDir = path.join(root, 'jobs'); const job = path.join(jobsDir, 'loop-job');
  const put = (name, data) => { const file = path.join(job, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  put('build/build.py', '# fixture'); put('out/video.mp4', Buffer.from('0000ftyp0000'));
  put('out/audio/loop.wav', Buffer.from('RIFF0000WAVE'));
  put('out/contact_sheet.png', Buffer.from([137,80,78,71,13,10,26,10]));
  const report = { version: 'codebuilt-cb5-v1', status: 'ok', video_type: 'loop', post: { ok: true, probe: { duration: 8 } }, seam: { passed: true }, length_check: { within_tolerance: true }, audio: { passed: true, encoded_seam: { passed: true } } };
  put('out/report.json', JSON.stringify(report));
  const opts = { jobId: 'loop-job', videoType: 'loop', topic: 'Orbit', premise: { title: 'A marble circles a rotating brass wheel', answer: 'The marble completes a continuous orbit.' }, channelId: 'test', getChannel: () => ({ id: 'test', genre: 'general', made_for_kids: false }), jobsDir, draftsDir: path.join(root, 'drafts') };
  assert.throws(() => codebuiltToDraft({ ...opts, videoType: undefined }), { code: 'bad_artifact' }); // a job report cannot choose its own format
  const result = codebuiltToDraft(opts);
  assert.equal(result.metadata.video_type, 'loop'); assert.equal(result.metadata.script, '');
  assert.equal(result.metadata.listing_copy.title, opts.premise.title);
  assert.equal(result.metadata.listing_copy.description, opts.premise.answer);
  assert.equal(result.metadata.codebuilt.files.subtitles, undefined);
  assert.equal(verifyCodebuiltDraft({ folder: path.join(opts.draftsDir, result.draftId), meta: result.metadata }).ok, true);
  for (const key of ['video_type', 'seam', 'length_check', 'audio']) {
    const bad = { ...report }; delete bad[key]; put('out/report.json', JSON.stringify(bad));
    assert.throws(() => codebuiltToDraft({ ...opts, draftsDir: path.join(root, 'bad-' + key) }), { code: 'bad_producer_report' });
  }
  put('out/report.json', JSON.stringify({ ...report, audio: { passed: true, encoded_seam: { passed: false } } }));
  assert.throws(() => codebuiltToDraft({ ...opts, draftsDir: path.join(root, 'bad-encoded') }), { code: 'bad_producer_report' });
});
test('narrated missing voice hash fails closed; only a loop path pack permits the reduced input set', () => {
  const inputs = fs.mkdtempSync(path.join(scratch, 'inputs-'));
  const hashes = {};
  for (const [name, data] of Object.entries({ 'pathpack.json': '{}', 'brief.md': 'brief', 'script.txt': 'script', 'vo.wav': 'voice', 'words.json': '{}' })) {
    fs.writeFileSync(path.join(inputs, name), data); hashes[name] = crypto.createHash('sha256').update(data).digest('hex');
  }
  verifyInputs({ inputs }, hashes); delete hashes['vo.wav'];
  assert.throws(() => verifyInputs({ inputs }, hashes), { code: 'INPUT_CHANGED' });
  const pack = JSON.stringify({ videoType: 'loop' }); fs.writeFileSync(path.join(inputs, 'pathpack.json'), pack);
  hashes['pathpack.json'] = crypto.createHash('sha256').update(pack).digest('hex');
  verifyInputs({ inputs }, { 'pathpack.json': hashes['pathpack.json'], 'brief.md': hashes['brief.md'] });
});
