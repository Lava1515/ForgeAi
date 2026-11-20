// The whole hand-over with both real halves: the dashboard's Send writes a package, the uploader's intake accepts it,
// the uploader's signed answer is read back into the draft. Also: a second Send and a direct Publish are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRATCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../output/temp/uploader-tests');
fs.mkdirSync(SCRATCH, { recursive: true });
const root = fs.mkdtempSync(path.join(SCRATCH, 'h-'));
const YT = 'UC' + 'a'.repeat(22);
process.env.FORGEAI_DRAFTS_DIR = path.join(root, 'drafts');
process.env.UPLOADER_SHARE = path.join(root, 'share');
process.env.UPLOADER_KEY = 'k'.repeat(40);
process.env.CHANNELS_FILE = path.join(root, 'channels.json');
process.env.ACTIVE_CHANNEL_FILE = path.join(root, 'active.json');
fs.writeFileSync(process.env.CHANNELS_FILE, JSON.stringify([{ id: 'ch_atlas', name: 'Forge Atlas', genre: 'general', youtube_channel_id: YT, profile: { niche: 'maps', language: 'en', avoid: [] } }]));
const draftDir = path.join(root, 'drafts', 'cb-test1');
fs.mkdirSync(draftDir, { recursive: true });
fs.writeFileSync(path.join(draftDir, 'video.mp4'), 'the video bytes');
const metaFile = path.join(draftDir, 'metadata.json');
fs.writeFileSync(metaFile, JSON.stringify({ channel_id: 'ch_atlas', video_file: 'video.mp4', script: 'A town has twenty borders.', made_for_kids: false, ai_disclosure: true, listing_copy: { title: 'Why This Town Has Twenty Borders', tags: ['baarle'] } }));

const { uploaderSendHandler, uploaderStatusHandler } = await import('../routes/uploader.js');
const { youtubePublishHandler } = await import('../routes/youtube.js');
const share = await import('../../../uploader/server/share.js');

const call = (handler, body = {}) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(data) { resolve({ code: this.code, data }); } };
  handler({ params: { draftId: 'cb-test1' }, body, headers: {}, query: {} }, res);
});
const meta = () => JSON.parse(fs.readFileSync(metaFile, 'utf8'));

test('send, intake and the answer back work together; a second way out is refused', async () => {
  const sent = await call(uploaderSendHandler, { title: 'Why This Town Has Twenty Borders' });
  assert.equal(sent.code, 200, JSON.stringify(sent.data));
  assert.equal(meta().uploader.state, 'sent');
  assert.equal((await call(uploaderSendHandler)).code, 409);
  assert.equal((await call(youtubePublishHandler, { privacy: 'private' })).code, 409);

  const dirs = share.ensureShare(process.env.UPLOADER_SHARE);
  const packages = {};
  await share.intake(dirs, { packages, key: process.env.UPLOADER_KEY, owner: 'me', localDir: path.join(root, 'local') });
  assert.equal(packages['cb-test1'].state, 'queued', JSON.stringify(packages));
  assert.equal(packages['cb-test1'].youtube_channel_id, YT);
  assert.equal(fs.readFileSync(path.join(root, 'local', 'cb-test1', 'video.mp4'), 'utf8'), 'the video bytes');
  assert.deepEqual(fs.readdirSync(dirs.inbox), []);

  assert.equal(packages['cb-test1'].result_due, true);
  share.writeResult(dirs, process.env.UPLOADER_KEY, packages['cb-test1']); // the uploader's loop writes the owed answer
  assert.equal((await call(uploaderStatusHandler)).data.sent.state, 'queued');
  share.writeResult(dirs, process.env.UPLOADER_KEY, { ...packages['cb-test1'], state: 'scheduled', video_id: 'abcDEF12345', publish_at: '2026-11-21T13:00:00.000Z' });
  const status = await call(uploaderStatusHandler);
  assert.equal(status.data.youtube.video_id, 'abcDEF12345');
  assert.equal(meta().youtube.publish_mode, 'uploader');

  // A forged answer (no key) changes nothing.
  fs.writeFileSync(path.join(dirs.results, 'cb-test1.json'), JSON.stringify({ package_id: 'cb-test1', state: 'removed', mac: '0'.repeat(64) }));
  await call(uploaderStatusHandler);
  assert.equal(meta().uploader.state, 'scheduled');
});
